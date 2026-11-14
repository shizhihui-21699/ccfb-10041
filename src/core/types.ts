/**
 * Shared types for the leak-detection engine.
 *
 * Everything here runs locally in the browser. No document text is ever sent
 * anywhere by this application.
 */

export type SourceKind = 'docx' | 'xlsx' | 'pdf' | 'txt' | 'md' | 'csv';

export interface ParsedBlock {
  /** Raw text of a paragraph / table row / line. */
  text: string;
  /** Where the block came from, e.g. "段落 12", "Sheet1!行 8", "第 3 页". */
  location: string;
  /** Optional structural kind, used for display only. */
  kind?: 'heading' | 'paragraph' | 'row' | 'line' | 'cell';
}

export interface ParsedDocument {
  /** Original file name. */
  fileName: string;
  kind: SourceKind;
  blocks: ParsedBlock[];
  /** Byte length of the original file. */
  byteLength: number;
  sha256: string;
  /** Parser warnings that mean content could not be fully read. */
  warnings: string[];
  /** Informational parser output (page/block counts), shown as neutral. */
  notes: string[];
}

export interface Token {
  /** Normalized token text used for matching. */
  text: string;
  /** 32-bit token id (FNV-1a of text). */
  id: number;
  /** Offsets into DocumentText.raw. */
  start: number;
  end: number;
}

export interface Segment {
  /** Index inside the source document. */
  index: number;
  /** Human readable location ("段落 3"). */
  location: string;
  /** Offsets into DocumentText.raw. */
  start: number;
  end: number;
  tokenStart: number;
  tokenEnd: number;
}

export interface DocumentText {
  raw: string;
  tokens: Token[];
  segments: Segment[];
  /**
   * For every token, the segment index that contains it. -1 for tokens that
   * fall between segments (joining newlines etc, which produce no tokens).
   */
  tokenSegment: Int32Array;
}

export interface Fingerprint {
  /** 16 hex chars (64 bit). */
  h: string;
  docId: string;
  segIdx: number;
  tokenStart: number;
  tokenEnd: number;
}

export type FingerprintKind = 'sequential' | 'unordered';

export interface ProtectedDocument {
  id: string;
  title: string;
  kind: SourceKind;
  fileName: string;
  sha256: string;
  addedAt: number;
  text: DocumentText;
  /** Number of segments, denormalised for cheap UI rendering. */
  segmentCount: number;
  tokenCount: number;
  /**
   * True when the document is held only as salted hashes (customer lists).
   * Such documents are never fingerprinted: no token hashes of their content
   * exist anywhere, and matching goes exclusively through the PII vault.
   */
  piiOnly?: boolean;
  owner?: string;
  classification?: string;
}

export interface SegmentFingerprintSet {
  docId: string;
  sequential: Fingerprint[];
  unordered: Fingerprint[];
}

export interface FingerprintLibrary {
  docs: ProtectedDocument[];
  /** All fingerprints, keyed by hash for lookup. */
  sequentialIndex: Map<string, Fingerprint[]>;
  unorderedIndex: Map<string, Fingerprint[]>;
  /** Token -> number of documents containing it (for IDF). */
  tokenDf: Map<number, number>;
  docCount: number;
}

export type PiiField =
  | 'name'
  | 'phone'
  | 'email'
  | 'idNumber'
  | 'company'
  | 'account';

export const PII_FIELD_LABELS: Record<PiiField, string> = {
  name: '姓名',
  phone: '手机号',
  email: '邮箱',
  idNumber: '身份证号',
  company: '公司名称',
  account: '银行账号',
};

export interface CustomerRecord {
  /** Opaque id; the plaintext record is never stored after vault creation. */
  id: string;
  /** Field presence is needed for combination alerts (no plaintext values). */
  fields: PiiField[];
}

export interface VaultEntry {
  h: string;
  recordId: string;
  field: PiiField;
}

export interface PiiVault {
  id: string;
  name: string;
  createdAt: number;
  /**
   * Public random salt (base64). In passphrase mode it feeds PBKDF2 to derive
   * the HMAC key; in session mode it is unused. It is safe to persist.
   */
  salt: string;
  /**
   * How the HMAC key is obtained.
   *  - 'passphrase': key = PBKDF2(passphrase, salt). The vault can be unlocked
   *    again after a reload by re-entering the passphrase.
   *  - 'session': key is random and held in memory only. The vault is unusable
   *    after a reload until the list is imported again.
   */
  keyMode: 'passphrase' | 'session';
  /** PBKDF2 iteration count for passphrase mode. */
  iterations: number;
  /** HMAC(key, "vault-check:<id>") so a wrong passphrase is detected. */
  keyCheck: string;
  records: CustomerRecord[];
  entries: VaultEntry[];
  /** Distinct value lengths per field, used to enumerate candidates. */
  lengths: Partial<Record<PiiField, number[]>>;
  stats: { records: number; values: number; fields: Partial<Record<PiiField, number>> };
}

export interface PiiMatch {
  recordId: string;
  field: PiiField;
  /** Offset of the matched value in the scanned raw text. */
  start: number;
  end: number;
  text: string;
}

export interface AlertEvidenceSpan {
  /** Offsets into the scanned document raw text. */
  start: number;
  end: number;
  text: string;
}

export interface SegmentMatch {
  docId: string;
  docTitle: string;
  segmentIndex: number;
  location: string;
  /** 0..100 final confidence. */
  score: number;
  /** Protected segment token coverage by exact fingerprints. */
  exactCoverage: number;
  /** IDF weighted multiset overlap between outgoing block and the segment. */
  overlap: number;
  /** Number of distinct matched fingerprints. */
  evidence: number;
  /** 0..1, how specific the matched fingerprints are. */
  idfNorm: number;
  /** 0..1 IDF-weighted trigram containment (order-insensitive). */
  trigramCoverage: number;
  /** 0..1 IDF-weighted char-bigram containment (punctuation-free). */
  charOverlap: number;
  /** 0..1 IDF-weighted char-unigram containment (paraphrase signal). */
  unigramOverlap: number;
  /** 0..1 table-cell bag overlap (order-insensitive rows). */
  cellOverlap: number;
  /** 0..1 overlap of distinctive numeric literals. */
  numberOverlap: number;
  /** Length of the longest verbatim canonical-character run. */
  lcsChars: number;
  /** 0..1 longest-run ratio (normalised against the shorter segment). */
  lcsRatio: number;
  matchedTokens: number;
  segmentTokens: number;
  /** Outgoing evidence spans, merged. */
  spans: AlertEvidenceSpan[];
  /** Offset into the scanned raw text of the best matching outgoing block. */
  outStart: number;
  outEnd: number;
  /** The protected segment's text, for side-by-side review. */
  sourceText: string;
  /** Stable key of the evidence, used for suppression feedback. */
  evidenceHash: string;
}

export type AlertSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface Alert {
  id: string;
  detector: 'segment' | 'pii_single' | 'pii_combo' | 'file_copy' | 'file_similar';
  severity: AlertSeverity;
  score: number;
  title: string;
  detail: string;
  docId?: string;
  docTitle?: string;
  segmentIndex?: number;
  recordIds?: string[];
  fields?: PiiField[];
  spans: AlertEvidenceSpan[];
  evidenceHash: string;
  /** If true, the user (or a saved suppression) already marked this FP. */
  suppressed: boolean;
  suppressReason?: string;
}

export interface ScanStats {
  tokens: number;
  segments: number;
  characters: number;
  parseMs: number;
  matchMs: number;
  piiMs: number;
  totalMs: number;
}

export interface ScanResult {
  id: string;
  fileName: string;
  fileKind: SourceKind;
  fileSha256: string;
  byteLength: number;
  createdAt: number;
  text: DocumentText;
  exactFileMatch?: { docId: string; docTitle: string };
  segmentMatches: SegmentMatch[];
  piiMatches: PiiMatch[];
  alerts: Alert[];
  suppressedCount: number;
  stats: ScanStats;
  warnings: string[];
  /** Informational parser output (page/row counts). */
  notes: string[];
}

export interface DetectionConfig {
  /** contiguous token window for exact-copy fingerprints. */
  seqK: number;
  /** unordered bag window length. */
  bagWindow: number;
  /** unordered bag stride. */
  bagStride: number;
  /** minimum score to raise a segment alert. */
  minSegmentScore: number;
  /** minimum exact fingerprint coverage OR weighted overlap to consider a hit. */
  minSegmentCoverage: number;
  minOverlap: number;
  /** minimum char-bigram containment (punctuation/whitespace free). */
  minCharOverlap: number;
  /** minimum number of distinct matched fingerprints. */
  minEvidence: number;
  /** 0..1 weight of specificity (IDF) in the score. */
  idfWeight: number;
  /** raise a combination alert when this many distinct fields co-occur. */
  piiComboFields: number;
  /** character distance for co-occurrence. */
  piiProximity: number;
  /** minimum score for a single-field PII alert (0-100). */
  minPiiScore: number;
  /** minimum score to escalate a segment hit to high/critical. */
  highScore: number;
  criticalScore: number;
}

export const DEFAULT_CONFIG: DetectionConfig = {
  seqK: 8,
  bagWindow: 8,
  bagStride: 2,
  minSegmentScore: 45,
  minSegmentCoverage: 0.1,
  minOverlap: 0.34,
  minCharOverlap: 0.3,
  minEvidence: 3,
  idfWeight: 0.7,
  piiComboFields: 2,
  piiProximity: 160,
  minPiiScore: 55,
  highScore: 70,
  criticalScore: 88,
};

export interface FeedbackRecord {
  id: string;
  createdAt: number;
  detector: Alert['detector'];
  /** 'fp' = 误报, 'tp' = 确认泄露. */
  label: 'fp' | 'tp';
  score: number;
  alertTitle: string;
  evidenceHash: string;
  docId?: string;
  segmentIndex?: number;
  note?: string;
  /** When true, identical evidence is suppressed in future scans. */
  suppressEvidence: boolean;
  /** When true, the whole source segment is excluded in future scans. */
  suppressSegment: boolean;
}

export interface SuppressionState {
  evidence: Set<string>;
  segments: Set<string>; // `${docId}:${segmentIndex}`
}

export interface CalibrationPoint {
  threshold: number;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  precision: number;
  recall: number;
  f1: number;
}

export interface CalibrationResult {
  detector: Alert['detector'];
  samples: number;
  positives: number;
  negatives: number;
  currentThreshold: number;
  suggestedThreshold: number | null;
  expected: CalibrationPoint | null;
  curve: CalibrationPoint[];
}
