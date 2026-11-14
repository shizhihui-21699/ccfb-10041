/**
 * Plain-text family reader: .txt / .md / .csv. Lines become blocks; CSV/TSV
 * rows are kept whole so column-adjacent values stay adjacent.
 */
import type { ParsedBlock, ParsedDocument } from '../core/types';
import { hashBytes } from '../core/hash';

function decode(data: Uint8Array, fileName: string): { text: string; warning?: string } {
  let text: string;
  if (data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) {
    text = new TextDecoder('utf-8').decode(data.subarray(3));
  } else if (data.length >= 2 && data[0] === 0xff && data[1] === 0xfe) {
    text = new TextDecoder('utf-16le').decode(data.subarray(2));
  } else if (data.length >= 2 && data[0] === 0xfe && data[1] === 0xff) {
    text = new TextDecoder('utf-16be').decode(data.subarray(2));
  } else {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(data);
    } catch {
      text = new TextDecoder('gb18030').decode(data);
      return { text, warning: `${fileName} 不是合法 UTF-8，已按 GB18030 解码` };
    }
  }
  return { text };
}

export function parseText(data: Uint8Array, fileName: string, byteLength: number): ParsedDocument {
  const lower = fileName.toLowerCase();
  const kind = lower.endsWith('.md') ? 'md' : lower.endsWith('.csv') ? 'csv' : 'txt';
  const { text, warning } = decode(data, fileName);
  const normalized = text.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  const blocks: ParsedBlock[] = [];
  if (kind === 'csv') {
    const delimiter = normalized.includes('\t') ? '\t' : ',';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const cells = trimmed.split(delimiter).map((c) => c.replace(/^"|"$/g, '').trim());
      blocks.push({
        text: cells.join(' | '),
        location: `第 ${blocks.length + 1} 行`,
        kind: 'row',
      });
    }
  } else {
    for (const line of lines) {
      const trimmed = line.replace(/[ \t]+/g, ' ').trimEnd();
      if (!trimmed.trim()) continue;
      blocks.push({
        text: trimmed,
        location: `第 ${blocks.length + 1} 行`,
        kind: 'line',
      });
    }
  }
  const warnings: string[] = [];
  const notes: string[] = [];
  if (warning) notes.push(warning);
  if (blocks.length === 0) warnings.push('文件为空或没有可提取的文字');
  notes.push(`共 ${blocks.length} 行文本`);
  return {
    fileName,
    kind,
    blocks,
    byteLength,
    sha256: hashBytes(data),
    warnings,
    notes,
  };
}
