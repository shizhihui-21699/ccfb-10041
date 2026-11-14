import { describe, expect, it } from 'vitest';
import { buildDocumentText, buildCanonicalStream } from '../src/core/normalize';
import {
  createVault,
  detectField,
  matchPii,
  prepareVault,
  scoreGroup,
} from '../src/core/pii';
import { DEFAULT_CONFIG } from '../src/core/types';

const cfg = { ...DEFAULT_CONFIG };

const rows = [
  { name: '陈国栋', phone: '13800138001', email: 'chen.gd@jianghai-energy.example', company: '江海新能源科技有限公司', account: '6222021001123001' },
  { name: '林婉清', phone: '13900139002', email: 'lin.wq@henglong-precision.example', company: '恒隆精密制造有限公司', account: '6222021001123002' },
  { name: '赵启明', phone: '13700137003', email: 'zhao.qm@cas-energy.example', company: '中科储能技术研究院', account: '6222021001123003' },
];

const created = createVault('客户名单', rows);
const key = created.key;
const vault = created.vault;
const prepared = prepareVault(vault, key);

function scan(text: string) {
  const doc = buildDocumentText([{ text, location: 'line' }]);
  const stream = buildCanonicalStream(doc.tokens);
  return { doc, result: matchPii(doc, stream, prepared, cfg) };
}

describe('vault creation', () => {
  it('stores hashes only, never plaintext', () => {
    const json = JSON.stringify(vault);
    for (const row of rows) {
      expect(json).not.toContain(row.name);
      expect(json).not.toContain(row.phone);
      expect(json).not.toContain(row.email);
      expect(json).not.toContain(row.account);
    }
  });

  it('records one hash per field', () => {
    expect(vault.stats.records).toBe(3);
    expect(vault.stats.values).toBe(15);
    expect(vault.stats.fields.phone).toBe(3);
  });

  it('uses a different salt per vault, so hashes are not comparable across vaults', () => {
    const other = createVault('客户名单', rows).vault;
    expect(other.salt).not.toBe(vault.salt);
    const sameValue = vault.entries[0].h;
    expect(other.entries.some((e) => e.h === sameValue)).toBe(false);
  });

  it('does not leak value lengths as a side channel beyond allowed lengths', () => {
    // Only length buckets are retained, which is what enumeration needs.
    expect(vault.lengths.phone).toEqual([11]);
  });
});

describe('field detection from headers', () => {
  it('maps common Chinese and English headers', () => {
    expect(detectField('手机号')).toBe('phone');
    expect(detectField('联系电话')).toBe('phone');
    expect(detectField('联系人')).toBe('name');
    expect(detectField('电子邮箱')).toBe('email');
    expect(detectField('客户名称')).toBe('company');
    expect(detectField('收款账号')).toBe('account');
    expect(detectField('身份证号')).toBe('idNumber');
    expect(detectField('Mobile')).toBe('phone');
    expect(detectField('备注')).toBeNull();
  });
});

describe('PII matching', () => {
  it('matches a full row', () => {
    const { result } = scan(
      '江海新能源科技有限公司 | 陈国栋 | 13800138001 | chen.gd@jianghai-energy.example',
    );
    const group = result.groups.find((g) => g.recordId === 'R0001');
    expect(group).toBeDefined();
    expect(group!.fields).toEqual(
      expect.arrayContaining(['name', 'phone', 'email', 'company']),
    );
  });

  it('matches phone numbers written with separators', () => {
    const { result } = scan('联系林婉清：139-0013-9002，确认样品寄送。');
    expect(result.groups.some((g) => g.recordId === 'R0002' && g.fields.includes('phone'))).toBe(
      true,
    );
  });

  it('matches a phone number prefixed with a country code', () => {
    const { result } = scan('境外号码 +86 139-0013-9002');
    expect(result.groups.some((g) => g.recordId === 'R0002' && g.fields.includes('phone'))).toBe(
      true,
    );
  });

  it('matches phone numbers written with spaces', () => {
    const { result } = scan('赵启明 137 0013 7003 请回电');
    expect(result.groups.some((g) => g.recordId === 'R0003' && g.fields.includes('phone'))).toBe(
      true,
    );
  });

  it('matches emails case-insensitively', () => {
    const { result } = scan('Mail: CHEN.GD@JIANGHAI-ENERGY.EXAMPLE');
    expect(result.groups.some((g) => g.recordId === 'R0001' && g.fields.includes('email'))).toBe(
      true,
    );
  });

  it('matches account numbers written with spaces', () => {
    const { result } = scan('请汇款至 6222 0210 0112 3003，户名蓝海。');
    expect(
      result.groups.some((g) => g.recordId === 'R0003' && g.fields.includes('account')),
    ).toBe(true);
  });

  it('does not match a phone number that differs in one digit', () => {
    const { result } = scan('13800138002');
    expect(result.groups).toHaveLength(0);
  });

  it('does not match substring windows inside longer digit runs', () => {
    // A 15-digit run must not be mined for an 11-digit window that happens to
    // equal a customer's phone number unless it really is one.
    const { result } = scan('订单号 1231380013800199');
    expect(result.groups).toHaveLength(0);
  });

  it('reports the raw-text offset of a match', () => {
    const text = '今日与陈国栋电话沟通（13800138001），确认付款。';
    const { doc, result } = scan(text);
    const phone = result.matches.find((m) => m.field === 'phone')!;
    expect(text.slice(phone.start, phone.end)).toContain('13800138001');
    void doc;
  });

  it('groups co-located fields of one record', () => {
    const { result } = scan('江海新能源科技有限公司 陈国栋 13800138001');
    const group = result.groups[0];
    expect(group.recordId).toBe('R0001');
    expect(group.minDistance).toBeLessThan(160);
    expect(group.score).toBeGreaterThan(90);
  });

  it('keeps a single weak field at low score', () => {
    const { result } = scan('年会名单：陈国栋、林婉清、赵启明。');
    expect(result.groups).toHaveLength(3);
    for (const g of result.groups) expect(g.score).toBeLessThan(cfg.minPiiScore);
  });

  it('produces no matches for unrelated text', () => {
    const { result } = scan('本周例会在三层会议室举行，请准备材料。');
    expect(result.matches).toHaveLength(0);
  });

  it('does not report an empty document', () => {
    const { result } = scan('');
    expect(result.matches).toHaveLength(0);
  });

  it('scores combinations higher than single fields', () => {
    const single = scoreGroup({
      recordId: 'x',
      fields: ['name'],
      matches: [],
      minDistance: 0,
      valueCount: 1,
    });
    const combo = scoreGroup({
      recordId: 'x',
      fields: ['name', 'phone'],
      matches: [],
      minDistance: 0,
      valueCount: 2,
    });
    expect(combo).toBeGreaterThan(single);
  });
});
