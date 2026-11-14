/**
 * Salted-hash exact-data matching for customer lists.
 *
 * Privacy model: the vault stores only HMAC-SHA256(key, canonical(value))
 * for each field of each record. The plaintext never leaves the import step
 * (values are hashed as they are read). Matching re-derives the same HMAC
 * over candidate substrings of the outgoing document, so no plaintext
 * comparison is possible even if the vault leaks.
 *
 * Candidate enumeration is bounded by:
 *   - numeric fields (phone / id / account): maximal digit runs, exact
 *     allowed lengths -> punctuation inside a number is irrelevant
 *   - name / company: maximal letter runs, allowed lengths
 *   - email: raw-text regex, canonicalised
 */
import type {
  CustomerRecord,
  VaultEntry,
  PiiVault,
  PiiField,
  PiiMatch,
  DetectionConfig,
  DocumentText,
} from './types';
import {
  canonicalValue,
  mergeSpans,
  type CanonicalStream,
} from './normalize';
import { deriveVaultKey, keyedHash, randomSalt, toBase64, vaultCheckValue, uuid, fromBase64 } from './hash';

export const NUMERIC_FIELDS: PiiField[] = ['phone', 'idNumber', 'account'];
export const LETTER_FIELDS: PiiField[] = ['name', 'company'];

/** Field weights for scoring. */
export const FIELD_WEIGHT: Record<PiiField, number> = {
  name: 26,
  phone: 42,
  email: 38,
  idNumber: 55,
  company: 16,
  account: 46,
};

export const PII_HEADERS: Record<PiiField, string[]> = {
  name: ['姓名', '联系人', '客户联系人', 'name', 'contact'],
  phone: ['手机', '手机号', '电话', '联系电话', 'mobile', 'phone', 'tel'],
  email: ['邮箱', '电子邮箱', 'email', 'mail', 'e-mail'],
  idNumber: ['身份证', '身份证号', '证件号', 'id', 'idcard'],
  company: ['客户名称', '公司名称', '客户', 'company', 'customer'],
  account: ['账号', '银行账号', '收款账号', '卡号', 'account', 'bank'],
};

export function detectField(header: string): PiiField | null {
  const h = header.trim().toLowerCase();
  for (const [field, names] of Object.entries(PII_HEADERS) as [PiiField, string[]][]) {
    for (const name of names) {
      if (h === name.toLowerCase() || h.includes(name.toLowerCase())) return field;
    }
  }
  return null;
}

export type RawCustomerRecord = Partial<Record<PiiField, string>>;

export interface VaultCreateResult {
  vault: PiiVault;
  /** Field counts by record, for UI display. */
  recordCount: number;
  valueCount: number;
  skipped: { header: string; reason: string }[];
  /**
   * The vault's HMAC key. MUST NOT be persisted: persisting it next to the
   * hashes would make the salted hashes reversible by dictionary attack on
   * the stored data. Callers hold it in memory for the session only.
   */
  key: Uint8Array;
}

export interface VaultKeyOptions {
  /**
   * Passphrase-protected vaults derive the key with PBKDF2 so the vault can
   * be unlocked again; session vaults use a random in-memory key that is lost
   * on reload.
   */
  passphrase?: string;
  iterations?: number;
}

const DEFAULT_ITERATIONS = 310_000;

/**
 * Build a vault from parsed records. Hashing happens here; plaintext values
 * are not retained anywhere in the returned object.
 */
export function createVault(
  name: string,
  records: RawCustomerRecord[],
  options: VaultKeyOptions = {},
  ids?: string[],
): VaultCreateResult {
  const vaultId = uuid();
  const publicSalt = randomSalt(32);
  const keyMode: PiiVault['keyMode'] = options.passphrase ? 'passphrase' : 'session';
  const iterations = options.iterations ?? DEFAULT_ITERATIONS;
  const key = options.passphrase
    ? deriveVaultKey(options.passphrase, publicSalt, iterations)
    : randomSalt(32);
  const entries: VaultEntry[] = [];
  const outRecords: CustomerRecord[] = [];
  const lengths: Partial<Record<PiiField, Set<number>>> = {};
  const fieldCounts: Partial<Record<PiiField, number>> = {};
  let recordCount = 0;

  for (let i = 0; i < records.length; i++) {
    const raw = records[i];
    const record: CustomerRecord = {
      id: ids?.[i] ?? `R${String(i + 1).padStart(4, '0')}`,
      fields: [],
    };
    for (const field of Object.keys(raw) as PiiField[]) {
      const value = raw[field];
      if (!value) continue;
      const canonical = canonicalValue(value, field);
      if (canonical.length < 2) continue;
      entries.push({ h: keyedHash(key, `${field}:${canonical}`), recordId: record.id, field });
      record.fields.push(field);
      fieldCounts[field] = (fieldCounts[field] ?? 0) + 1;
      const set = lengths[field] ?? new Set<number>();
      set.add(canonical.length);
      lengths[field] = set;
    }
    if (record.fields.length > 0) {
      outRecords.push(record);
      recordCount++;
    }
  }

  const lengthsOut: Partial<Record<PiiField, number[]>> = {};
  for (const [field, set] of Object.entries(lengths) as [PiiField, Set<number>][]) {
    lengthsOut[field] = [...set].sort((a, b) => a - b);
  }

  const vault: PiiVault = {
    id: vaultId,
    name,
    createdAt: Date.now(),
    salt: toBase64(publicSalt),
    keyMode,
    iterations,
    keyCheck: vaultCheckValue(key, vaultId),
    records: outRecords,
    entries,
    lengths: lengthsOut,
    stats: { records: recordCount, values: entries.length, fields: fieldCounts },
  };
  return {
    vault,
    recordCount,
    valueCount: entries.length,
    skipped: [],
    key,
  };
}

/** Verify a passphrase against a stored vault and return its HMAC key. */
export function unlockVault(vault: PiiVault, passphrase: string): Uint8Array | null {
  const salt = fromBase64(vault.salt);
  const key = deriveVaultKey(passphrase, salt, vault.iterations || DEFAULT_ITERATIONS);
  if (vaultCheckValue(key, vault.id) !== vault.keyCheck) return null;
  return key;
}

export interface PreparedVault {
  vault: PiiVault;
  key: Uint8Array;
  /** hash -> entries */
  index: Map<string, VaultEntry[]>;
  /** per field: sorted allowed lengths */
  lengths: Partial<Record<PiiField, number[]>>;
  recordFields: Map<string, Set<PiiField>>;
}

export function prepareVault(vault: PiiVault, key: Uint8Array): PreparedVault {
  const index = new Map<string, VaultEntry[]>();
  for (const entry of vault.entries) {
    const arr = index.get(entry.h);
    if (arr) arr.push(entry);
    else index.set(entry.h, [entry]);
  }
  const recordFields = new Map<string, Set<PiiField>>();
  for (const record of vault.records) recordFields.set(record.id, new Set(record.fields));
  const lengths = { ...vault.lengths };
  return { vault, key, index, lengths, recordFields };
}

export interface PiiMatchOutput {
  matches: PiiMatch[];
  /** Per-record aggregation used for alerting. */
  groups: PiiGroup[];
}

export interface PiiGroup {
  recordId: string;
  fields: PiiField[];
  matches: PiiMatch[];
  /** Minimum character distance between any two matched fields. */
  minDistance: number;
  /** Score 0..100. */
  score: number;
  valueCount: number;
}

const DIGIT = /[0-9]/;
const LETTER = /[a-z一-鿿㐀-䶿]/;

function isDigitCode(c: number): boolean {
  return c >= 48 && c <= 57;
}

function isLetterCode(c: number): boolean {
  return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf);
}

/**
 * Enumerate numeric-field candidates.
 *
 * Candidate values are the *whole* maximal digit run, not arbitrary windows
 * inside it: an order number or invoice line that happens to contain a
 * customer's 11 digits in the middle must not match. The only exception is
 * an internationally-written number, where a leading country code 86 is
 * stripped and the remainder tried as a phone number.
 */
function scanNumericField(
  stream: CanonicalStream,
  field: PiiField,
  lengths: number[],
  prepared: PreparedVault,
  out: PiiMatch[],
): void {
  const codes = stream.codes;
  const n = codes.length;
  if (lengths.length === 0) return;

  const tryValue = (startIdx: number, length: number) => {
    const value = stream.chars.slice(startIdx, startIdx + length);
    const h = keyedHash(prepared.key, `${field}:${value}`);
    const hits = prepared.index.get(h);
    if (!hits) return;
    for (const hit of hits) {
      if (hit.field !== field) continue;
      out.push({
        recordId: hit.recordId,
        field,
        start: stream.rawStart[startIdx],
        end: stream.rawEnd[startIdx + length - 1],
        text: value,
      });
    }
  };

  let i = 0;
  while (i < n) {
    if (!isDigitCode(codes[i])) {
      i++;
      continue;
    }
    let end = i;
    while (end < n && isDigitCode(codes[end])) end++;
    const runLen = end - i;
    if (lengths.includes(runLen)) tryValue(i, runLen);
    // +86 form: "8613800138001" -> try the last 11 digits.
    if (
      field === 'phone' &&
      runLen === 13 &&
      stream.chars.slice(i, i + 2) === '86' &&
      lengths.includes(11)
    ) {
      tryValue(i + 2, 11);
    }
    i = end;
  }
}

function scanLetterField(
  stream: CanonicalStream,
  field: PiiField,
  lengths: number[],
  prepared: PreparedVault,
  out: PiiMatch[],
): void {
  const codes = stream.codes;
  const n = codes.length;
  if (lengths.length === 0) return;
  let i = 0;
  while (i < n) {
    if (!isLetterCode(codes[i])) {
      i++;
      continue;
    }
    let end = i;
    while (end < n && isLetterCode(codes[end])) end++;
    // Chinese prose has no spaces, so a run can be a whole paragraph. Hash
    // each allowed length at every offset within the run; the candidate set
    // stays small because the vault only knows a handful of lengths.
    for (const L of lengths) {
      if (L > end - i) continue;
      for (let s = i; s + L <= end; s++) {
        const value = stream.chars.slice(s, s + L);
        const h = keyedHash(prepared.key, `${field}:${value}`);
        const hits = prepared.index.get(h);
        if (!hits) continue;
        for (const hit of hits) {
          if (hit.field !== field) continue;
          out.push({
            recordId: hit.recordId,
            field,
            start: stream.rawStart[s],
            end: stream.rawEnd[s + L - 1],
            text: value,
          });
        }
      }
    }
    i = end;
  }
}

const EMAIL_RE = /[A-Za-z0-9][A-Za-z0-9._%+\-]*@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g;

function scanEmails(
  text: DocumentText,
  prepared: PreparedVault,
  out: PiiMatch[],
): void {
  // Match against raw text so that the regex sees '@' and dots.
  EMAIL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = EMAIL_RE.exec(text.raw)) !== null) {
    const value = canonicalValue(m[0], 'email');
    const h = keyedHash(prepared.key, `email:${value}`);
    const hits = prepared.index.get(h);
    if (!hits) continue;
    for (const hit of hits) {
      if (hit.field !== 'email') continue;
      out.push({ recordId: hit.recordId, field: 'email', start: m.index, end: m.index + m[0].length, text: m[0] });
    }
  }
}

/** Also try emails written with full-width characters or no dots. */
function scanEmailVariants(stream: CanonicalStream, prepared: PreparedVault, out: PiiMatch[]): void {
  const allowed = prepared.lengths.email;
  if (!allowed || allowed.length === 0) return;
  const codes = stream.codes;
  const n = codes.length;
  // Alphanumeric runs contain the canonical form of an email.
  let i = 0;
  while (i < n) {
    if (!isLetterCode(codes[i]) && !isDigitCode(codes[i])) {
      i++;
      continue;
    }
    let end = i;
    while (end < n && (isLetterCode(codes[end]) || isDigitCode(codes[end]))) end++;
    const runLen = end - i;
    for (const L of allowed) {
      if (L > runLen) continue;
      for (let s = i; s + L <= end; s++) {
        const value = stream.chars.slice(s, s + L);
        const h = keyedHash(prepared.key, `email:${value}`);
        const hits = prepared.index.get(h);
        if (!hits) continue;
        for (const hit of hits) {
          if (hit.field !== 'email') continue;
          const start = stream.rawStart[s];
          const stop = stream.rawEnd[s + L - 1];
          if (out.some((x) => x.field === 'email' && Math.abs(x.start - start) < 6)) continue;
          out.push({ recordId: hit.recordId, field: 'email', start, end: stop, text: stream.chars.slice(s, s + L) });
        }
      }
    }
    i = end;
  }
}

/**
 * Score a per-record group. Field weights sum, boosted for co-occurrence and
 * for records that appear multiple times.
 */
export function scoreGroup(group: Omit<PiiGroup, 'score'>): number {
  const n = group.fields.length;
  let base = 0;
  for (const f of group.fields) base += FIELD_WEIGHT[f];
  const comboBoost = n >= 2 ? 1.22 : 1;
  const repeatBoost = 1 + Math.min(0.15, 0.04 * (group.valueCount - n));
  const score = Math.min(100, base * comboBoost * repeatBoost);
  return Math.round(score * 10) / 10;
}

export function matchPii(
  text: DocumentText,
  stream: CanonicalStream,
  prepared: PreparedVault,
  _config: DetectionConfig,
): PiiMatchOutput {
  const matches: PiiMatch[] = [];
  for (const field of NUMERIC_FIELDS) {
    scanNumericField(stream, field, prepared.lengths[field] ?? [], prepared, matches);
  }
  for (const field of LETTER_FIELDS) {
    scanLetterField(stream, field, prepared.lengths[field] ?? [], prepared, matches);
  }
  if (prepared.lengths.email?.length) {
    scanEmails(text, prepared, matches);
    scanEmailVariants(stream, prepared, matches);
  }
  // Bound duplicate hits at the same location.
  const dedup = new Map<string, PiiMatch>();
  for (const m of matches) {
    const key = `${m.recordId}:${m.field}:${m.start}:${m.end}`;
    if (!dedup.has(key)) dedup.set(key, m);
  }
  const unique = [...dedup.values()].sort((a, b) => a.start - b.start);

  // Group by record and compute the field set + minimum distance.
  const byRecord = new Map<string, PiiMatch[]>();
  for (const m of unique) {
    const arr = byRecord.get(m.recordId);
    if (arr) arr.push(m);
    else byRecord.set(m.recordId, [m]);
  }
  const groups: PiiGroup[] = [];
  for (const [recordId, list] of byRecord) {
    const fields = [...new Set(list.map((m) => m.field))];
    let minDistance = Infinity;
    // Compare the first occurrence of each field.
    const firsts: PiiMatch[] = [];
    for (const f of fields) {
      const first = list.find((m) => m.field === f);
      if (first) firsts.push(first);
    }
    for (let i = 0; i < firsts.length; i++) {
      for (let j = i + 1; j < firsts.length; j++) {
        const a = firsts[i];
        const b = firsts[j];
        const d = a.start < b.start ? b.start - a.end : a.start - b.end;
        minDistance = Math.min(minDistance, Math.max(0, d));
      }
    }
    if (fields.length < 2) minDistance = 0;
    const base = {
      recordId,
      fields,
      matches: list,
      minDistance,
      valueCount: list.length,
    };
    groups.push({ ...base, score: scoreGroup(base) });
  }
  groups.sort((a, b) => b.score - a.score);
  return { matches: unique, groups };
}

/**
 * Co-location check: fields of the same form (e.g. a row in an exported
 * sheet) are far more suspicious than the same fields scattered 3 pages apart.
 */
export function groupSpans(matches: PiiMatch[]): { start: number; end: number }[] {
  return mergeSpans(matches, 2);
}

export function piiFieldLabel(field: PiiField): string {
  switch (field) {
    case 'name':
      return '姓名';
    case 'phone':
      return '手机号';
    case 'email':
      return '邮箱';
    case 'idNumber':
      return '身份证号';
    case 'company':
      return '公司名称';
    case 'account':
      return '银行账号';
  }
}

export function isDigitChar(ch: string): boolean {
  return DIGIT.test(ch);
}

export function isLetterChar(ch: string): boolean {
  return LETTER.test(ch.toLowerCase());
}
