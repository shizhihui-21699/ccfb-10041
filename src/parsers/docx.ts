/**
 * DOCX reader: unzip, walk word/document.xml in document order, emit one
 * block per paragraph and one per table row.
 */
import { unzipSync, strFromU8 } from 'fflate';
import { XMLParser } from 'fast-xml-parser';
import type { ParsedBlock, ParsedDocument } from '../core/types';
import { hashBytes } from '../core/hash';

type Node = Record<string, unknown>;

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: false,
  processEntities: true,
  // Without this, "13800138001" is parsed as a JS number and the text run is
  // silently lost. All cell/paragraph content must stay a string.
  parseTagValue: false,
});

function isTextRun(node: Node): boolean {
  return Object.prototype.hasOwnProperty.call(node, 'w:t');
}

function textOfRun(node: Node): string {
  const raw = node['w:t'];
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number') return String(raw);
  if (Array.isArray(raw)) {
    return raw
      .map((c: Node) => {
        const t = c['#text'];
        if (typeof t === 'string') return t;
        if (typeof t === 'number') return String(t);
        return '';
      })
      .join('');
  }
  return '';
}

/** Collect the visible text of a w:p element, preserving order. */
function paragraphText(children: Node[]): string {
  let out = '';
  const walk = (list: Node[]) => {
    for (const node of list) {
      if (isTextRun(node)) {
        out += textOfRun(node);
      }
      const keys = Object.keys(node).filter((k) => k !== ':@' && k !== '#text');
      for (const key of keys) {
        const value = node[key];
        if (Array.isArray(value) && key !== 'w:t') walk(value as Node[]);
      }
      if (Object.prototype.hasOwnProperty.call(node, 'w:tab')) out += ' ';
      if (Object.prototype.hasOwnProperty.call(node, 'w:br')) out += '\n';
      if (typeof node['#text'] === 'string' && !isTextRun(node)) {
        // Preserve text nodes inside w:t handled above; ignore others.
      }
    }
  };
  walk(children);
  return out;
}

function findBlocks(nodes: Node[]): ParsedBlock[] {
  const blocks: ParsedBlock[] = [];

  const visit = (list: Node[], depth: number) => {
    for (const node of list) {
      if (Object.keys(node).includes('w:p')) {
        const children = node['w:p'];
        // Headings carry pStyle Heading/N + outline level; display only.
        const style = findStyle(children as Node[]);
        const text = paragraphText(children as Node[]).replace(/[ \t]+/g, ' ').trim();
        if (text) {
          blocks.push({
            text,
            location: style ? `标题 ${blocks.filter((b) => b.kind === 'heading').length + 1}` : `段落 ${blocks.length + 1}`,
            kind: style ? 'heading' : 'paragraph',
          });
        }
        continue;
      }
      if (Object.keys(node).includes('w:tbl')) {
        const tbl = node['w:tbl'] as Node[];
        let rowIndex = 0;
        for (const rowNode of tbl) {
          if (!Object.keys(rowNode).includes('w:tr')) continue;
          rowIndex++;
          const cells: string[] = [];
          const tr = rowNode['w:tr'] as Node[];
          for (const cellNode of tr) {
            if (!Object.keys(cellNode).includes('w:tc')) continue;
            const tc = cellNode['w:tc'] as Node[];
            const paras: string[] = [];
            const collect = (ls: Node[]) => {
              for (const n of ls) {
                if (Object.keys(n).includes('w:p')) {
                  const t = paragraphText(n['w:p'] as Node[]).replace(/\s+/g, ' ').trim();
                  if (t) paras.push(t);
                  continue;
                }
                for (const k of Object.keys(n)) {
                  if (k === ':@' || k === '#text') continue;
                  if (Array.isArray(n[k])) collect(n[k] as Node[]);
                }
              }
            };
            collect(tc);
            cells.push(paras.join(' '));
          }
          if (cells.some((c) => c.length > 0)) {
            blocks.push({
              text: cells.join(' | '),
              location: `表格行 ${rowIndex}`,
              kind: 'row',
            });
          }
        }
        continue;
      }
      if (depth > 40) continue;
      for (const key of Object.keys(node)) {
        if (key === ':@' || key === '#text') continue;
        const value = node[key];
        if (Array.isArray(value) && key !== 'w:t') visit(value as Node[], depth + 1);
      }
    }
  };

  visit(nodes, 0);
  return blocks;
}

function findStyle(children: Node[]): string | null {
  for (const node of children) {
    if (!Object.keys(node).includes('w:pPr')) continue;
    const pr = node['w:pPr'] as Node[];
    for (const p of pr) {
      if (!Object.keys(p).includes('w:pStyle')) continue;
      // Attributes live on the (empty) element node itself.
      const attrs = p[':@'] as Record<string, string> | undefined;
      if (attrs?.['@_w:val']) return attrs['@_w:val'];
    }
  }
  return null;
}

export function parseDocx(data: Uint8Array, fileName: string, byteLength: number): ParsedDocument {
  const warnings: string[] = [];
  const files = unzipSync(data);
  const docEntry = files['word/document.xml'];
  if (!docEntry) {
    throw new Error('DOCX 中缺少 word/document.xml，文件可能已损坏或不是 Word 文档');
  }
  const xml = strFromU8(docEntry);
  const parsed = parser.parse(xml) as Node[];
  const body: Node[] = [];
  for (const node of parsed) {
    if (Object.keys(node).includes('w:document')) {
      const doc = node['w:document'];
      if (Array.isArray(doc)) {
        for (const d of doc) {
          if (Object.keys(d).includes('w:body')) body.push(...(d['w:body'] as Node[]));
        }
      }
    }
  }
  const blocks = findBlocks(body.length ? body : parsed);
  if (blocks.length === 0) warnings.push('未在文档中找到可提取的文字段落');
  const visible = blocks.filter((b) => b.text.trim().length > 0).length;
  return {
    fileName,
    kind: 'docx',
    blocks,
    byteLength,
    sha256: hashBytes(data),
    warnings,
    notes: [`已提取 ${visible} 个段落/表格行`],
  };
}
