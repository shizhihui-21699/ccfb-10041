import { describe, expect, it } from 'vitest';
import { buildDocumentText } from '../src/core/normalize';
import { buildLibrary, matchSegments, segmentKey } from '../src/core/fingerprint';
import { DEFAULT_CONFIG, type DetectionConfig, type ProtectedDocument } from '../src/core/types';
import { bagFingerprintOf, fingerprintOf, hashToken } from '../src/core/hash';

const cfg: DetectionConfig = { ...DEFAULT_CONFIG };

export function doc(id: string, title: string, blocks: string[]): ProtectedDocument {
  const text = buildDocumentText(blocks.map((t, i) => ({ text: t, location: `段落 ${i + 1}` })));
  return {
    id,
    title,
    kind: 'txt',
    fileName: `${id}.txt`,
    sha256: id,
    addedAt: 0,
    text,
    segmentCount: text.segments.length,
    tokenCount: text.tokens.length,
  };
}

function scanOne(text: string) {
  const scanned = buildDocumentText([{ text, location: 'line' }]);
  return matchSegments(scanned, library, {
    config: cfg,
    suppressedEvidence: new Set(),
    suppressedSegments: new Set(),
    diagnostics: true,
  });
}

const PARA_DEAL =
  '本次交易的标的为星源新材料有限公司100%股权，交易对价暂定为人民币4.8亿元，其中现金支付3.1亿元，股份支付1.7亿元。双方约定以2025年度经审计的扣非净利润为基准，按12.5倍市盈率进行估值调整。';
const PARA_CLOSE =
  '交割条件包括：反垄断审查通过、核心技术人员签署签署竞业限制协议、标的公司完成3项历史关联交易的清理，且不存在未披露的对外担保。';
const PARA_RISK =
  '风险提示：标的公司2024年度营业收入较上年下降7.6%，主要客户集中度较高，前五大客户合计贡献收入的68.3%，存在客户流失导致的业绩下滑风险。';
const PARA_NDA =
  '本协议自双方授权代表签字并加盖公章之日起生效，有效期为三年。任何一方违反本协议约定，应向守约方支付违约金人民币500万元。';

const library = buildLibrary(
  [
    doc('MA', '并购交易备忘录', [PARA_DEAL, PARA_CLOSE, PARA_RISK]),
    doc('NDA', '保密协议', [PARA_NDA]),
  ],
  cfg,
);

describe('fingerprints', () => {
  const ids = Uint32Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  it('is deterministic and length-sensitive', () => {
    expect(fingerprintOf(ids, 0, 8)).toBe(fingerprintOf(ids, 0, 8));
    expect(fingerprintOf(ids, 0, 8)).not.toBe(fingerprintOf(ids, 1, 8));
    expect(fingerprintOf(ids, 0, 8)).not.toBe(fingerprintOf(ids, 0, 7));
  });
  it('bag fingerprints ignore in-window order', () => {
    const a = Uint32Array.from([9, 3, 7, 1, 5, 2, 8, 4]);
    const b = Uint32Array.from([1, 2, 3, 4, 5, 7, 8, 9]);
    expect(bagFingerprintOf(a, 0, 8)).toBe(bagFingerprintOf(b, 0, 8));
    expect(fingerprintOf(a, 0, 8)).not.toBe(fingerprintOf(b, 0, 8));
  });
  it('produces 64-bit hex ids', () => {
    expect(fingerprintOf(ids, 0, 8)).toMatch(/^[0-9a-f]{16}$/);
  });
  it('different tokens hash differently', () => {
    expect(hashToken('星源')).not.toBe(hashToken('星原'));
  });
});

describe('segment matching', () => {
  it('detects a verbatim copy with near-max score', () => {
    const out = scanOne(PARA_DEAL);
    const hit = out.matches.find((m) => m.docId === 'MA' && m.segmentIndex === 0);
    expect(hit).toBeDefined();
    expect(hit!.score).toBeGreaterThan(90);
    expect(hit!.exactCoverage).toBeCloseTo(1, 2);
  });

  it('detects punctuation and full-width character edits', () => {
    const edited = PARA_DEAL.replace(/，/g, ',')
      .replace(/。/g, '.')
      .replace(/：/g, ':')
      .replace(/￥/g, '¥');
    const out = scanOne(edited);
    const hit = out.matches.find((m) => m.segmentIndex === 0);
    expect(hit).toBeDefined();
    expect(hit!.score).toBeGreaterThan(90);
  });

  it('detects reordered clauses', () => {
    const reordered =
      '交割条件包括：标的公司完成3项历史关联交易的清理，核心技术人员签署签署竞业限制协议，反垄断审查通过，且不存在未披露的对外担保。';
    const out = scanOne(reordered);
    const hit = out.matches.find((m) => m.docId === 'MA' && m.segmentIndex === 1);
    expect(hit).toBeDefined();
    expect(hit!.score).toBeGreaterThan(60);
  });

  it('detects a truncated excerpt', () => {
    const excerpt =
      '标的公司2024年度营业收入较上年下降7.6%，主要客户集中度较高，前五大客户合计贡献收入的68.3%';
    const out = scanOne(excerpt);
    const hit = out.matches.find((m) => m.segmentIndex === 2);
    expect(hit).toBeDefined();
    expect(hit!.score).toBeGreaterThan(60);
  });

  it('detects a rewrite that keeps the facts but changes wording', () => {
    const rewritten =
      '本次交易拟收购星源新材料有限公司全部股权，交易对价暂定4.8亿元人民币，现金支付3.1亿元，股份支付1.7亿元，并以2025年扣非净利润为基准按12.5倍市盈率调整估值。';
    const out = scanOne(rewritten);
    const hit = out.matches.find((m) => m.segmentIndex === 0);
    expect(hit).toBeDefined();
    expect(hit!.score).toBeGreaterThan(60);
  });

  /**
   * Known limit, asserted so it cannot regress silently: if a rewrite also
   * converts the figures to Chinese numerals ("4.8亿" -> "四点八亿") and
   * rephrases every phrase, no verbatim run survives, so there is nothing
   * left to match on. The tool reports this as "未发现" rather than guessing.
   */
  it('does not fire when every phrase AND every numeral is rewritten', () => {
    const fullyRewritten =
      '交易的标的资产是星源新材料公司的全部股权，暂定对价为四点八亿元，其中以现金方式支付三点一亿元，股份支付一点七亿元。';
    const out = scanOne(fullyRewritten);
    expect(out.matches).toHaveLength(0);
  });

  it('does not fire on same-topic text with no copied wording', () => {
    const decoy =
      '关于股权收购的估值方法，通常采用市盈率法，以经审计的扣非净利润为基准，并结合标的公司未来三年的业绩承诺进行调整。';
    const out = scanOne(decoy);
    expect(out.matches).toHaveLength(0);
  });

  it('does not fire on unrelated text', () => {
    const out = scanOne('今天下午三点在三楼会议室召开部门周会，请各组长准备本周工作汇报材料。');
    expect(out.matches).toHaveLength(0);
  });

  it('does not fire on a short heading that merely appears in a segment', () => {
    const out = scanOne('风险提示');
    expect(out.matches).toHaveLength(0);
  });

  it('reports evidence spans that slice back to the outgoing text', () => {
    const source = `前置说明。\n${PARA_DEAL}\n后置说明。`;
    const out = scanOne(source);
    const hit = out.matches.find((m) => m.segmentIndex === 0)!;
    expect(hit.spans.length).toBeGreaterThan(0);
    const scanned = buildDocumentText([{ text: source, location: 'line' }]);
    for (const span of hit.spans) {
      expect(span.end).toBeGreaterThan(span.start);
      expect(scanned.raw.slice(span.start, span.end).length).toBeGreaterThan(0);
    }
  });

  it('scores the best segment highest when several are present', () => {
    const out = scanOne(`${PARA_DEAL}\n${PARA_RISK}`);
    expect(out.matches[0].segmentIndex).toBe(0);
    expect(out.matches.some((m) => m.segmentIndex === 2)).toBe(true);
  });

  it('respects evidence suppression for repeated false positives', () => {
    const first = scanOne(PARA_DEAL);
    const hit = first.matches[0];
    const suppressed = matchSegments(
      buildDocumentText([{ text: PARA_DEAL, location: 'line' }]),
      library,
      {
        config: cfg,
        suppressedEvidence: new Set([hit.evidenceHash]),
        suppressedSegments: new Set(),
      },
    );
    expect(suppressed.matches).toHaveLength(0);
    expect(suppressed.suppressed).toBeGreaterThan(0);
  });

  it('respects whole-segment suppression', () => {
    const suppressed = matchSegments(
      buildDocumentText([{ text: PARA_DEAL, location: 'line' }]),
      library,
      {
        config: cfg,
        suppressedEvidence: new Set(),
        suppressedSegments: new Set([segmentKey('MA', 0)]),
      },
    );
    expect(suppressed.matches.find((m) => m.docId === 'MA' && m.segmentIndex === 0)).toBeUndefined();
  });

  it('excludes piiOnly documents from the fingerprint index', () => {
    const vaultDoc = doc('CUST', '客户名单', [
      '客户名称 | 联系人 | 手机\n江海新能源科技有限公司 | 陈国栋 | 13800138001',
    ]);
    vaultDoc.piiOnly = true;
    const lib = buildLibrary([doc('A', 'a', [PARA_DEAL]), vaultDoc], cfg);
    const out = matchSegments(
      buildDocumentText([{ text: '江海新能源科技有限公司 | 陈国栋 | 13800138001', location: 'line' }]),
      lib,
      { config: cfg, suppressedEvidence: new Set(), suppressedSegments: new Set() },
    );
    expect(out.matches.find((m) => m.docId === 'CUST')).toBeUndefined();
    expect(lib.docs.some((d) => d.id === 'CUST')).toBe(false);
  });

  it('handles an empty document without throwing', () => {
    const out = matchSegments(
      buildDocumentText([{ text: '', location: 'x' }]),
      library,
      { config: cfg, suppressedEvidence: new Set(), suppressedSegments: new Set() },
    );
    expect(out.matches).toHaveLength(0);
  });
});

describe('table rows', () => {
  const sheet = [
    '客户编号 | 客户名称 | 联系人 | 年度合同额',
    'C001 | 江海新能源科技有限公司 | 陈国栋 | 1860万元',
    'C002 | 恒隆精密制造有限公司 | 林婉清 | 1540万元',
  ];
  const tableDoc = doc('T', '客户表', sheet);
  const tableLib = buildLibrary([tableDoc], cfg);

  const run = (text: string) =>
    matchSegments(buildDocumentText([{ text, location: 'row' }]), tableLib, {
      config: cfg,
      suppressedEvidence: new Set(),
      suppressedSegments: new Set(),
    });

  it('matches a row even when columns are reordered', () => {
    const out = run('C002 | 林婉清 | 恒隆精密制造有限公司 | 1540万元');
    expect(out.matches.some((m) => m.segmentIndex === 2)).toBe(true);
  });

  it('matches a row when only the values are kept and labels change', () => {
    const out = run('恒隆精密制造有限公司 | 1540万元 | C002 | 林婉清');
    expect(out.matches.some((m) => m.segmentIndex === 2)).toBe(true);
  });

  it('does not fire on a header-only table', () => {
    const out = run('序号 | 名称 | 金额');
    expect(out.matches).toHaveLength(0);
  });
});
