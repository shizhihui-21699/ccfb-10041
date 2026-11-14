/**
 * Text normalization + tokenization.
 *
 * The fingerprinting pipeline is deliberately punctuation-blind: punctuation
 * and whitespace never become tokens, so changing `，` to `,` or adding a
 * space cannot break a fingerprint. CJK text is tokenized per character
 * (which side-steps the unsolvable word-segmentation problem and makes
 * punctuation/quote edits no-ops), Latin text per word.
 */
import type { DocumentText, ParsedBlock, Segment, Token } from './types';
import { hashToken } from './hash';

const SEP = /[\s\p{P}\p{S}\p{C}]/u;
const ZERO_WIDTH = /[­​-‏‪-‮⁠﻿]/;
const CJK = /[々〇㐀-䶿一-鿿豈-﫿぀-ヿ가-힯]|[\u{20000}-\u{2FA1F}]/u;

export function isCjkChar(ch: string): boolean {
  return ch.length === 1 && CJK.test(ch);
}

function normalizeChar(ch: string): string {
  let s: string;
  try {
    s = ch.normalize('NFKC');
  } catch {
    s = ch;
  }
  return s.toLowerCase();
}

/** Punctuation-insensitive canonical form used for salted customer PII hashes. */
export function canonicalValue(
  value: string,
  field: 'name' | 'phone' | 'email' | 'idNumber' | 'company' | 'account',
): string {
  let s: string;
  try {
    s = value.normalize('NFKC').toLowerCase();
  } catch {
    s = value.toLowerCase();
  }
  if (field === 'email') return s.trim().replace(/\s+/g, '');
  if (field === 'phone' || field === 'account') return s.replace(/[^\d]/g, '');
  if (field === 'idNumber') return s.replace(/[^\p{L}\p{N}]/gu, '');
  return s.replace(/[^\p{L}\p{N}]/gu, '');
}

/**
 * Tokenize a block of text. Punctuation/whitespace are separators and never
 * become tokens. Token offsets point into the original raw block text.
 */
export function tokenizeText(text: string, rawOffset: number, into: Token[]): void {
  let word = '';
  let wordStart = -1;
  let wordEnd = -1;
  let lastChar = '';

  const flush = () => {
    if (word.length > 0 && wordStart >= 0) {
      into.push({
        text: word,
        id: hashToken(word),
        start: rawOffset + wordStart,
        end: rawOffset + wordEnd,
      });
    }
    word = '';
    wordStart = -1;
    wordEnd = -1;
  };

  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ZERO_WIDTH.test(ch)) {
      i += 1;
      continue;
    }

    // Normalize first, then classify: PDF text extraction sometimes yields
    // Kangxi radicals (U+2F00 block) which NFKC maps to normal ideographs.
    // Classifying before NFKC would drop them as symbols.
    const norm = normalizeChar(ch);
    const clean = norm.replace(/[^\p{L}\p{N}\p{M}]/gu, '');
    const isSep = clean.length === 0 && SEP.test(ch);
    const charLen = ch.length;

    if (
      isSep &&
      (ch === '.' || ch === ',') &&
      word.length > 0 &&
      /[\d.]$/.test(lastChar) &&
      wordStart >= 0
    ) {
      // Keep decimal points / thousands separators inside numeric tokens.
      // Commas are dropped so 1,000 and 1000 tokenize identically; dots are
      // kept so 3.1 stays 3.1 rather than joining unrelated numbers.
      const next = text[i + 1];
      if (next !== undefined && /\d/.test(normalizeChar(next))) {
        if (ch === '.') word += '.';
        wordEnd = i + 1;
        lastChar = ch;
        i += 1;
        continue;
      }
    }

    if (isSep) {
      flush();
      lastChar = '';
      i += charLen;
      continue;
    }

    // CJK ideographs (and their NFKC-normalised forms) are single tokens;
    // everything else accumulates into a word.
    if (CJK.test(ch) || (/[一-鿿]/.test(clean) && clean.length === 1)) {
      flush();
      into.push({
        text: clean,
        id: hashToken(clean),
        start: rawOffset + i,
        end: rawOffset + i + charLen,
      });
      lastChar = ch;
      i += charLen;
      continue;
    }

    if (word.length === 0) wordStart = i;
    word += clean;
    wordEnd = i + 1;
    lastChar = ch;
    i += 1;
  }
  flush();
}

/** Build the searchable token stream and paragraph segments for a document. */
export function buildDocumentText(blocks: ParsedBlock[]): DocumentText {
  const tokens: Token[] = [];
  const segments: Segment[] = [];
  let raw = '';
  const parts: string[] = [];
  let offset = 0;

  for (const block of blocks) {
    if (raw.length > 0) {
      parts.push('\n');
      offset += 1;
    }
    const start = offset;
    parts.push(block.text);
    offset += block.text.length;
    const end = offset;

    const tokenStart = tokens.length;
    tokenizeText(block.text, start, tokens);
    if (tokens.length > tokenStart) {
      segments.push({
        index: segments.length,
        location: block.location,
        start,
        end,
        tokenStart,
        tokenEnd: tokens.length,
      });
    }
  }
  raw = parts.join('');

  const tokenSegment = new Int32Array(tokens.length).fill(-1);
  for (const seg of segments) {
    for (let t = seg.tokenStart; t < seg.tokenEnd; t++) tokenSegment[t] = seg.index;
  }
  return { raw, tokens, segments, tokenSegment };
}

/**
 * A canonical character stream over tokens: lowercase, punctuation-free,
 * with a mapping back to raw offsets. Phone numbers written `138-0013-8000`
 * become the contiguous string `13800138000` in this stream, which is what
 * the salted-hash customer matcher enumerates.
 */
export interface CanonicalStream {
  chars: string;
  codes: Uint32Array;
  rawStart: Int32Array;
  rawEnd: Int32Array;
  /** token index -> canonical char offset (length = tokens.length + 1) */
  tokenChar: Int32Array;
}

export function buildCanonicalStream(tokens: Token[]): CanonicalStream {
  let chars = '';
  const starts: number[] = [];
  const ends: number[] = [];
  const tokenChar = new Int32Array(tokens.length + 1);
  for (let ti = 0; ti < tokens.length; ti++) {
    const token = tokens[ti];
    tokenChar[ti] = chars.length;
    const norm = token.text.normalize('NFKC').toLowerCase();
    const clean = norm.replace(/[^\p{L}\p{N}]/gu, '');
    if (clean.length === 0) continue;
    const span = Math.max(1, token.end - token.start);
    for (let j = 0; j < clean.length; j++) {
      chars += clean[j];
      starts.push(token.start + Math.round((j * span) / clean.length));
      ends.push(token.start + Math.round(((j + 1) * span) / clean.length));
    }
  }
  tokenChar[tokens.length] = chars.length;
  const codes = new Uint32Array(chars.length);
  for (let i = 0; i < chars.length; i++) codes[i] = chars.codePointAt(i) ?? 0;
  return {
    chars,
    codes,
    rawStart: Int32Array.from(starts),
    rawEnd: Int32Array.from(ends),
    tokenChar,
  };
}

/** Merge overlapping raw spans. */
export function mergeSpans(spans: { start: number; end: number }[], pad = 0): { start: number; end: number }[] {
  if (spans.length === 0) return [];
  const sorted = spans
    .map((s) => ({ start: Math.max(0, s.start - pad), end: s.end + pad }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const out: { start: number; end: number }[] = [];
  let cur = { ...sorted[0] };
  for (let i = 1; i < sorted.length; i++) {
    const s = sorted[i];
    if (s.start <= cur.end) {
      cur.end = Math.max(cur.end, s.end);
    } else {
      out.push(cur);
      cur = { ...s };
    }
  }
  out.push(cur);
  return out;
}

/** Hash of two adjacent canonical characters. */
export function bigramHash(a: number, b: number): number {
  let h = 0x811c9dc5;
  h = Math.imul(h ^ a, 0x01000193);
  h = Math.imul(h ^ b, 0x01000193);
  return h >>> 0;
}

/** Distinct char bigrams of a canonical stream slice, with multiplicities. */
export function charBigrams(stream: CanonicalStream, start: number, end: number): Map<number, number> {
  const out = new Map<number, number>();
  for (let i = start; i + 1 < end; i++) {
    const h = bigramHash(stream.codes[i], stream.codes[i + 1]);
    out.set(h, (out.get(h) ?? 0) + 1);
  }
  return out;
}
