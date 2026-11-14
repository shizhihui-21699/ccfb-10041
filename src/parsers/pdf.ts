/**
 * PDF reader built on pdf.js text extraction.
 *
 * Real PDFs (including the ones generated for this project) wrap lines
 * mid-sentence, so text blocks are rebuilt by:
 *   1. grouping glyph runs into visual lines by baseline,
 *   2. concatenating lines into paragraphs until a vertical gap indicates a
 *      new paragraph (or a line ends with terminal punctuation and is clearly
 *      short — e.g. a table row or a heading).
 *
 * Tables rendered as text lines with " | " separators stay as their own
 * blocks so row-level segments survive.
 */
import type { ParsedBlock, ParsedDocument, SourceKind } from '../core/types';
import { hashBytes } from '../core/hash';

export interface PdfTextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
  hasEOL?: boolean;
}

export interface PdfPageLike {
  getTextContent(): Promise<{ items: (PdfTextItem | { type?: string })[] }>;
}

export interface PdfDocLike {
  numPages: number;
  getPage(n: number): Promise<PdfPageLike>;
}

interface VisualLine {
  y: number;
  pageNo: number;
  text: string;
  /** approximate line height */
  height: number;
}

/** Group text items of one page into visual lines. */
function pageLines(
  items: PdfTextItem[],
  pageNo: number,
): VisualLine[] {
  const groups: { y: number; items: PdfTextItem[] }[] = [];
  for (const item of items) {
    if (!item.str || item.str.trim().length === 0) continue;
    const y = item.transform[5];
    let group = groups.find((g) => Math.abs(g.y - y) <= 2);
    if (!group) {
      group = { y, items: [] };
      groups.push(group);
    }
    group.items.push(item);
  }
  groups.sort((a, b) => b.y - a.y);

  const lines: VisualLine[] = [];
  for (const g of groups) {
    const sorted = g.items.sort((a, b) => a.transform[4] - b.transform[4]);
    let text = '';
    let prevEnd: number | null = null;
    let height = 0;
    for (const item of sorted) {
      const x = item.transform[4];
      height = Math.max(height, item.height || Math.abs(item.transform[3] || 0));
      if (prevEnd !== null) {
        const gap = x - prevEnd;
        const prevCh = text[text.length - 1] ?? '';
        const nextCh = item.str[0] ?? '';
        // CJK (including CJK next to digits) never takes an inserted space;
        // Latin words do when the glyph gap is wide enough.
        const cjkBoundary =
          /[一-鿿、。，；：！？（）《》「」]/.test(prevCh) || /[一-鿿、。，；：！？（）《》「」]/.test(nextCh);
        const needsSpace =
          !cjkBoundary &&
          gap > (item.height || 10) * 0.22 &&
          !/[\s]$/u.test(text) &&
          !/^[\s,.;:!?，。；：！？、）】]/u.test(item.str);
        if (needsSpace) text += ' ';
      }
      text += item.str;
      prevEnd = x + (item.width || 0);
    }
    text = text.replace(/[ \t]+/g, ' ').trim();
    text = cleanCjkSpacing(text);
    text = normalizePdfGlyphs(text);
    if (!text) continue;
    lines.push({ y: g.y, pageNo, text, height: height || 12 });
  }
  return lines;
}

const TERMINAL = /[。！？；：.!?;:]["'”）】\]]?$/u;
const TABLE_ROW = /[|｜]/;

/**
 * Some CJK fonts embed Kangxi radicals (U+2F00-U+2FDF) or CJK compatibility
 * ideographs instead of the unified ideographs they depict. Mapping only the
 * compatibility blocks (rather than NFKC over the whole string) keeps Chinese
 * punctuation intact for display.
 */
const COMPAT_BLOCKS = /[\u2E80-\u2EFF\u2F00-\u2FDF\uF900-\uFAFF\uFE30-\uFE4F]/;

/**
 * PDF typesetting often puts a real space between a number and the Chinese
 * unit after it ("330 天"), or between CJK characters. Chinese prose does not
 * use word spaces, so collapse those; Latin-to-Latin spaces are preserved.
 */
export function cleanCjkSpacing(text: string): string {
  return text
    .replace(/[ \t]+(?=[\u4e00-\u9fff，。；：！？、）】》」])/gu, '')
    .replace(/([\u4e00-\u9fff，。；：！？、（《「【]) +/gu, '$1');
}

export function normalizePdfGlyphs(text: string): string {
  if (!COMPAT_BLOCKS.test(text)) return text;
  let out = '';
  for (const ch of text) {
    if (COMPAT_BLOCKS.test(ch)) {
      try {
        out += ch.normalize('NFKC');
      } catch {
        out += ch;
      }
    } else {
      out += ch;
    }
  }
  return out;
}

function quantile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))));
  return sorted[idx];
}

/**
 * Otsu-style 1-D threshold: split gap values into "line leading" versus
 * "paragraph gap" clusters at the point that maximises between-class
 * variance. Returns null when the document has only one spacing mode.
 */
function paragraphGapThreshold(gaps: number[]): number | null {
  const usable = gaps.filter((g) => g > 0.5 && g < 200);
  if (usable.length < 6) return null;
  const min = Math.min(...usable);
  const max = Math.max(...usable);
  if (max - min < 2) return null;
  const bins = 60;
  const width = (max - min) / bins;
  const hist = new Array<number>(bins).fill(0);
  for (const g of usable) {
    hist[Math.min(bins - 1, Math.floor((g - min) / width))]++;
  }
  const total = usable.length;
  let sum = 0;
  for (let i = 0; i < bins; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = -1;
  let bestVar = -1;
  for (let i = 0; i < bins; i++) {
    wB += hist[i];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += i * hist[i];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > bestVar) {
      bestVar = between;
      best = i;
    }
  }
  if (best < 0) return null;
  return min + (best + 1) * width;
}

/**
 * Merge visual lines into paragraph blocks.
 *
 * Paragraph breaks are detected relative to the document's own line spacing
 * (median gap), not an absolute point value: body text at 1.85 line spacing
 * and compact tables both work. A line that ends in terminal punctuation and
 * is followed by an above-median gap also starts a new paragraph.
 */
export function blocksFromLines(lines: VisualLine[], totalPages: number): ParsedBlock[] {
  const blocks: ParsedBlock[] = [];
  if (lines.length === 0) return blocks;

  // Drop page furniture: lines set much smaller than the body text.
  const bodyHeight = quantile(lines.map((l) => l.height), 0.5);
  const kept = lines.filter((l) => l.height >= bodyHeight * 0.72 || TABLE_ROW.test(l.text));

  // Inside a paragraph the leading and the wrap-gap are two distinct spacing
  // modes. Otsu splits them; its boundary is the paragraph threshold.
  const gaps: number[] = [];
  for (let i = 1; i < kept.length; i++) {
    if (kept[i].pageNo !== kept[i - 1].pageNo) continue;
    gaps.push(Math.abs(kept[i - 1].y - kept[i].y));
  }
  const otsu = paragraphGapThreshold(gaps);
  const typicalGap = quantile(gaps, 0.35) || bodyHeight * 1.4;
  const paraGap = otsu !== null ? otsu * 1.02 : typicalGap * 1.3;

  let buffer: string[] = [];
  let bufferPage = 0;
  let lastLine: VisualLine | null = null;

  const flush = () => {
    if (buffer.length === 0) return;
    let text = '';
    for (const part of buffer) {
      if (text.length === 0) {
        text = part;
        continue;
      }
      const prev = text[text.length - 1];
      const next = part[0] ?? '';
      const cjkAdjacent = /[一-鿿]/u.test(prev) && /[一-鿿]/u.test(next);
      text += cjkAdjacent ? part : ` ${part}`;
    }
    text = cleanCjkSpacing(text.replace(/\s+/g, ' ').trim());
    if (text) {
      blocks.push({
        text,
        location: `第 ${bufferPage} 页`,
        kind: TABLE_ROW.test(text) ? 'row' : 'line',
      });
    }
    buffer = [];
  };

  for (const line of kept) {
    if (TABLE_ROW.test(line.text)) {
      flush();
      blocks.push({ text: line.text, location: `第 ${line.pageNo} 页`, kind: 'row' });
      lastLine = null;
      continue;
    }
    if (!TABLE_ROW.test(line.text)) {
      const short = line.text.length <= 30;
      if (lastLine && short && /^(一|二|三|四|五|六|七|八|九|十|第)/u.test(line.text) && lastLine.pageNo === line.pageNo) {
        // Headings start their own block.
        flush();
      }
    }
    if (lastLine) {
      if (lastLine.pageNo !== line.pageNo) {
        if (TERMINAL.test(lastLine.text)) flush();
      } else {
        const gap = Math.abs(lastLine.y - line.y);
        if (gap > paraGap) flush();
      }
    }
    if (buffer.length === 0) bufferPage = line.pageNo;
    buffer.push(line.text);
    lastLine = line;
  }
  flush();
  void totalPages;
  return blocks;
}

/**
 * Runtime hooks for pdf.js assets. The browser entry installs a worker and
 * asset URLs; Node (tests / sample generation) leaves this unset and pdf.js
 * runs without a worker.
 */
export interface PdfRuntime {
  workerSrc?: string;
  cMapUrl?: string;
  standardFontDataUrl?: string;
}

let pdfRuntime: PdfRuntime | null = null;
let workerApplied = false;

export function setPdfRuntime(runtime: PdfRuntime): void {
  pdfRuntime = runtime;
}

export async function parsePdf(
  data: Uint8Array,
  fileName: string,
  byteLength: number,
): Promise<ParsedDocument> {
  const pdfjs = await import('pdfjs-dist/build/pdf.mjs');
  if (pdfRuntime?.workerSrc && !workerApplied) {
    pdfjs.GlobalWorkerOptions.workerSrc = pdfRuntime.workerSrc;
    workerApplied = true;
  }
  const doc = await pdfjs.getDocument({
    data,
    useWorkerFetch: Boolean(pdfRuntime?.workerSrc),
    isEvalSupported: false,
    disableFontFace: true,
    ...(pdfRuntime?.cMapUrl ? { cMapUrl: pdfRuntime.cMapUrl, cMapPacked: true } : {}),
    ...(pdfRuntime?.standardFontDataUrl ? { standardFontDataUrl: pdfRuntime.standardFontDataUrl } : {}),
  }).promise;
  const allLines: VisualLine[] = [];
  let itemCount = 0;
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const items: PdfTextItem[] = [];
    for (const raw of content.items) {
      const item = raw as PdfTextItem;
      if (typeof item.str === 'string' && item.transform && item.transform.length >= 6) {
        items.push(item);
      }
    }
    itemCount += items.length;
    allLines.push(...pageLines(items, i));
  }
  const blocks = blocksFromLines(allLines, doc.numPages);
  const charCount = blocks.reduce((n, b) => n + b.text.length, 0);
  const warnings: string[] = [];
  const notes: string[] = [];
  if (itemCount === 0 || charCount === 0) {
    warnings.push('该 PDF 没有文本层（可能是扫描件或纯图片），无法进行文字比对');
  }
  notes.push(`共 ${doc.numPages} 页，提取 ${blocks.length} 个文本块、${charCount} 字符`);
  return {
    fileName,
    kind: 'pdf',
    blocks,
    byteLength,
    sha256: hashBytes(data),
    warnings,
    notes,
  };
}

export function kindFromName(name: string): SourceKind | null {
  const lower = name.toLowerCase();
  if (lower.endsWith('.docx')) return 'docx';
  if (lower.endsWith('.xlsx')) return 'xlsx';
  if (lower.endsWith('.pdf')) return 'pdf';
  if (lower.endsWith('.txt')) return 'txt';
  if (lower.endsWith('.md')) return 'md';
  if (lower.endsWith('.csv')) return 'csv';
  return null;
}
