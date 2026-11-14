import { describe, expect, it } from 'vitest';
import { buildDocumentText } from '../src/core/normalize';
import { buildLibrary } from '../src/core/fingerprint';
import { runScan, buildSuppression, calibrate, configFromFeedback } from '../src/core/scan';
import { createVault, prepareVault } from '../src/core/pii';
import { DEFAULT_CONFIG, type FeedbackRecord, type ProtectedDocument, type PiiVault } from '../src/core/types';

const PARA =
  '本次交易的标的为星源新材料有限公司100%股权，交易对价暂定为人民币4.8亿元，其中现金支付3.1亿元，股份支付1.7亿元。';
const PARA2 =
  '交割条件包括：反垄断审查通过、核心技术人员签署竞业限制协议、标的公司完成3项历史关联交易的清理。';

function doc(id: string, blocks: string[]): ProtectedDocument {
  const text = buildDocumentText(blocks.map((t, i) => ({ text: t, location: `段落 ${i + 1}` })));
  return {
    id,
    title: `文档 ${id}`,
    kind: 'txt',
    fileName: `${id}.txt`,
    sha256: id,
    addedAt: 0,
    text,
    segmentCount: text.segments.length,
    tokenCount: text.tokens.length,
  };
}

const docs = [doc('A', [PARA, PARA2])];
const library = buildLibrary(docs, DEFAULT_CONFIG);

function makeVault(): { vault: PiiVault; key: Uint8Array } {
  const { vault, key } = createVault('名单', [
    { name: '陈国栋', phone: '13800138001', company: '江海新能源科技有限公司' },
  ]);
  return { vault, key };
}

function scanText(text: string, suppressionFeedback: FeedbackRecord[] = [], withPii = false) {
  const parsed = {
    fileName: 'x.txt',
    kind: 'txt' as const,
    blocks: [{ text, location: '第 1 行' }],
    byteLength: text.length,
    sha256: 'scan',
    warnings: [],
    notes: [],
  };
  const vault = withPii ? makeVault() : null;
  return runScan({
    parsed,
    library,
    vault: vault ? prepareVault(vault.vault, vault.key) : null,
    config: DEFAULT_CONFIG,
    suppression: buildSuppression(suppressionFeedback),
    protectedHashes: new Map(docs.map((d) => [d.sha256, { docId: d.id, docTitle: d.title }])),
  });
}

const fb = (over: Partial<FeedbackRecord>): FeedbackRecord => ({
  id: Math.random().toString(36).slice(2),
  createdAt: 0,
  detector: 'segment',
  label: 'fp',
  score: 50,
  alertTitle: 'x',
  evidenceHash: 'h',
  suppressEvidence: false,
  suppressSegment: false,
  ...over,
});

describe('scan orchestration', () => {
  it('produces a segment alert for a copied paragraph', () => {
    const result = scanText(PARA);
    expect(result.alerts.length).toBeGreaterThan(0);
    const alert = result.alerts.find((a) => a.detector === 'segment');
    expect(alert).toBeDefined();
    expect(alert!.severity).toBe('critical');
    expect(alert!.spans.length).toBeGreaterThan(0);
  });

  it('produces no alerts for an unrelated file', () => {
    const result = scanText('今天下午三点在三楼会议室召开部门周会，请各组长准备本周工作汇报材料。');
    expect(result.alerts).toHaveLength(0);
  });

  it('flags the whole file when the hash matches a protected document', () => {
    const result = runScan({
      parsed: {
        fileName: 'copy.txt',
        kind: 'txt',
        blocks: [{ text: PARA, location: 'l1' }],
        byteLength: 1,
        sha256: 'A',
        warnings: [],
        notes: [],
      },
      library,
      vault: null,
      config: DEFAULT_CONFIG,
      suppression: { evidence: new Set(), segments: new Set() },
      protectedHashes: new Map([['A', { docId: 'A', docTitle: '文档 A' }]]),
    });
    expect(result.exactFileMatch).toBeDefined();
    expect(result.alerts.some((a) => a.detector === 'file_copy')).toBe(true);
  });

  it('raises a file-level alert when many segments are copied', () => {
    const paragraphs = [
      PARA,
      PARA2,
      '风险提示：标的公司2024年度营业收入较上年下降7.6%，主要客户集中度较高，前五大客户合计贡献收入的68.3%。',
    ];
    const result = runScan({
      parsed: {
        fileName: 'x.txt',
        kind: 'txt',
        blocks: paragraphs.map((t, i) => ({ text: t, location: `第 ${i + 1} 行` })),
        byteLength: 1,
        sha256: 'scan',
        warnings: [],
        notes: [],
      },
      library: buildLibrary(
        [doc('A', [...paragraphs])],
        DEFAULT_CONFIG,
      ),
      vault: null,
      config: DEFAULT_CONFIG,
      suppression: { evidence: new Set(), segments: new Set() },
    });
    const fileAlert = result.alerts.find((a) => a.detector === 'file_similar');
    expect(fileAlert).toBeDefined();
    expect(fileAlert!.detail).toContain('第 1 段');
  });

  it('suppresses alerts whose evidence the reviewer marked as a false positive', () => {
    const before = scanText(PARA);
    const target = before.alerts.find((a) => a.detector === 'segment')!;
    const after = scanText(PARA, [
      fb({ evidenceHash: target.evidenceHash, suppressEvidence: true }),
    ]);
    expect(after.alerts.some((a) => a.evidenceHash === target.evidenceHash)).toBe(false);
    expect(after.suppressedCount).toBeGreaterThan(0);
  });

  it('suppresses a whole source segment when requested', () => {
    const before = scanText(PARA);
    const target = before.alerts.find((a) => a.detector === 'segment')!;
    const after = scanText(PARA, [
      fb({
        evidenceHash: target.evidenceHash,
        docId: target.docId,
        segmentIndex: target.segmentIndex,
        suppressSegment: true,
      }),
    ]);
    expect(after.segmentMatches.find((m) => m.segmentIndex === target.segmentIndex)).toBeUndefined();
  });

  it('does not suppress anything for a confirmed (tp) label', () => {
    const before = scanText(PARA);
    const target = before.alerts.find((a) => a.detector === 'segment')!;
    const after = scanText(PARA, [
      fb({ evidenceHash: target.evidenceHash, label: 'tp', suppressEvidence: true }),
    ]);
    expect(after.alerts.some((a) => a.evidenceHash === target.evidenceHash)).toBe(true);
  });

  it('records PII alerts with masked values only', () => {
    const result = scanText('联系人陈国栋，电话13800138001。', [], true);
    const alert = result.alerts.find((a) => a.detector === 'pii_combo');
    expect(alert).toBeDefined();
    expect(alert!.detail).not.toContain('13800138001');
    expect(alert!.detail).toContain('138****8001');
  });

  it('records scan statistics', () => {
    const result = scanText(PARA);
    expect(result.stats.tokens).toBeGreaterThan(0);
    expect(result.stats.totalMs).toBeGreaterThanOrEqual(0);
    expect(result.text.segments.length).toBe(1);
  });

  it('reuses an existing token stream when re-scoring', () => {
    const first = scanText(PARA);
    const rescored = runScan({
      parsed: {
        fileName: 'x.txt',
        kind: 'txt',
        blocks: [],
        byteLength: 1,
        sha256: 'scan',
        warnings: [],
        notes: [],
      },
      library,
      vault: null,
      // Above the maximum reachable score, so every segment alert is dropped.
      config: { ...DEFAULT_CONFIG, minSegmentScore: 100.1 },
      suppression: { evidence: new Set(), segments: new Set() },
      existingText: first.text,
    });
    expect(rescored.text.raw).toBe(first.text.raw);
    expect(rescored.text.tokens.length).toBe(first.text.tokens.length);
    expect(rescored.alerts.filter((a) => a.detector === 'segment')).toHaveLength(0);
  });

  it('handles a scan with no library and no vault', () => {
    const result = runScan({
      parsed: {
        fileName: 'x.txt',
        kind: 'txt',
        blocks: [{ text: PARA, location: 'l1' }],
        byteLength: 1,
        sha256: 'x',
        warnings: [],
        notes: [],
      },
      library: null,
      vault: null,
      config: DEFAULT_CONFIG,
      suppression: { evidence: new Set(), segments: new Set() },
    });
    expect(result.alerts).toHaveLength(0);
    expect(result.text.tokens.length).toBeGreaterThan(0);
  });
});

describe('calibration', () => {
  const labeled: FeedbackRecord[] = [
    fb({ label: 'tp', score: 80, evidenceHash: 'a' }),
    fb({ label: 'tp', score: 75, evidenceHash: 'b' }),
    fb({ label: 'tp', score: 60, evidenceHash: 'c' }),
    fb({ label: 'fp', score: 55, evidenceHash: 'd' }),
    fb({ label: 'fp', score: 48, evidenceHash: 'e' }),
    fb({ label: 'fp', score: 70, evidenceHash: 'f' }),
  ];

  it('computes a curve over the labelled scores', () => {
    const cal = calibrate(labeled, 'segment', 'minSegmentScore', 45);
    expect(cal.samples).toBe(6);
    expect(cal.positives).toBe(3);
    expect(cal.negatives).toBe(3);
    expect(cal.curve.length).toBe(101);
  });

  it('suggests a threshold that separates the labelled sets', () => {
    const cal = calibrate(labeled, 'segment', 'minSegmentScore', 45);
    expect(cal.suggestedThreshold).not.toBeNull();
    const bestF1 = Math.max(...cal.curve.map((p) => p.f1));
    const chosen = cal.curve.find((p) => p.threshold === cal.suggestedThreshold)!;
    expect(chosen.f1).toBeCloseTo(bestF1, 9);
    // Ties go to the *lowest* threshold achieving the best F1, so confirmed
    // leaks are not needlessly excluded and the suggestion never becomes a
    // value that can never fire (100).
    expect(chosen.threshold).toBeLessThan(100);
    expect(chosen.recall + chosen.precision).toBeGreaterThan(1.5);
    // With this overlapping sample set, 56 is the best achievable split:
    // all three confirmed leaks kept, one FP still above the line.
    expect(chosen.threshold).toBe(56);
  });

  it('reports no suggestion when only one class is present', () => {
    const cal = calibrate([fb({ label: 'fp', score: 50 })], 'segment', 'minSegmentScore', 45);
    expect(cal.suggestedThreshold).toBeNull();
  });

  it('ignores feedback for other detectors', () => {
    const cal = calibrate(
      [...labeled, fb({ detector: 'pii_combo', label: 'fp', score: 10 })],
      'segment',
      'minSegmentScore',
      45,
    );
    expect(cal.samples).toBe(6);
  });

  it('derives a config from feedback without touching unlabelled parameters', () => {
    const next = configFromFeedback(DEFAULT_CONFIG, labeled);
    expect(next.minSegmentScore).not.toBe(DEFAULT_CONFIG.minSegmentScore);
    expect(next.seqK).toBe(DEFAULT_CONFIG.seqK);
    expect(next.piiComboFields).toBe(DEFAULT_CONFIG.piiComboFields);
  });

  it('leaves defaults untouched when there is not enough feedback', () => {
    const next = configFromFeedback(DEFAULT_CONFIG, [fb({ label: 'fp', score: 50 })]);
    expect(next.minSegmentScore).toBe(DEFAULT_CONFIG.minSegmentScore);
  });
});
