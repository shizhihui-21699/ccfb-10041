import { describe, expect, it } from 'vitest';
import { buildDocumentText, canonicalValue, tokenizeText, buildCanonicalStream } from '../src/core/normalize';
import { hashToken } from '../src/core/hash';

const tokensOf = (text: string): string[] => {
  const out: { text: string }[] = [];
  tokenizeText(text, 0, out as never);
  return out.map((t) => t.text);
};

describe('tokenization', () => {
  it('splits CJK per character and Latin per word', () => {
    expect(tokensOf('星源新材料 100% equity')).toEqual([
      '星',
      '源',
      '新',
      '材',
      '料',
      '100%'.replace('%', ''),
      'equity',
    ]);
  });

  it('drops all punctuation and whitespace', () => {
    const a = tokensOf('交易对价暂定为人民币4.8亿元，其中现金支付3.1亿元。');
    const b = tokensOf('交易对价暂定为人民币4.8亿元, 其中现金支付3.1亿元!');
    expect(a).toEqual(b);
  });

  it('treats full-width and half-width punctuation identically', () => {
    const a = tokensOf('“星源新材”：4.8亿元（人民币）');
    const b = tokensOf('"星源新材":4.8亿元(人民币)');
    expect(a).toEqual(b);
  });

  it('is case-insensitive for Latin text', () => {
    expect(tokensOf('SQL Injection')).toEqual(tokensOf('sql injection'));
  });

  it('normalizes compatibility ideographs that PDF extraction produces', () => {
    // The PDF extractor emits Kangxi radicals for some glyphs.
    expect(tokensOf('⼀⼈⾦⽀')).toEqual(tokensOf('一人金支'));
  });

  it('keeps decimals intact but ignores thousands separators', () => {
    expect(tokensOf('12.5倍')).toEqual(['12.5', '倍']);
    expect(tokensOf('1,000吨')).toEqual(tokensOf('1000吨'));
  });

  it('removes zero-width characters', () => {
    expect(tokensOf('星​源')).toEqual(['星', '源']);
  });

  it('produces stable hashes for identical tokens', () => {
    expect(hashToken('星源')).toBe(hashToken('星源'));
    expect(hashToken('星源')).not.toBe(hashToken('星原'));
  });
});

describe('document segmentation', () => {
  const doc = buildDocumentText([
    { text: '第一段内容。', location: '段落 1' },
    { text: '第二段内容，稍长一些。', location: '段落 2' },
    { text: '   ', location: '段落 3' },
    { text: '第三段内容。', location: '段落 4' },
  ]);

  it('keeps one segment per non-empty block', () => {
    expect(doc.segments).toHaveLength(3);
    expect(doc.segments.map((s) => s.location)).toEqual(['段落 1', '段落 2', '段落 4']);
  });

  it('maps every token back to its segment', () => {
    for (const seg of doc.segments) {
      for (let t = seg.tokenStart; t < seg.tokenEnd; t++) {
        expect(doc.tokenSegment[t]).toBe(seg.index);
      }
    }
  });

  it('token offsets slice back to the original characters', () => {
    for (const tok of doc.tokens) {
      expect(doc.raw.slice(tok.start, tok.end)).toBeTruthy();
    }
  });
});

describe('canonical stream', () => {
  it('makes hyphenated phone numbers contiguous', () => {
    const doc = buildDocumentText([{ text: '联系：139-0013-9002，谢谢', location: 'l1' }]);
    const stream = buildCanonicalStream(doc.tokens);
    expect(stream.chars).toContain('13900139002');
  });

  it('makes spaced phone numbers contiguous', () => {
    const doc = buildDocumentText([{ text: '手机 137 0013 7003', location: 'l1' }]);
    expect(buildCanonicalStream(doc.tokens).chars).toContain('13700137003');
  });

  it('maps canonical characters back to raw offsets', () => {
    const raw = '甲：139-0013-9002。';
    const doc = buildDocumentText([{ text: raw, location: 'l1' }]);
    const stream = buildCanonicalStream(doc.tokens);
    const i = stream.chars.indexOf('13900139002');
    expect(i).toBeGreaterThanOrEqual(0);
    const start = stream.rawStart[i];
    const end = stream.rawEnd[i + 10];
    expect(raw.slice(start, end)).toBe('139-0013-9002');
  });
});

describe('PII canonicalisation', () => {
  it('strips punctuation from phone numbers', () => {
    expect(canonicalValue('139-0013-9002', 'phone')).toBe('13900139002');
    expect(canonicalValue('139 0013 9002', 'phone')).toBe('13900139002');
    expect(canonicalValue('+86 139-0013-9002', 'phone')).toBe('8613900139002');
  });

  it('lowercases and trims emails', () => {
    expect(canonicalValue(' Chen.GD@JiangHai-Energy.example ', 'email')).toBe(
      'chen.gd@jianghai-energy.example',
    );
  });

  it('ignores punctuation inside Chinese names', () => {
    expect(canonicalValue('陈·国栋', 'name')).toBe('陈国栋');
  });
});
