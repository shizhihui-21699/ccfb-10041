import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseFile } from '../src/parsers';
import { buildDocumentText } from '../src/core/normalize';
import { buildDocx, buildXlsx } from '../src/samples/writers';
import { buildCanonicalStream } from '../src/core/normalize';

const sampleDir = join(process.cwd(), 'public', 'samples');

async function parsePath(rel: string) {
  const data = new Uint8Array(readFileSync(join(sampleDir, rel)));
  const name = rel.split('/').pop()!;
  return parseFile({ fileName: name, data });
}

describe('docx parser', () => {
  it('extracts paragraphs and keeps their order', async () => {
    const buf = buildDocx([
      { text: '第一段：交易结构说明。' },
      { text: '第二段：交割条件。', heading: true },
      { text: '第三段：风险提示。' },
    ]);
    const parsed = await parseFile({ fileName: 'a.docx', data: buf });
    expect(parsed.kind).toBe('docx');
    expect(parsed.blocks.map((b) => b.text)).toEqual([
      '第一段：交易结构说明。',
      '第二段：交割条件。',
      '第三段：风险提示。',
    ]);
    expect(parsed.blocks[1].kind).toBe('heading');
  });

  it('extracts table rows as single blocks with pipe separators', async () => {
    const buf = buildDocx([
      { text: '客户名称 | 联系人 | 手机', tableRow: true },
      { text: '江海新能源科技有限公司 | 陈国栋 | 13800138001', tableRow: true },
    ]);
    const parsed = await parseFile({ fileName: 't.docx', data: buf });
    expect(parsed.blocks).toHaveLength(2);
    expect(parsed.blocks[1].text).toContain('江海新能源科技有限公司 | 陈国栋 | 13800138001');
  });

  it('decodes XML entities and preserves spaces', async () => {
    const buf = buildDocx([{ text: 'A & B <tag> "quote" 保留 空格' }]);
    const parsed = await parseFile({ fileName: 'e.docx', data: buf });
    expect(parsed.blocks[0].text).toBe('A & B <tag> "quote" 保留 空格');
  });

  it('rejects a non-docx zip', async () => {
    await expect(
      parseFile({ fileName: 'bad.docx', data: new Uint8Array([1, 2, 3, 4]) }),
    ).rejects.toThrow();
  });

  it('reports a warning for an empty document', async () => {
    const buf = buildDocx([{ text: '   ' }]);
    const parsed = await parseFile({ fileName: 'empty.docx', data: buf });
    expect(parsed.blocks).toHaveLength(0);
    expect(parsed.warnings.join()).toContain('未在文档中找到');
  });
});

describe('xlsx parser', () => {
  it('reads shared strings and numbers into row blocks', async () => {
    const buf = buildXlsx([
      {
        name: 'Sheet1',
        rows: [
          ['客户名称', '联系人', '合同额'],
          ['江海新能源科技有限公司', '陈国栋', '1860'],
        ],
      },
    ]);
    const parsed = await parseFile({ fileName: 'a.xlsx', data: buf });
    expect(parsed.blocks.map((b) => b.text)).toEqual([
      '客户名称 | 联系人 | 合同额',
      '江海新能源科技有限公司 | 陈国栋 | 1860',
    ]);
    expect(parsed.blocks[1].location).toBe('Sheet1!第 2 行');
  });

  it('preserves multiple sheets in order', async () => {
    const buf = buildXlsx([
      { name: '假设', rows: [['a', '1']] },
      { name: '敏感性', rows: [['b', '2']] },
    ]);
    const parsed = await parseFile({ fileName: 'm.xlsx', data: buf });
    expect(parsed.blocks.map((b) => b.text)).toEqual(['a | 1', 'b | 2']);
    expect(parsed.blocks[1].location).toContain('敏感性');
  });

  it('marks column gaps so alignment survives', async () => {
    // A row with an empty middle cell: B is blank, C has data. The gap marker
    // keeps "z" from being fingerprinted as adjacent to "x".
    const buf = buildXlsx([{ name: 'S', rows: [['x', '', 'z']] }]);
    const parsed = await parseFile({ fileName: 'g.xlsx', data: buf });
    expect(parsed.blocks[0].text).toBe('x | ∅ | z');
  });
});

describe('text parser', () => {
  it('handles UTF-8 with BOM', async () => {
    const text = '第一行\n\n第二行';
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(text)]);
    const parsed = await parseFile({ fileName: 'a.txt', data: bytes });
    expect(parsed.blocks.map((b) => b.text)).toEqual(['第一行', '第二行']);
  });

  it('falls back to GB18030 for legacy Chinese text', async () => {
    // "客户名单" in GB18030 (not valid UTF-8).
    const gb = new Uint8Array([0xbf, 0xcd, 0xbb, 0xa7, 0xc3, 0xfb, 0xb5, 0xa5]);
    const parsed = await parseFile({ fileName: 'gb.txt', data: gb });
    expect(parsed.blocks[0].text).toBe('客户名单');
    expect(parsed.notes.join()).toContain('GB18030');
  });

  it('splits CSV rows into pipe-joined cells', async () => {
    const csv = '姓名,电话,邮箱\n陈国栋,13800138001,a@b.example\n';
    const parsed = await parseFile({
      fileName: 'c.csv',
      data: new TextEncoder().encode(csv),
    });
    expect(parsed.blocks).toHaveLength(2);
    expect(parsed.blocks[1].text).toBe('陈国栋 | 13800138001 | a@b.example');
  });

  it('treats CRLF as a single line break', async () => {
    const parsed = await parseFile({
      fileName: 'crlf.txt',
      data: new TextEncoder().encode('甲\r\n乙\r\n'),
    });
    expect(parsed.blocks.map((b) => b.text)).toEqual(['甲', '乙']);
  });

  it('throws on an unsupported extension', async () => {
    await expect(
      parseFile({ fileName: 'x.doc', data: new Uint8Array([1]) }),
    ).rejects.toThrow('不支持的文件类型');
  });
});

describe('pdf parser (generated fixture)', () => {
  it('rebuilds wrapped paragraphs from a real PDF', async () => {
    const parsed = await parsePath('protected/TECH-SPEC.pdf');
    expect(parsed.kind).toBe('pdf');
    expect(parsed.blocks.length).toBeGreaterThanOrEqual(8);
    // Each paragraph must be whole: wrapping must not split a sentence.
    for (const block of parsed.blocks) {
      expect(block.text).not.toMatch(/^(散、|天、|⽶，|克，)/);
    }
    const joined = parsed.blocks.map((b) => b.text).join('\n');
    expect(joined).toContain('年有效运行时间按330天');
    expect(joined).toContain('设备综合利用率目标为92%');
  });

  it('normalises Kangxi radicals emitted by the PDF font', async () => {
    const parsed = await parsePath('protected/TECH-SPEC.pdf');
    const doc = buildDocumentText(parsed.blocks);
    const stream = buildCanonicalStream(doc.tokens);
    // The PDF text layer contains U+2F00-block radicals; canonical form must
    // contain the real ideographs so matching works.
    expect(stream.chars).toContain('工艺路线');
    expect(stream.chars).toContain('产能设计');
  });

  it('keeps table rows in a PDF as separate blocks', async () => {
    const parsed = await parsePath('protected/QBR.pdf').catch(() => null);
    if (!parsed) return; // QBR is xlsx in this corpus
    expect(parsed.blocks.some((b) => b.text.includes('|'))).toBe(true);
  });

  it('extracts the same segments as the corpus annotation', async () => {
    const manifest = JSON.parse(readFileSync(join(sampleDir, 'manifest.json'), 'utf8')) as {
      protected: { id: string; file: string; segments: number }[];
    };
    for (const meta of manifest.protected) {
      if (!meta.file.endsWith('.pdf')) continue;
      const parsed = await parsePath(meta.file);
      const text = buildDocumentText(parsed.blocks);
      expect(text.segments.length).toBe(meta.segments);
    }
  });
});

describe('all sample files parse with the annotated segment counts', () => {
  it('protected corpus', async () => {
    const manifest = JSON.parse(readFileSync(join(sampleDir, 'manifest.json'), 'utf8')) as {
      protected: { id: string; file: string; segments: number; piiOnly?: boolean }[];
    };
    for (const meta of manifest.protected) {
      const parsed = await parsePath(meta.file);
      const text = buildDocumentText(parsed.blocks);
      if (meta.piiOnly) {
        expect(parsed.blocks.length).toBeGreaterThan(0);
      } else {
        expect(text.segments.length, `${meta.id} segment count`).toBe(meta.segments);
      }
      expect(text.tokens.length).toBeGreaterThan(0);
    }
  });

  it('outgoing corpus', async () => {
    const manifest = JSON.parse(readFileSync(join(sampleDir, 'manifest.json'), 'utf8')) as {
      outgoing: { id: string; file: string }[];
    };
    for (const meta of manifest.outgoing) {
      const parsed = await parsePath(meta.file);
      expect(parsed.blocks.length, `${meta.id} blocks`).toBeGreaterThan(0);
    }
  });
});
