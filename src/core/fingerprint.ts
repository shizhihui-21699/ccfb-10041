/**
 * Segment fingerprinting and matching.
 *
 * Three complementary signals are computed for every protected paragraph:
 *   1. exact k-gram fingerprints (order-sensitive)   -> verbatim runs
 *   2. bag-of-k fingerprints (order-insensitive)     -> local reordering
 *   3. IDF-weighted overlap + trigram containment    -> paraphrase / rewrite
 *
 * All scores are 0..100 and every contribution is explainable in the UI.
 */
import type {
  DetectionConfig,
  ProtectedDocument,
  SegmentMatch,
  DocumentText,
  AlertEvidenceSpan,
} from './types';
import { bagFingerprintOf, fingerprintOf } from './hash';
import { buildCanonicalStream, charBigrams, mergeSpans } from './normalize';

interface Hit {
  docId: string;
  seg: number;
  /** protected token window, absolute offsets in the protected document */
  ts: number;
  te: number;
}

interface Trigram {
  h: number;
  /** summed IDF of the three tokens */
  w: number;
}

export interface SegmentInfo {
  docId: string;
  seg: number;
  location: string;
  /** absolute token offsets in the protected doc */
  tokenStart: number;
  tokenEnd: number;
  tokenCount: number;
  ids: Uint32Array;
  counts: Map<number, number>;
  /** sum of IDF over all tokens (multiset) */
  weight: number;
  trigrams: Trigram[];
  trigramWeight: number;
  /** canonical characters of the segment (punctuation-free, lowercased) */
  canonical: string;
  /** distinct char bigrams (canonical stream) with counts */
  bigrams: Map<number, number>;
  bigramTotal: number;
  bigramWeight: number;
  /** distinct unigrams with counts, for paraphrase term overlap */
  unigrams: Map<number, number>;
  unigramWeight: number;
  /** table rows only: multiset of cell hashes (order-insensitive) */
  cells: Map<number, number> | null;
  /** distinctive numeric literals, e.g. 4.8 / 13800138001 / 92.4 */
  numbers: Set<string>;
  trigramMaxIdf: number;
  charLength: number;
  rawStart: number;
  rawEnd: number;
}

export interface PreparedLibrary {
  docs: ProtectedDocument[];
  seqIndex: Map<string, Hit[]>;
  bagIndex: Map<string, Hit[]>;
  /** `${docId}:${seg}` -> info */
  segments: Map<string, SegmentInfo>;
  /** tokenId -> segment keys containing it */
  postings: Map<number, string[]>;
  idf: Map<number, number>;
  maxIdf: number;
  segmentCount: number;
  builtAt: number;
  fingerprintCount: number;
  bagFingerprintCount: number;
  /** corpus char-bigram document frequency, for weighting rare phrase matches */
  bigramDf: Map<number, number>;
  bigramMaxIdf: number;
  /** per-segment char-bigram document frequency, for paraphrase evidence */
  unigramDf: Map<number, number>;
  /** numeric literal document frequency (for distinctive-number scoring) */
  numberDf: Map<string, number>;
}

export function segmentKey(docId: string, seg: number): string {
  return `${docId}:${seg}`;
}

const NUMERIC = /^\d+(?:\.\d+)?$|^\d{4,}$/;

/** Distinctive numeric literals in a block: years, prices, IDs, rates. */
export function extractNumbers(ids: Uint32Array, tokenTexts: string[]): Set<string> {
  const out = new Set<string>();
  for (const t of tokenTexts) {
    const clean = t.replace(/[,\s]/g, '');
    if (!NUMERIC.test(clean)) continue;
    // Skip bare years and very common small integers; keep 4+ digit strings
    // and decimals, which are the high-entropy items in business documents.
    if (/^(19|20)\d\d$/.test(clean)) continue;
    if (clean.length < 3 && !clean.includes('.')) continue;
    out.add(clean);
  }
  void ids;
  return out;
}

function cellsOf(text: string): Map<number, number> {
  const out = new Map<number, number>();
  for (const raw of text.split(/\s*[|｜]\s*/)) {
    const cell = raw.trim();
    if (!cell || cell === '∅') continue;
    let h = 0x811c9dc5;
    for (let i = 0; i < cell.length; i++) h = Math.imul(h ^ cell.charCodeAt(i), 0x01000193);
    h >>>= 0;
    out.set(h, (out.get(h) ?? 0) + 1);
  }
  return out;
}

function trigramHash(a: number, b: number, c: number): number {
  let h = 0x811c9dc5;
  h = Math.imul(h ^ a, 0x01000193);
  h = Math.imul(h ^ b, 0x01000193);
  h = Math.imul(h ^ c, 0x01000193);
  return h >>> 0;
}

export function buildLibrary(docs: ProtectedDocument[], config: DetectionConfig): PreparedLibrary {
  const seqIndex = new Map<string, Hit[]>();
  const bagIndex = new Map<string, Hit[]>();
  const segments = new Map<string, SegmentInfo>();
  const postings = new Map<number, string[]>();

  // Documents flagged piiOnly (customer lists) are excluded entirely: their
  // content must never become token fingerprints, only salted field hashes.
  const fpDocs = docs.filter((d) => !d.piiOnly);

  let segmentCount = 0;
  for (const doc of fpDocs) segmentCount += doc.text.segments.length;

  // Segment-level document frequency for IDF.
  const df = new Map<number, number>();
  for (const doc of fpDocs) {
    for (const seg of doc.text.segments) {
      const seen = new Set<number>();
      for (let t = seg.tokenStart; t < seg.tokenEnd; t++) seen.add(doc.text.tokens[t].id);
      for (const id of seen) df.set(id, (df.get(id) ?? 0) + 1);
    }
  }
  const idf = new Map<number, number>();
  for (const [id, d] of df) idf.set(id, Math.log(1 + segmentCount / (1 + d)));
  const maxIdf = Math.log(1 + segmentCount);

  const addHit = (map: Map<string, Hit[]>, h: string, hit: Hit) => {
    const arr = map.get(h);
    if (arr) arr.push(hit);
    else map.set(h, [hit]);
  };

  let fingerprintCount = 0;
  let bagFingerprintCount = 0;
  const bigramDf = new Map<number, number>();
  const unigramDf = new Map<number, number>();
  const numberDf = new Map<string, number>();

  for (const doc of fpDocs) {
    const ids = new Uint32Array(doc.text.tokens.length);
    for (let i = 0; i < ids.length; i++) ids[i] = doc.text.tokens[i].id;
    const stream = buildCanonicalStream(doc.text.tokens);

    for (const seg of doc.text.segments) {
      const len = seg.tokenEnd - seg.tokenStart;
      const segIds = ids.slice(seg.tokenStart, seg.tokenEnd);
      const counts = new Map<number, number>();
      let weight = 0;
      for (let i = 0; i < segIds.length; i++) {
        const id = segIds[i];
        counts.set(id, (counts.get(id) ?? 0) + 1);
        weight += idf.get(id) ?? 0;
      }

      const trigrams: Trigram[] = [];
      let trigramWeight = 0;
      if (len >= 3) {
        const seenTri = new Set<number>();
        for (let i = 0; i + 2 < len; i++) {
          const h = trigramHash(segIds[i], segIds[i + 1], segIds[i + 2]);
          if (seenTri.has(h)) continue;
          seenTri.add(h);
          const w = (idf.get(segIds[i]) ?? 0) + (idf.get(segIds[i + 1]) ?? 0) + (idf.get(segIds[i + 2]) ?? 0);
          trigrams.push({ h, w });
          trigramWeight += w;
        }
      }

      const key = segmentKey(doc.id, seg.index);
      const charStart = stream.tokenChar[seg.tokenStart];
      const charEnd = stream.tokenChar[seg.tokenEnd];
      const bigrams = charBigrams(stream, charStart, charEnd);
      let bigramTotal = 0;
      for (const c of bigrams.values()) bigramTotal += c;

      const unigrams = new Map<number, number>();
      for (let c = charStart; c < charEnd; c++) {
        const code = stream.codes[c];
        unigrams.set(code, (unigrams.get(code) ?? 0) + 1);
      }

      // Table rows: cell multiset (order-insensitive). Numeric literals:
      // distinctive values that paraphrase rarely changes.
      const segText = doc.text.raw.slice(seg.start, seg.end);
      const cells = /[|｜]/.test(segText) ? cellsOf(segText) : null;
      const tokenTexts: string[] = [];
      for (let t = seg.tokenStart; t < seg.tokenEnd; t++) tokenTexts.push(doc.text.tokens[t].text);
      const numbers = extractNumbers(segIds, tokenTexts);

      segments.set(key, {
        docId: doc.id,
        seg: seg.index,
        location: seg.location,
        tokenStart: seg.tokenStart,
        tokenEnd: seg.tokenEnd,
        tokenCount: len,
        ids: segIds,
        counts,
        weight,
        trigrams,
        trigramWeight,
        canonical: stream.chars.slice(charStart, charEnd),
        bigrams,
        bigramTotal,
        bigramWeight: 0,
        unigrams,
        unigramWeight: 0,
        cells,
        numbers,
        trigramMaxIdf: 0,
        charLength: charEnd - charStart,
        rawStart: seg.start,
        rawEnd: seg.end,
      });
      for (const b of bigrams.keys()) bigramDf.set(b, (bigramDf.get(b) ?? 0) + 1);
      for (const u of unigrams.keys()) unigramDf.set(u, (unigramDf.get(u) ?? 0) + 1);
      for (const n of numbers) numberDf.set(n, (numberDf.get(n) ?? 0) + 1);

      for (const id of counts.keys()) {
        const arr = postings.get(id);
        if (arr) arr.push(key);
        else postings.set(id, [key]);
      }

      if (len >= config.seqK) {
        for (let t = seg.tokenStart; t + config.seqK <= seg.tokenEnd; t++) {
          addHit(seqIndex, fingerprintOf(ids, t, config.seqK), {
            docId: doc.id,
            seg: seg.index,
            ts: t,
            te: t + config.seqK,
          });
          fingerprintCount++;
        }
      }
      if (len >= config.bagWindow) {
        for (let t = seg.tokenStart; t + config.bagWindow <= seg.tokenEnd; t += config.bagStride) {
          addHit(bagIndex, bagFingerprintOf(ids, t, config.bagWindow), {
            docId: doc.id,
            seg: seg.index,
            ts: t,
            te: t + config.bagWindow,
          });
          bagFingerprintCount++;
        }
      }
    }
  }

  // Bigram IDF needs the finished document frequencies; fill segment weights now.
  for (const info of segments.values()) {
    let w = 0;
    for (const [b, c] of info.bigrams) {
      w += c * Math.log(1 + segmentCount / (1 + (bigramDf.get(b) ?? 0)));
    }
    info.bigramWeight = w;
    let uw = 0;
    for (const [u, c] of info.unigrams) {
      uw += c * Math.log(1 + segmentCount / (1 + (unigramDf.get(u) ?? 0)));
    }
    info.unigramWeight = uw;
  }

  return {
    docs: fpDocs,
    seqIndex,
    bagIndex,
    segments,
    postings,
    idf,
    maxIdf,
    segmentCount,
    builtAt: Date.now(),
    fingerprintCount,
    bagFingerprintCount,
    bigramDf,
    bigramMaxIdf: Math.log(1 + segmentCount),
    unigramDf,
    numberDf,
  };
}

interface Candidate {
  key: string;
  info: SegmentInfo;
  /** protected-relative token offsets matched exactly */
  covered: Set<number>;
  /** outgoing absolute token indices matched exactly */
  outCovered: Set<number>;
  spans: { start: number; end: number }[];
}

interface OutSegment {
  index: number;
  tokenStart: number;
  tokenEnd: number;
  start: number;
  end: number;
  counts: Map<number, number>;
  trigrams?: Set<number>;
  /** canonical char bigrams of this outgoing block */
  bigrams: Map<number, number>;
  bigramWeight: number;
  unigrams: Map<number, number>;
  unigramWeight: number;
  charLength: number;
  /** canonical characters of this outgoing block */
  canonical: string;
  /** table rows only: cell multiset */
  cells: Map<number, number> | null;
  /** distinctive numeric literals in this outgoing block */
  numbers: Set<string>;
}

export interface MatchOptions {
  config: DetectionConfig;
  suppressedEvidence: Set<string>;
  suppressedSegments: Set<string>;
  maxCandidates?: number;
  /** Collect per-candidate metrics even for rejected candidates (calibration UI). */
  diagnostics?: boolean;
}

export interface CandidateDiagnostic {
  docId: string;
  segmentIndex: number;
  tokenCount: number;
  exactCoverage: number;
  trigramCoverage: number;
  overlap: number;
  charOverlap: number;
  unigramOverlap: number;
  cellOverlap: number;
  numberOverlap: number;
  lcsChars: number;
  lcsRatio: number;
  specificity: number;
  runLength: number;
  runConfidence: number;
  score: number;
  rejectedBy?: string;
}

export interface MatchOutput {
  matches: SegmentMatch[];
  suppressed: number;
  candidateCount: number;
  diagnostics: CandidateDiagnostic[];
}

/** IDF-weighted containment of protected segment S inside outgoing segment O. */
function overlapOf(info: SegmentInfo, out: OutSegment, idf: Map<number, number>): number {
  if (info.weight <= 0) return 0;
  let shared = 0;
  for (const [id, c] of info.counts) {
    const oc = out.counts.get(id);
    if (oc) shared += Math.min(c, oc) * (idf.get(id) ?? 0);
  }
  return Math.min(1, shared / info.weight);
}

function trigramContainment(
  info: SegmentInfo,
  out: OutSegment,
  outIds: Uint32Array,
  library: PreparedLibrary,
): number {
  if (info.trigramWeight <= 0) return 0;
  if (!out.trigrams) {
    // Only build outgoing trigrams for the token range of this outgoing segment.
    const set = new Set<number>();
    for (let t = out.tokenStart; t + 2 < out.tokenEnd; t++) {
      set.add(trigramHash(outIds[t], outIds[t + 1], outIds[t + 2]));
    }
    out.trigrams = set;
  }
  let hit = 0;
  for (const tri of info.trigrams) {
    if (out.trigrams.has(tri.h)) hit += tri.w;
  }
  void library;
  return Math.min(1, hit / info.trigramWeight);
}

export function scoreOf(
  exactCoverage: number,
  trigramCoverage: number,
  overlap: number,
  specificity: number,
  runConfidence: number,
  charOverlap: number,
  unigramOverlap: number,
  cellOverlap = 0,
  numberOverlap = 0,
  lcsRatio = 0,
): number {
  const raw =
    0.16 * exactCoverage +
    0.1 * overlap +
    0.08 * trigramCoverage +
    0.05 * specificity +
    0.08 * runConfidence +
    0.26 * charOverlap +
    0.14 * unigramOverlap +
    0.2 * cellOverlap +
    0.18 * lcsRatio +
    // Numbers are supporting evidence only: values like "3.1亿" recur across
    // unrelated documents, so this term can never carry a match on its own.
    // It only earns the full weight when there is textual overlap to
    // corroborate: the same amount inside a rewritten sentence is a strong
    // signal, the same amount alone is not.
    0.08 * numberOverlap +
    0.12 * numberOverlap * (charOverlap >= 0.35 || lcsRatio >= 0.35 ? 1 : 0);
  return Math.max(0, Math.min(100, raw * 100));
}

/** IDF-weighted char-bigram containment: how much of `inner` appears in `outer`. */
function charContainment(
  inner: Map<number, number>,
  innerWeight: number,
  outer: Map<number, number>,
  library: PreparedLibrary,
): number {
  if (innerWeight <= 0) return 0;
  let hit = 0;
  for (const [b, c] of inner) {
    const oc = outer.get(b);
    if (oc) hit += Math.min(c, oc) * bigramIdf(library, b);
  }
  return Math.min(1, hit / innerWeight);
}

function bigramIdf(library: PreparedLibrary, b: number): number {
  return Math.log(1 + library.segmentCount / (1 + (library.bigramDf.get(b) ?? 0)));
}

function unigramIdf(library: PreparedLibrary, u: number): number {
  return Math.log(1 + library.segmentCount / (1 + (library.unigramDf.get(u) ?? 0)));
}

/** IDF-weighted char-unigram containment: paraphrase term overlap. */
function unigramContainment(
  inner: Map<number, number>,
  innerWeight: number,
  outer: Map<number, number>,
  library: PreparedLibrary,
): number {
  if (innerWeight <= 0) return 0;
  let hit = 0;
  for (const [u, c] of inner) {
    const oc = outer.get(u);
    if (oc) hit += Math.min(c, oc) * unigramIdf(library, u);
  }
  return Math.min(1, hit / innerWeight);
}

/** Longest run of consecutive matched protected-relative token offsets. */
function longestRun(covered: Set<number>): number {
  if (covered.size === 0) return 0;
  const sorted = [...covered].sort((a, b) => a - b);
  let best = 1;
  let cur = 1;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === sorted[i - 1] + 1) cur++;
    else cur = 1;
    if (cur > best) best = cur;
  }
  return best;
}

/** Mean IDF of matched tokens, normalised by the library's max IDF. */
function coverageSpecificity(
  covered: Set<number>,
  info: SegmentInfo,
  library: PreparedLibrary,
): number {
  if (covered.size === 0 || library.maxIdf <= 0) return 0;
  let w = 0;
  for (const rel of covered) w += library.idf.get(info.ids[rel]) ?? 0;
  return Math.min(1, w / covered.size / library.maxIdf);
}

function hashSpans(spans: { start: number; end: number }[]): string {
  let h = 0x811c9dc5;
  for (const s of spans) {
    h = Math.imul(h ^ s.start, 0x01000193);
    h = Math.imul(h ^ s.end, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/** Jaccard-style overlap for order-insensitive table cell bags. */
function cellOverlap(a: Map<number, number>, b: Map<number, number>): { overlap: number; shared: number } {
  let aTotal = 0;
  let bTotal = 0;
  let shared = 0;
  for (const c of a.values()) aTotal += c;
  for (const c of b.values()) bTotal += c;
  for (const [h, c] of a) {
    const other = b.get(h);
    if (other) shared += Math.min(c, other);
  }
  const denom = Math.max(aTotal, bTotal);
  return { overlap: denom === 0 ? 0 : shared / denom, shared };
}

/** Fraction of a segment's distinctive numbers that also appear in the block. */
function numberOverlap(info: SegmentInfo, out: OutSegment, library: PreparedLibrary): { overlap: number; count: number } {
  if (info.numbers.size === 0) return { overlap: 0, count: 0 };
  let total = 0;
  let matched = 0;
  let matchedW = 0;
  for (const n of info.numbers) {
    const df = library.numberDf.get(n) ?? 1;
    const weight = Math.log(1 + library.segmentCount / (1 + df));
    total += weight;
    if (out.numbers.has(n)) {
      matched++;
      matchedW += weight;
    }
  }
  return { overlap: total > 0 ? matchedW / total : 0, count: matched };
}

/**
 * Longest common substring of canonical characters, relative to the shorter
 * side. Rewriting keeps isolated phrases intact even when every sentence
 * around them is reworded, so this is the signal that survives heavy
 * paraphrase. Punctuation never appears in the stream, so it is immune to
 * punctuation edits too.
 */
function longestCommonRun(a: string, b: string): { chars: number; ratio: number } {
  if (a.length === 0 || b.length === 0) return { chars: 0, ratio: 0 };
  // Classic DP with rolling rows; strings here are < ~2000 chars.
  let prev = new Uint16Array(b.length + 1);
  let cur = new Uint16Array(b.length + 1);
  let best = 0;
  for (let i = 1; i <= a.length; i++) {
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      if (ca === b.charCodeAt(j - 1)) {
        const v = prev[j - 1] + 1;
        cur[j] = v;
        if (v > best) best = v;
      } else {
        cur[j] = 0;
      }
    }
    const tmp = prev;
    prev = cur;
    cur = tmp;
    cur.fill(0);
  }
  return { chars: best, ratio: best / Math.max(1, Math.min(a.length, b.length)) };
}

/**
 * Match a scanned document against the prepared library.
 * Returns one match per protected segment that clears the gates.
 */
export function matchSegments(
  scanned: DocumentText,
  library: PreparedLibrary,
  options: MatchOptions,
): MatchOutput {
  const { config, suppressedEvidence, suppressedSegments } = options;
  const maxCandidates = options.maxCandidates ?? 40;

  const outIds = new Uint32Array(scanned.tokens.length);
  for (let i = 0; i < outIds.length; i++) outIds[i] = scanned.tokens[i].id;
  const scannedStream = buildCanonicalStream(scanned.tokens);

  const candidates = new Map<string, Candidate>();

  const consider = (hit: Hit, outTs: number, outTe: number): Candidate | null => {
    const key = segmentKey(hit.docId, hit.seg);
    let cand = candidates.get(key);
    if (!cand) {
      const info = library.segments.get(key);
      if (!info) return null;
      cand = { key, info, covered: new Set(), outCovered: new Set(), spans: [] };
      candidates.set(key, cand);
    }
    for (let t = hit.ts; t < hit.te; t++) cand.covered.add(t - cand.info.tokenStart);
    for (let t = outTs; t < outTe; t++) cand.outCovered.add(t);
    cand.spans.push({ start: scanned.tokens[outTs].start, end: scanned.tokens[outTe - 1].end });
    return cand;
  };

  // 1. Exact-order fingerprints.
  for (let t = 0; t + config.seqK <= outIds.length; t++) {
    const hits = library.seqIndex.get(fingerprintOf(outIds, t, config.seqK));
    if (!hits) continue;
    for (const hit of hits) consider(hit, t, t + config.seqK);
  }
  // 2. Bag fingerprints (local reorder tolerance).
  for (let t = 0; t + config.bagWindow <= outIds.length; t++) {
    const hits = library.bagIndex.get(bagFingerprintOf(outIds, t, config.bagWindow));
    if (!hits) continue;
    for (const hit of hits) consider(hit, t, t + config.bagWindow);
  }

  // 3. Vocabulary candidates: enable paraphrase detection with zero exact hits.
  const candidateWeight = new Map<string, number>();
  for (let t = 0; t < outIds.length; t++) {
    const keys = library.postings.get(outIds[t]);
    if (!keys) continue;
    const w = library.idf.get(outIds[t]) ?? 0;
    for (const k of keys) candidateWeight.set(k, (candidateWeight.get(k) ?? 0) + w);
  }
  const ranked = [...candidateWeight.entries()].sort((a, b) => b[1] - a[1]);
  let extra = 0;
  for (const [key] of ranked) {
    if (candidates.has(key)) continue;
    if (extra >= maxCandidates) break;
    const info = library.segments.get(key);
    if (!info) continue;
    candidates.set(key, {
      key,
      info,
      covered: new Set(),
      outCovered: new Set(),
      spans: [],
    });
    extra++;
  }

  const outSegments: OutSegment[] = scanned.segments.map((s) => {
    const counts = new Map<number, number>();
    for (let t = s.tokenStart; t < s.tokenEnd; t++) {
      const id = outIds[t];
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    const bigrams = charBigrams(scannedStream, scannedStream.tokenChar[s.tokenStart], scannedStream.tokenChar[s.tokenEnd]);
    let bigramWeight = 0;
    for (const [b, c] of bigrams) bigramWeight += c * bigramIdf(library, b);
    const unigrams = new Map<number, number>();
    for (let c = scannedStream.tokenChar[s.tokenStart]; c < scannedStream.tokenChar[s.tokenEnd]; c++) {
      const code = scannedStream.codes[c];
      unigrams.set(code, (unigrams.get(code) ?? 0) + 1);
    }
    let unigramWeight = 0;
    for (const [u, c] of unigrams) unigramWeight += c * unigramIdf(library, u);
    return {
      index: s.index,
      tokenStart: s.tokenStart,
      tokenEnd: s.tokenEnd,
      start: s.start,
      end: s.end,
      counts,
      bigrams,
      bigramWeight,
      unigrams,
      unigramWeight,
      charLength: scannedStream.tokenChar[s.tokenEnd] - scannedStream.tokenChar[s.tokenStart],
      canonical: scannedStream.chars.slice(
        scannedStream.tokenChar[s.tokenStart],
        scannedStream.tokenChar[s.tokenEnd],
      ),
      cells: /[|｜]/.test(scanned.raw.slice(s.start, s.end)) ? cellsOf(scanned.raw.slice(s.start, s.end)) : null,
      numbers: extractNumbers(
        outIds,
        scanned.tokens.slice(s.tokenStart, s.tokenEnd).map((t) => t.text),
      ),
    };
  });
  const outPostings = new Map<number, number[]>();
  for (const os of outSegments) {
    for (const id of os.counts.keys()) {
      const arr = outPostings.get(id);
      if (arr) arr.push(os.index);
      else outPostings.set(id, [os.index]);
    }
  }

  // Rolling windows of 2-4 consecutive outgoing blocks. A paragraph that got
  // split into several table rows (or a table flattened into paragraphs) only
  // lines up with the protected segment when neighbours are considered.
  const windows: OutSegment[] = [...outSegments];
  if (outSegments.length <= 400) {
    for (let width = 2; width <= Math.min(4, outSegments.length); width++) {
      for (let i = 0; i + width <= outSegments.length; i++) {
        // Do not join blocks that are far apart in the file (different sheets).
        let contiguous = true;
        for (let k = i + 1; k < i + width; k++) {
          const gapChars = outSegments[k].start - outSegments[k - 1].end;
          if (gapChars > 3) {
            contiguous = false;
            break;
          }
        }
        if (!contiguous) continue;
        const first = outSegments[i];
        const last = outSegments[i + width - 1];
        const counts = new Map<number, number>();
        const bigrams = new Map<number, number>();
        const unigrams = new Map<number, number>();
        const numbers = new Set<string>();
        let cells: Map<number, number> | null = null;
        for (let k = i; k < i + width; k++) {
          const part = outSegments[k];
          for (const [id, c] of part.counts) counts.set(id, (counts.get(id) ?? 0) + c);
          for (const [b, c] of part.bigrams) bigrams.set(b, (bigrams.get(b) ?? 0) + c);
          for (const [u, c] of part.unigrams) unigrams.set(u, (unigrams.get(u) ?? 0) + c);
          for (const n of part.numbers) numbers.add(n);
          if (part.cells) {
            if (!cells) cells = new Map();
            for (const [h, c] of part.cells) cells.set(h, (cells.get(h) ?? 0) + c);
          }
        }
        let bigramWeight = 0;
        for (const [b, c] of bigrams) bigramWeight += c * bigramIdf(library, b);
        let unigramWeight = 0;
        for (const [u, c] of unigrams) unigramWeight += c * unigramIdf(library, u);
        windows.push({
          index: first.index,
          tokenStart: first.tokenStart,
          tokenEnd: last.tokenEnd,
          start: first.start,
          end: last.end,
          counts,
          bigrams,
          bigramWeight,
          unigrams,
          unigramWeight,
          charLength:
            scannedStream.tokenChar[last.tokenEnd] - scannedStream.tokenChar[first.tokenStart],
          canonical: scannedStream.chars.slice(
            scannedStream.tokenChar[first.tokenStart],
            scannedStream.tokenChar[last.tokenEnd],
          ),
          cells,
          numbers,
        });
      }
    }
  }

  const matches: SegmentMatch[] = [];
  const diagnostics: CandidateDiagnostic[] = [];
  let suppressed = 0;

  for (const cand of candidates.values()) {
    const info = cand.info;

    // (a) exact ordered coverage, IDF weighted; look up ids by relative offset.
    let coveredWeight = 0;
    for (const rel of cand.covered) {
      coveredWeight += library.idf.get(info.ids[rel]) ?? 0;
    }
    const exactCoverage = info.weight > 0 ? Math.min(1, coveredWeight / info.weight) : 0;
    const evidence = cand.covered.size;
    const specificity =
      coverageSpecificity(cand.covered, info, library);

    // longest contiguous exact run, relative to segment length
    const run = longestRun(cand.covered);
    const runConfidence = info.tokenCount > 0 ? Math.min(1, run / Math.min(info.tokenCount, config.seqK * 2)) : 0;

    // (b) align to the best outgoing block (or rolling block window) by
    // weighted shared content.
    const alignTargets: OutSegment[] = [...outSegments];
    if (windows.length > outSegments.length) alignTargets.push(...windows.slice(outSegments.length));
    const pairWeight = new Map<number, number>();
    for (const [id, c] of info.counts) {
      const segs = outPostings.get(id);
      if (!segs) continue;
      const w = (library.idf.get(id) ?? 0) * c;
      for (const si of segs) pairWeight.set(si, (pairWeight.get(si) ?? 0) + w);
    }
    const pairs = [...pairWeight.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    // Nearby windows around the top single-block pairs are worth checking too.
    const windowTargets: OutSegment[] = [];
    for (const [si] of pairs) {
      for (const w of windows.slice(outSegments.length)) {
        if (w.index >= si - 3 && w.index <= si + 1) windowTargets.push(w);
      }
    }
    const targets = [...pairs.map(([si]) => outSegments[si]), ...windowTargets.slice(0, 16)];
    if (targets.length === 0) continue;

    let best: {
      out: OutSegment;
      overlap: number;
      tri: number;
      charOverlap: number;
      unigramOverlap: number;
      cellOverlap: number;
      numberOverlap: number;
      lcsChars: number;
      lcsRatio: number;
      score: number;
    } | null = null;
    for (const out of targets) {
      const overlap = overlapOf(info, out, library.idf);
      const tri = trigramContainment(info, out, outIds, library);
      // Containment in both directions: a short excerpt covers the whole
      // protected segment; a long outgoing file that quotes one segment
      // covers the segment but not the outgoing block. A tiny outgoing block
      // that merely appears inside a segment (a heading word, a stock phrase)
      // is damped by its size ratio so it cannot pass as an excerpt.
      const forward = charContainment(info.bigrams, info.bigramWeight, out.bigrams, library);
      const backwardRaw = charContainment(out.bigrams, out.bigramWeight, info.bigrams, library);
      const sizeFactor = Math.min(1, out.charLength / Math.max(1, info.charLength) / 0.5);
      const charOverlap = Math.max(forward, backwardRaw * sizeFactor);
      const uf = unigramContainment(info.unigrams, info.unigramWeight, out.unigrams, library);
      const ubRaw = unigramContainment(out.unigrams, out.unigramWeight, info.unigrams, library);
      const unigramOverlap = Math.max(uf, ubRaw * sizeFactor);
      const cell = info.cells && out.cells ? cellOverlap(info.cells, out.cells).overlap : 0;
      const numbers = numberOverlap(info, out, library);
      // Longest verbatim phrase: survives reordering and heavy rewriting.
      const lcs = longestCommonRun(info.canonical, out.canonical);
      const lcsRatio = Math.min(1, lcs.ratio * 1.6);
      const score = scoreOf(
        exactCoverage,
        tri,
        overlap,
        specificity,
        runConfidence,
        charOverlap,
        unigramOverlap,
        cell,
        numbers.overlap,
        lcsRatio,
      );
      if (!best || score > best.score)
        best = {
          out,
          overlap,
          tri,
          charOverlap,
          unigramOverlap,
          cellOverlap: cell,
          numberOverlap: numbers.overlap,
          lcsChars: lcs.chars,
          lcsRatio,
          score,
        };
    }
    if (!best) continue;

    const diag: CandidateDiagnostic = {
      docId: info.docId,
      segmentIndex: info.seg,
      tokenCount: info.tokenCount,
      exactCoverage,
      trigramCoverage: best.tri,
      overlap: best.overlap,
      charOverlap: best.charOverlap,
      unigramOverlap: best.unigramOverlap,
      cellOverlap: best.cellOverlap,
      numberOverlap: best.numberOverlap,
      lcsChars: best.lcsChars,
      lcsRatio: best.lcsRatio,
      specificity,
      runLength: run,
      runConfidence,
      score: best.score,
    };

    // (c) gates: must look like the same text, not merely the same topic.
    // Strong phrase-level evidence (char bigrams) is the primary gate; pure
    // vocabulary overlap alone is not enough, which is what keeps
    // same-topic documents out.
    // Short blocks (headings, one-line table cells) need near-total coverage
    // through a phrase, cell-bag, or distinctive-number channel.
    const isShort = info.tokenCount < 14;
    const score = isShort ? Math.min(75, best.score) : best.score;
    // A distinctive number that also appears verbatim is corroboration, not
    // proof: require phrase, cell-bag or exact-fingerprint evidence too.
    const phraseEvidence = Math.max(best.charOverlap, best.cellOverlap, best.lcsRatio);
    const numberCorroboration = best.numberOverlap >= 0.6 && phraseEvidence >= 0.25;
    const exactEvidence = run >= config.seqK || (evidence >= config.minEvidence && !isShort);
    const shortEnough = info.charLength >= 12 && (phraseEvidence >= 0.9 || numberCorroboration);
    // Substantial-evidence floor: a shared entity name plus one shared number
    // is what unrelated documents about the same transaction look like. A
    // real leak carries either broad text coverage, a long verbatim phrase,
    // a matching table row, or numbers corroborated by surrounding text.
    const substantial =
      exactCoverage >= 0.3 ||
      best.charOverlap >= 0.4 ||
      best.cellOverlap >= 0.6 ||
      best.lcsChars >= 20 ||
      (best.numberOverlap >= 0.8 && best.charOverlap >= 0.45);
    const strongEnough =
      exactCoverage >= config.minSegmentCoverage ||
      best.overlap >= config.minOverlap ||
      phraseEvidence >= config.minCharOverlap;
    let rejectedBy: string | undefined;
    if (!substantial) rejectedBy = 'thin-evidence';
    // A long verbatim phrase (>= 18 canonical chars) is strong enough on its
    // own even when the surrounding sentences are rewritten.
    const longPhrase = best.lcsChars >= 18;
    if (rejectedBy) {
      // keep the thin-evidence verdict
    } else if (isShort && !shortEnough && !longPhrase) rejectedBy = 'short-block';
    else if (
      !isShort &&
      !exactEvidence &&
      !longPhrase &&
      phraseEvidence < config.minCharOverlap &&
      !numberCorroboration
    )
      rejectedBy = 'char-overlap';
    else if (!strongEnough) rejectedBy = 'coverage';
    else if (score < config.minSegmentScore) rejectedBy = 'score';
    diag.score = score;
    diag.rejectedBy = rejectedBy;
    diagnostics.push(diag);
    if (rejectedBy) continue;

    const sourceDoc = library.docs.find((d) => d.id === info.docId);
    const sourceText = sourceDoc ? sourceDoc.text.raw.slice(info.rawStart, info.rawEnd) : '';
    const evidenceHash = `${info.docId}:${info.seg}:${hashSpans(cand.spans)}`;

    if (suppressedSegments.has(cand.key) || suppressedEvidence.has(evidenceHash)) {
      suppressed++;
      continue;
    }

    const spans: AlertEvidenceSpan[] = mergeSpans(cand.spans, 1).map((s) => ({
      start: s.start,
      end: s.end,
      text: scanned.raw.slice(s.start, s.end),
    }));
    if (spans.length === 0) {
      spans.push({
        start: best.out.start,
        end: best.out.end,
        text: scanned.raw.slice(best.out.start, best.out.end),
      });
    }

    matches.push({
      docId: info.docId,
      docTitle: sourceDoc?.title ?? info.docId,
      segmentIndex: info.seg,
      location: info.location,
      score: Math.round(score * 10) / 10,
      exactCoverage,
      overlap: best.overlap,
      evidence,
      idfNorm: specificity,
      matchedTokens: evidence,
      segmentTokens: info.tokenCount,
      spans,
      outStart: best.out.start,
      outEnd: best.out.end,
      sourceText,
      evidenceHash,
      trigramCoverage: best.tri,
      charOverlap: best.charOverlap,
      unigramOverlap: best.unigramOverlap,
      cellOverlap: best.cellOverlap,
      numberOverlap: best.numberOverlap,
      lcsChars: best.lcsChars,
      lcsRatio: best.lcsRatio,
    });
  }

  matches.sort((a, b) => b.score - a.score);
  return { matches, suppressed, candidateCount: candidates.size, diagnostics };
}
