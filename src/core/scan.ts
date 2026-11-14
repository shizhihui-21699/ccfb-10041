/**
 * Scan orchestration: parse -> tokenize -> fingerprints -> PII -> alerts.
 * Also builds the labeled evaluation used for calibration.
 */
import type {
  Alert,
  DocumentText,
  AlertSeverity,
  DetectionConfig,
  ParsedDocument,
  PiiField,
  PiiMatch,
  ScanResult,
  ScanStats,
  SegmentMatch,
  SuppressionState,
  FeedbackRecord,
  CalibrationResult,
  CalibrationPoint,
} from './types';
import { buildDocumentText, buildCanonicalStream } from './normalize';
import { matchSegments, type PreparedLibrary } from './fingerprint';
import { groupSpans, matchPii, piiFieldLabel, type PreparedVault, type PiiGroup } from './pii';
import { uuid } from './hash';
import { DEFAULT_CONFIG } from './types';

export interface ScanInput {
  parsed: ParsedDocument;
  library: PreparedLibrary | null;
  vault: PreparedVault | null;
  config: DetectionConfig;
  suppression: SuppressionState;
  /** For identical-file detection. */
  protectedHashes?: Map<string, { docId: string; docTitle: string }>;
  /**
   * Reuse an already-tokenised document instead of re-parsing blocks. Used
   * when re-scoring stored scans after a threshold change: the token stream
   * (and therefore the offsets) is identical, so alert positions stay valid.
   */
  existingText?: DocumentText;
}

function severityFor(
  score: number,
  config: DetectionConfig,
  hasExact: boolean,
): AlertSeverity {
  if (score >= config.criticalScore && hasExact) return 'critical';
  if (score >= config.highScore) return 'high';
  if (score >= config.minSegmentScore + 15) return 'medium';
  return 'low';
}

function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function segmentAlerts(
  matches: SegmentMatch[],
  config: DetectionConfig,
): Alert[] {
  const alerts: Alert[] = [];
  for (const m of matches) {
    const hasExact = m.exactCoverage >= 0.5 || m.evidence >= config.minEvidence;
    const severity = severityFor(m.score, config, hasExact);
    const kind =
      m.exactCoverage >= 0.9
        ? '整段照抄'
        : m.charOverlap >= 0.55
          ? '改写后照搬'
          : '部分摘录';
    alerts.push({
      id: uuid(),
      detector: 'segment',
      severity,
      score: m.score,
      title: `${kind}：与《${m.docTitle}》${m.location} 高度相似`,
      detail: `相似度 ${m.score.toFixed(1)}，覆盖 ${(m.exactCoverage * 100).toFixed(0)}%（${m.matchedTokens}/${m.segmentTokens} 个指纹令牌），字符重合 ${(m.charOverlap * 100).toFixed(0)}%`,
      docId: m.docId,
      docTitle: m.docTitle,
      segmentIndex: m.segmentIndex,
      spans: m.spans,
      evidenceHash: m.evidenceHash,
      suppressed: false,
    });
  }
  return alerts;
}

export function piiAlerts(
  groups: PiiGroup[],
  text: string,
  config: DetectionConfig,
): Alert[] {
  const alerts: Alert[] = [];
  for (const group of groups) {
    if (group.score < config.minPiiScore) continue;
    const fields = group.fields;
    const isCombo = fields.length >= config.piiComboFields;
    const proximityOk = !isCombo || group.minDistance <= config.piiProximity;
    if (isCombo && !proximityOk) continue;

    const label = fields.map(piiFieldLabel).join(' + ');
    const spans = groupSpans(group.matches).map((s) => ({
      start: s.start,
      end: s.end,
      text: text.slice(s.start, s.end),
    }));
    const recordIds = [group.recordId];
    const evidenceHash = shortHash(
      `pii:${recordIds.join(',')}:${fields.join(',')}:${spans.map((s) => `${s.start}-${s.end}`).join('|')}`,
    );
    const masked = group.matches
      .map((m) => `${piiFieldLabel(m.field)}=${maskValue(m.text, m.field)}`)
      .join('，');
    alerts.push({
      id: uuid(),
      detector: isCombo ? 'pii_combo' : 'pii_single',
      severity: isCombo
        ? group.score >= 90
          ? 'critical'
          : 'high'
        : group.score >= 80
          ? 'medium'
          : 'low',
      score: group.score,
      title: isCombo
        ? `客户数据组合命中：${label}（记录 ${group.recordId}）`
        : `客户数据命中：${label}（记录 ${group.recordId}）`,
      detail: `${masked}；字段距离 ${group.minDistance === 0 ? '—' : `${group.minDistance} 字符`}`,
      recordIds,
      fields,
      spans,
      evidenceHash,
      suppressed: false,
    });
  }
  return alerts;
}

/** Never render full PII in the alert list. */
export function maskValue(value: string, field: PiiField): string {
  if (field === 'phone' && value.length >= 7) {
    return `${value.slice(0, 3)}****${value.slice(-4)}`;
  }
  if (field === 'email') {
    const [local, domain] = value.split('@');
    const keep = Math.max(1, Math.min(2, Math.floor(local.length / 3)));
    return `${local.slice(0, keep)}***@${domain ?? ''}`;
  }
  if (field === 'account' || field === 'idNumber') {
    return `${value.slice(0, 4)}****${value.slice(-4)}`;
  }
  if (value.length <= 1) return '*';
  return `${value[0]}${'*'.repeat(Math.max(1, value.length - 2))}${value.length > 2 ? value[value.length - 1] : ''}`;
}

export function runScan(input: ScanInput): ScanResult {
  const t0 = performance.now();
  const { parsed, library, vault, config, suppression } = input;
  const text = input.existingText ?? buildDocumentText(parsed.blocks);
  const stream = buildCanonicalStream(text.tokens);
  const tParse = performance.now();

  const matches = library
    ? matchSegments(text, library, {
        config,
        suppressedEvidence: suppression.evidence,
        suppressedSegments: suppression.segments,
      })
    : { matches: [], suppressed: 0, candidateCount: 0, diagnostics: [] };
  const tMatch = performance.now();

  const pii = vault
    ? matchPii(text, stream, vault, config)
    : { matches: [] as PiiMatch[], groups: [] as PiiGroup[] };
  const tPii = performance.now();

  let alerts: Alert[] = [];
  alerts.push(...segmentAlerts(matches.matches, config));
  alerts.push(...piiAlerts(pii.groups, text.raw, config));

  const exact = input.protectedHashes?.get(parsed.sha256);
  if (exact) {
    alerts.push({
      id: uuid(),
      detector: 'file_copy',
      severity: 'critical',
      score: 100,
      title: `外发文件与受保护文档《${exact.docTitle}》内容完全一致`,
      detail: 'SHA-256 校验值相同，文件未经任何修改。',
      docId: exact.docId,
      docTitle: exact.docTitle,
      spans: [],
      evidenceHash: shortHash(`file:${parsed.sha256}`),
      suppressed: false,
    });
  }

  // File-level similarity: how much of the outgoing file is protected content.
  if (matches.matches.length > 0) {
    const byDoc = new Map<string, { title: string; segs: number[]; score: number }>();
    for (const m of matches.matches) {
      const entry = byDoc.get(m.docId) ?? { title: m.docTitle, segs: [], score: 0 };
      entry.segs.push(m.segmentIndex);
      entry.score = Math.max(entry.score, m.score);
      byDoc.set(m.docId, entry);
    }
    for (const [docId, entry] of byDoc) {
      if (entry.segs.length >= 3) {
        const score = Math.min(99, 55 + entry.segs.length * 5);
        alerts.push({
          id: uuid(),
          detector: 'file_similar',
          severity: 'high',
          score,
          title: `外发文件大面积复制《${entry.title}》，命中 ${entry.segs.length} 个段落`,
          detail: `命中段落：${entry.segs.map((i) => `第 ${i + 1} 段`).join('、')}`,
          docId,
          docTitle: entry.title,
          spans: [],
          evidenceHash: shortHash(`filesim:${docId}:${entry.segs.join(',')}`),
          suppressed: false,
        });
      }
    }
  }

  alerts = alerts.filter((a) => !isSuppressed(a, suppression));
  const suppressedCount =
    matches.suppressed +
    (pii.groups.length > 0 ? 0 : 0);

  const severityRank: Record<AlertSeverity, number> = { critical: 4, high: 3, medium: 2, low: 1 };
  alerts.sort((a, b) => severityRank[b.severity] - severityRank[a.severity] || b.score - a.score);

  const stats: ScanStats = {
    tokens: text.tokens.length,
    segments: text.segments.length,
    characters: text.raw.length,
    parseMs: Math.round(tParse - t0),
    matchMs: Math.round(tMatch - tParse),
    piiMs: Math.round(tPii - tMatch),
    totalMs: Math.round(tPii - t0),
  };

  return {
    id: uuid(),
    fileName: parsed.fileName,
    fileKind: parsed.kind,
    fileSha256: parsed.sha256,
    byteLength: parsed.byteLength,
    createdAt: Date.now(),
    text,
    exactFileMatch: exact,
    segmentMatches: matches.matches,
    piiMatches: pii.matches,
    alerts,
    suppressedCount,
    stats,
    warnings: parsed.warnings,
    notes: parsed.notes,
  };
}

function isSuppressed(alert: Alert, suppression: SuppressionState): boolean {
  if (suppression.evidence.has(alert.evidenceHash)) return true;
  if (
    alert.detector === 'segment' &&
    alert.docId !== undefined &&
    alert.segmentIndex !== undefined
  ) {
    if (suppression.segments.has(`${alert.docId}:${alert.segmentIndex}`)) return true;
  }
  return false;
}

export function buildSuppression(feedback: FeedbackRecord[]): SuppressionState {
  const evidence = new Set<string>();
  const segments = new Set<string>();
  for (const f of feedback) {
    if (f.label !== 'fp') continue;
    if (f.suppressEvidence) evidence.add(f.evidenceHash);
    if (f.suppressSegment && f.docId !== undefined && f.segmentIndex !== undefined) {
      segments.add(`${f.docId}:${f.segmentIndex}`);
    }
  }
  return { evidence, segments };
}

/**
 * Thresholds the calibration loop may propose. Only score thresholds are
 * calibrated: the overlap floors gate *candidate generation*, so no alert
 * score exists to regress against them.
 */
export const CALIBRATION_PARAMS = ['minSegmentScore', 'minPiiScore'] as const;
export type CalibrationParam = (typeof CALIBRATION_PARAMS)[number];

export function calibrate(
  feedback: FeedbackRecord[],
  detector: Alert['detector'],
  param: CalibrationParam,
  current: number,
): CalibrationResult {
  const resolved = feedback.filter(
    (f) => f.detector === detector && Number.isFinite(f.score),
  );
  const curve: CalibrationPoint[] = [];
  let best: CalibrationPoint | null = null;
  for (let t = 0; t <= 100; t += 1) {
    let tp = 0;
    let fn = 0;
    let fp = 0;
    let tn = 0;
    for (const f of resolved) {
      const fires = f.score >= t;
      if (f.label === 'tp') {
        if (fires) tp++;
        else fn++;
      } else if (fires) {
        fp++;
      } else {
        tn++;
      }
    }
    const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
    const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
    const point: CalibrationPoint = { threshold: t, tp, fp, fn, tn, precision, recall, f1 };
    curve.push(point);
    // Maximise F1; among equal-F1 thresholds prefer the *lowest*, i.e. the
    // most inclusive one that still achieves the best separation. This keeps
    // confirmed leaks above the line instead of pushing the threshold to 100
    // where nothing can ever fire.
    if (resolved.length > 0 && (!best || f1 > best.f1 + 1e-9)) {
      best = point;
    }
  }
  const positives = resolved.filter((f) => f.label === 'tp').length;
  const negatives = resolved.filter((f) => f.label === 'fp').length;
  void param;
  return {
    detector,
    samples: resolved.length,
    positives,
    negatives,
    currentThreshold: current,
    suggestedThreshold: best && positives > 0 && negatives > 0 ? best.threshold : null,
    expected: curve.find((p) => p.threshold === Math.round(current)) ?? null,
    curve,
  };
}

export function configFromFeedback(
  config: DetectionConfig,
  feedback: FeedbackRecord[],
): DetectionConfig {
  const next: DetectionConfig = { ...config };
  for (const param of CALIBRATION_PARAMS) {
    const detector: Alert['detector'] =
      param === 'minPiiScore' ? 'pii_combo' : 'segment';
    const calibration = calibrate(feedback, detector, param, config[param]);
    if (calibration.suggestedThreshold !== null && calibration.samples >= 4) {
      next[param] = Math.min(100, calibration.suggestedThreshold);
    }
  }
  return next;
}

export { DEFAULT_CONFIG };
