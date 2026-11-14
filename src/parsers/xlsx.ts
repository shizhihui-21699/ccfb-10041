/**
 * XLSX reader: unzip, resolve shared strings, walk each sheet in order,
 * emit one block per row (cells joined with " | "). Empty rows are skipped,
 * which keeps the fingerprint stream dense.
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
  // Keep every cell value as a string: a phone number must never be parsed
  // into a float (which would drop leading zeros and lose digits).
  parseTagValue: false,
});

function attr(node: Node, name: string): string | undefined {
  const a = node[':@'] as Record<string, string> | undefined;
  return a?.[`@_${name}`];
}

function childrenOf(node: Node, key: string): Node[] {
  const v = node[key];
  return Array.isArray(v) ? (v as Node[]) : [];
}

function collectText(nodes: Node[], out: string[]): void {
  for (const n of nodes) {
    if (typeof n['#text'] === 'string') out.push(n['#text']);
    for (const key of Object.keys(n)) {
      if (key === ':@' || key === '#text') continue;
      if (Array.isArray(n[key])) collectText(n[key] as Node[], out);
    }
  }
}

/** fast-xml-parser emits numbers for numeric text; normalise to string. */
function nodeText(node: Node): string | undefined {
  const t = node['#text'];
  if (typeof t === 'string') return t;
  if (typeof t === 'number') return String(t);
  return undefined;
}

/**
 * fast-xml-parser's preserveOrder mode wraps every element as
 * `{ tag: [children...], ':@': attrs }`, so a row is
 * `{ row: [{ c: [{ v: [{ '#text': 1 }] }] }] }`. `childrenOf` returns the
 * children array, and `elementOf` unwraps the single child element.
 */
function elementOf(node: Node, key: string): Node | undefined {
  return childrenOf(node, key)[0];
}

function parseSharedStrings(xml: string): string[] {
  const parsed = parser.parse(xml) as Node[];
  const out: string[] = [];
  const walk = (nodes: Node[]) => {
    for (const n of nodes) {
      if (Array.isArray(n['si'])) {
        const text: string[] = [];
        collectText(n['si'] as Node[], text);
        out.push(text.join(''));
        continue;
      }
      for (const k of Object.keys(n)) {
        if (k === ':@' || k === '#text') continue;
        if (Array.isArray(n[k])) walk(n[k] as Node[]);
      }
    }
  };
  walk(parsed);
  return out;
}

function colIndex(ref: string): number | null {
  const m = /^([A-Z]+)/.exec(ref);
  if (!m) return null;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function sheetXmlPath(files: Record<string, Uint8Array>, relId: string): string | null {
  const rels = files['xl/_rels/workbook.xml.rels'];
  if (!rels) return null;
  const parsed = parser.parse(strFromU8(rels)) as Node[];
  let target: string | null = null;
  for (const node of parsed) {
    const list = node['Relationships'];
    if (!Array.isArray(list)) continue;
    for (const rel of list as Node[]) {
      const rid = attr(rel, 'Id');
      if (rid === relId) {
        const t = attr(rel, 'Target');
        if (t) target = t.startsWith('/') ? t.slice(1) : `xl/${t.replace(/^\.\//, '')}`;
      }
    }
  }
  return target;
}

function parseSheet(
  xml: string,
  shared: string[],
  sheetName: string,
): { blocks: ParsedBlock[]; rows: number } {
  const parsed = parser.parse(xml) as Node[];
  const blocks: ParsedBlock[] = [];
  let rowCount = 0;

  const cellValue = (cell: Node): string => {
    const type = attr(cell, 't');
    // `v` is a child element of `c`: { c: [{ v: [{ '#text': 0 }] }] }
    const vNode = elementOf(cell, 'c');
    const vList = vNode ? childrenOf(vNode, 'v') : [];
    const raw = vList.length > 0 ? nodeText(elementOf(vList[0], '#text') ?? vList[0]) : undefined;
    if (type === 's') {
      const idx = raw !== undefined ? parseInt(raw, 10) : NaN;
      return Number.isFinite(idx) ? shared[idx] ?? '' : '';
    }
    if (type === 'inlineStr') {
      const parts: string[] = [];
      collectText(childrenOf(cell, 'is'), parts);
      return parts.join('');
    }
    if (type === 'b') return raw === '1' ? 'TRUE' : 'FALSE';
    return raw ?? '';
  };

  const walk = (nodes: Node[]) => {
    for (const n of nodes) {
      if (Object.keys(n).includes('row')) {
        rowCount++;
        const row = childrenOf(n, 'row');
        const cells: { col: number; text: string }[] = [];
        for (const cellNode of row) {
          if (!Object.keys(cellNode).includes('c')) continue;
          const ref = attr(cellNode, 'r') ?? '';
          const col = colIndex(ref) ?? cells.length;
          const value = cellValue(cellNode).replace(/\s+/g, ' ').trim();
          if (value) cells.push({ col, text: value });
        }
        if (cells.length > 0) {
          cells.sort((a, b) => a.col - b.col);
          // Fill gaps with a marker so column alignment survives; fingerprints
          // then depend on adjacency of actual values, not absolute position.
          const parts: string[] = [];
          let prev = -1;
          for (const c of cells) {
            if (prev >= 0 && c.col > prev + 1) parts.push('∅');
            parts.push(c.text);
            prev = c.col;
          }
          // Real sheet row number from the r attribute, not a running count.
          const rowNum = parseInt(attr(n, 'r') ?? String(rowCount), 10) || rowCount;
          blocks.push({
            text: parts.join(' | '),
            location: `${sheetName}!第 ${rowNum} 行`,
            kind: 'row',
          });
        }
        continue;
      }
      for (const k of Object.keys(n)) {
        if (k === ':@' || k === '#text') continue;
        if (Array.isArray(n[k])) walk(n[k] as Node[]);
      }
    }
  };
  walk(parsed);
  return { blocks, rows: rowCount };
}

export function parseXlsx(data: Uint8Array, fileName: string, byteLength: number): ParsedDocument {
  const files = unzipSync(data);
  const workbook = files['xl/workbook.xml'];
  if (!workbook) throw new Error('XLSX 中缺少 xl/workbook.xml，文件可能已损坏');
  const warnings: string[] = [];
  const notes: string[] = [];

  const shared: string[] = files['xl/sharedStrings.xml']
    ? parseSharedStrings(strFromU8(files['xl/sharedStrings.xml']))
    : [];
  if (shared.length === 0) notes.push('工作簿没有共享字符串表（可能是仅有公式/数字的工作表）');

  // Read sheet order + relationship ids from workbook.xml.
  const wbParsed = parser.parse(strFromU8(workbook)) as Node[];
  const sheets: { name: string; relId: string }[] = [];
  const walkWb = (nodes: Node[]) => {
    for (const n of nodes) {
      if (Array.isArray(n['sheet'])) {
        const name = attr(n, 'name') ?? `Sheet${sheets.length + 1}`;
        const relId = attr(n, 'r:id') ?? '';
        if (relId) sheets.push({ name, relId });
        continue;
      }
      for (const k of Object.keys(n)) {
        if (k === ':@' || k === '#text') continue;
        if (Array.isArray(n[k])) walkWb(n[k] as Node[]);
      }
    }
  };
  walkWb(wbParsed);

  const blocks: ParsedBlock[] = [];
  for (const sheet of sheets) {
    const path = sheetXmlPath(files, sheet.relId);
    if (!path || !files[path]) {
      warnings.push(`工作表 ${sheet.name} 缺少数据（${path ?? '无关系路径'}）`);
      continue;
    }
    const { blocks: b } = parseSheet(strFromU8(files[path]), shared, sheet.name);
    blocks.push(...b);
  }
  if (blocks.length === 0) warnings.push('未在表格中提取到非空行');
  return {
    fileName,
    kind: 'xlsx',
    blocks,
    byteLength,
    sha256: hashBytes(data),
    warnings,
    notes: [...notes, `共 ${sheets.length} 个工作表，${blocks.length} 个非空行`],
  };
}
