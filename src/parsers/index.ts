import type { ParsedDocument } from '../core/types';
import { parseDocx } from './docx';
import { parseXlsx } from './xlsx';
import { parsePdf, kindFromName } from './pdf';
import { parseText } from './text';

export interface ParseInput {
  fileName: string;
  data: Uint8Array;
}

/** Parse a single uploaded file into ordered text blocks. */
export async function parseFile(input: ParseInput): Promise<ParsedDocument> {
  const kind = kindFromName(input.fileName);
  const size = input.data.length;
  if (!kind) {
    throw new Error(`不支持的文件类型：${input.fileName}（支持 .docx / .xlsx / .pdf / .txt / .md / .csv）`);
  }
  if (kind === 'docx') return parseDocx(input.data, input.fileName, size);
  if (kind === 'xlsx') return parseXlsx(input.data, input.fileName, size);
  if (kind === 'pdf') return parsePdf(input.data, input.fileName, size);
  return parseText(input.data, input.fileName, size);
}

/** Guard against decompression bombs before unzipping. */
export function checkArchiveSize(data: Uint8Array, fileName: string): void {
  const limit = 120 * 1024 * 1024;
  if (data.length > limit) throw new Error(`${fileName} 超过 120 MB，无法在浏览器内解析`);
}
