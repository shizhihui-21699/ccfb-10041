/**
 * Shared evaluation harness: builds the fingerprint library and PII vault
 * from the generated sample files, scans every outgoing sample, and compares
 * the alerts against the ground-truth labels.
 *
 * Used by tools/eval.ts (Node, reads from disk) and by the app's self-check
 * page (browser, fetches from public/samples). Keeping one implementation
 * means the numbers shown in the UI are the numbers the CLI prints.
 */
import type {
  Alert,
  DetectionConfig,
  ParsedDocument,
  ProtectedDocument,
  PiiVault,
  FeedbackRecord,
} from '../core/types';
import { buildDocumentText, buildCanonicalStream } from '../core/normalize';
import type { PreparedLibrary } from '../core/fingerprint';
import { createVault, matchPii, type PreparedVault, type RawCustomerRecord } from '../core/pii';
import { runScan, buildSuppression } from '../core/scan';

export interface SampleManifest {
  protected: {
    id: string;
    title: string;
    owner: string;
    classification: string;
    format: string;
    file: string;
    segments: number;
    piiOnly?: boolean;
  }[];
  outgoing: {
    id: string;
    scenario: string;
    format: string;
    file: string;
    leaks: { docId: string; segment: number; mutation: string }[];
    pii: { recordId: string; fields: string[] }[];
    expectNone: boolean;
    notes?: string;
  }[];
}

export interface DemoEnv {
  library: PreparedLibrary;
  vault: PreparedVault;
  docs: ProtectedDocument[];
  vaultId: string;
  fileHashes: Map<string, { docId: string; docTitle: string }>;
}


/** Build the vault from the CUSTOMER sheet's parsed rows. */
export function vaultFromCustomerRows(rows: string[]): { vault: PiiVault; key: Uint8Array } {
  const header = rows[0].split(' | ').map((h) => h.trim());
  const idx = (names: string[]) => header.findIndex((h) => names.some((n) => h.includes(n)));
  const iId = idx(['客户编号', '编号', 'id']);
  const iName = idx(['姓名', '联系人']);
  const iPhone = idx(['手机', '电话']);
  const iEmail = idx(['邮箱']);
  const iCompany = idx(['客户名称', '公司名称']);
  const iAccount = idx(['账号', '银行']);
  const records: RawCustomerRecord[] = [];
  const ids: string[] = [];
  for (const line of rows.slice(1)) {
    const cells = line.split(' | ');
    const rec: RawCustomerRecord = {};
    ids.push((iId >= 0 ? cells[iId] : '').trim() || `R${ids.length + 1}`);
    if (iName >= 0) rec.name = cells[iName];
    if (iPhone >= 0) rec.phone = cells[iPhone];
    if (iEmail >= 0) rec.email = cells[iEmail];
    if (iCompany >= 0) rec.company = cells[iCompany];
    if (iAccount >= 0) rec.account = cells[iAccount];
    records.push(rec);
  }
  const { vault, key } = createVault('重点客户名单', records, {}, ids);
  return { vault, key };
}

export interface EvalCounts {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
}

export interface SampleEvaluation {
  id: string;
  scenario: string;
  expectNone: boolean;
  /** Per-expected-leak resolution status. */
  leaks: { docId: string; segment: number; mutation: string; detected: boolean; score: number }[];
  /** Alerts not corresponding to any expected leak. */
  falsePositives: { title: string; detector: Alert['detector']; score: number; docId?: string; segmentIndex?: number }[];
  pii: { recordId: string; fields: string[]; detected: boolean; fieldsDetected: string[] }[];
  piiFalsePositives: { recordId: string; fields: string[]; score: number }[];
  segmentCounts: EvalCounts;
  piiCounts: EvalCounts;
}

export interface EvalReport {
  samples: SampleEvaluation[];
  segment: EvalCounts & { precision: number; recall: number; f1: number };
  pii: EvalCounts & { precision: number; recall: number; f1: number };
  decoyFalsePositives: number;
  decoys: number;
  elapsedMs: number;
  perMutation: Record<string, { total: number; detected: number }>;
}

function f1(tp: number, fp: number, fn: number): { precision: number; recall: number; f1: number } {
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  return { precision, recall, f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall) };
}

/** Run a scan and match results against one sample's labels. */
export function evaluateSample(
  sample: SampleManifest['outgoing'][number],
  scanned: ParsedDocument,
  env: DemoEnv,
  config: DetectionConfig,
  suppressionFeedback: FeedbackRecord[] = [],
): SampleEvaluation {
  const suppression = buildSuppression(suppressionFeedback);
  const result = runScan({
    parsed: scanned,
    library: env.library,
    vault: env.vault,
    config,
    suppression,
    protectedHashes: env.fileHashes,
  });

  // Segment hits are keyed by (docId, segmentIndex); the best score wins.
  const segHits = new Map<string, number>();
  for (const m of result.segmentMatches) {
    const key = `${m.docId}:${m.segmentIndex}`;
    segHits.set(key, Math.max(segHits.get(key) ?? 0, m.score));
  }
  const expected = new Set(sample.leaks.map((l) => `${l.docId}:${l.segment}`));
  const leaks = sample.leaks.map((l) => {
    const key = `${l.docId}:${l.segment}`;
    const score = segHits.get(key) ?? 0;
    return { ...l, detected: segHits.has(key), score };
  });
  const detectedLeakKeys = new Set(leaks.filter((l) => l.detected).map((l) => `${l.docId}:${l.segment}`));

  const falsePositives: SampleEvaluation['falsePositives'] = [];
  let extraSegHits = 0;
  for (const [key, score] of segHits) {
    if (expected.has(key)) continue;
    const m = result.segmentMatches.find((x) => `${x.docId}:${x.segmentIndex}` === key);
    falsePositives.push({
      title: m ? `${m.docTitle} ${m.location}` : key,
      detector: 'segment',
      score,
      docId: m?.docId,
      segmentIndex: m?.segmentIndex,
    });
    extraSegHits++;
  }

  // PII: expected records vs. detected records with enough fields.
  const piiByRecord = new Map<string, Set<string>>();
  for (const group of collectGroups(env, scanned)) {
    piiByRecord.set(group.recordId, new Set(group.fields));
  }
  const pii = sample.pii.map((label) => {
    const detectedFields = [...(piiByRecord.get(label.recordId) ?? [])];
    const required = label.fields;
    const hit = required.filter((f) => detectedFields.includes(f));
    // A record counts as detected when every required field was matched.
    const detected = required.length > 0 && hit.length === required.length;
    return { ...label, detected, fieldsDetected: detectedFields };
  });
  const expectedRecords = new Set(sample.pii.map((p) => p.recordId));
  const requiredByRecord = new Map(sample.pii.map((p) => [p.recordId, new Set(p.fields)]));
  const piiFalsePositives: SampleEvaluation['piiFalsePositives'] = [];
  for (const [recordId, fields] of piiByRecord) {
    if (expectedRecords.has(recordId)) continue;
    // A record whose every matched field is a required field of the sample
    // (e.g. a second table row of the same customer sheet) is still a true
    // alert in practice, but with no label it counts against precision.
    piiFalsePositives.push({ recordId, fields: [...fields], score: 0 });
    void requiredByRecord;
  }

  const segTp = leaks.filter((l) => l.detected).length;
  const segFn = leaks.length - segTp;
  const segFp = extraSegHits;
  // For samples with no expected leak, every hit is a false positive and the
  // absence of hits is a true negative.
  const segTn = expected.size === 0 && segFp === 0 ? 1 : 0;
  const piiTp = pii.filter((p) => p.detected).length;
  const piiFn = pii.length - piiTp;
  const piiFp = piiFalsePositives.length;
  const piiTn = sample.pii.length === 0 && piiFp === 0 ? 1 : 0;
  void detectedLeakKeys;

  return {
    id: sample.id,
    scenario: sample.scenario,
    expectNone: sample.expectNone,
    leaks,
    falsePositives,
    pii,
    piiFalsePositives,
    segmentCounts: { tp: segTp, fp: segFp, fn: segFn, tn: segTn },
    piiCounts: { tp: piiTp, fp: piiFp, fn: piiFn, tn: piiTn },
  };
}

function collectGroups(
  env: DemoEnv,
  scanned: ParsedDocument,
) {
  const text = buildDocumentText(scanned.blocks);
  const stream = buildCanonicalStream(text.tokens);
  return matchPii(text, stream, env.vault, {
    piiComboFields: 2,
    piiProximity: 160,
    minPiiScore: 0,
  } as DetectionConfig).groups;
}

export function aggregate(samples: SampleEvaluation[], elapsedMs: number): EvalReport {
  const totals = { seg: { tp: 0, fp: 0, fn: 0 }, pii: { tp: 0, fp: 0, fn: 0 } };
  const perMutation = new Map<string, { total: number; detected: number }>();
  let decoyFalsePositives = 0;
  let decoys = 0;
  for (const s of samples) {
    totals.seg.tp += s.segmentCounts.tp;
    totals.seg.fp += s.segmentCounts.fp;
    totals.seg.fn += s.segmentCounts.fn;
    totals.pii.tp += s.piiCounts.tp;
    totals.pii.fp += s.piiCounts.fp;
    totals.pii.fn += s.piiCounts.fn;
    if (s.expectNone) {
      decoys++;
      if (s.falsePositives.length > 0 || s.piiFalsePositives.length > 0) decoyFalsePositives++;
    }
    for (const l of s.leaks) {
      const entry = perMutation.get(l.mutation) ?? { total: 0, detected: 0 };
      entry.total++;
      if (l.detected) entry.detected++;
      perMutation.set(l.mutation, entry);
    }
  }
  const segAgg = f1(totals.seg.tp, totals.seg.fp, totals.seg.fn);
  const piiAgg = f1(totals.pii.tp, totals.pii.fp, totals.pii.fn);
  return {
    samples,
    segment: { ...totals.seg, tn: 0, ...segAgg },
    pii: { ...totals.pii, tn: 0, ...piiAgg },
    decoyFalsePositives,
    decoys,
    elapsedMs,
    perMutation: Object.fromEntries(perMutation),
  };
}
