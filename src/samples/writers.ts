/**
 * Minimal OOXML writers. These produce real .docx / .xlsx files (valid zip
 * containers with the minimum parts Word/Excel require) so the parser tests
 * run against files that behave like the ones employees actually send.
 */
import { zipSync, strToU8 } from 'fflate';
import type { CorpusDoc, OutgoingSample } from '../samples/corpus-types';

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const CONTENT_TYPES_DOCX = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const RELS_DOCX = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

function paragraphXml(text: string, heading = false): string {
  const style = heading
    ? '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>'
    : '';
  return `<w:p>${style}<w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
}

function tableXml(rows: string[][], header: boolean): string {
  const trs = rows
    .map((cells) => {
      const tcs = cells
        .map((c) => `<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/></w:tcPr>${paragraphXml(c)}</w:tc>`)
        .join('');
      return `<w:tr>${tcs}</w:tr>`;
    })
    .join('');
  void header;
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr>${trs}</w:tbl>`;
}

export interface DocxParagraph {
  text: string;
  heading?: boolean;
  tableRow?: boolean;
}

export function buildDocx(paragraphs: DocxParagraph[]): Uint8Array {
  const parts: string[] = [];
  let pendingRows: string[][] = [];
  const flushRows = () => {
    if (pendingRows.length > 0) {
      parts.push(tableXml(pendingRows, false));
      pendingRows = [];
    }
  };
  for (const p of paragraphs) {
    if (p.tableRow) {
      pendingRows.push(p.text.split(' | '));
      continue;
    }
    flushRows();
    parts.push(paragraphXml(p.text, Boolean(p.heading)));
  }
  flushRows();
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${parts.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body>
</w:document>`;
  return zipSync(
    {
      '[Content_Types].xml': strToU8(CONTENT_TYPES_DOCX),
      '_rels/.rels': strToU8(RELS_DOCX),
      'word/document.xml': strToU8(document),
    },
    { level: 6 },
  );
}

const CONTENT_TYPES_XLSX = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
</Types>`;

export interface XlsxSheet {
  name: string;
  rows: string[][];
}

function colLetter(n: number): string {
  let s = '';
  let x = n;
  while (x >= 0) {
    s = String.fromCharCode(65 + (x % 26)) + s;
    x = Math.floor(x / 26) - 1;
  }
  return s;
}

export function buildXlsx(sheets: XlsxSheet[]): Uint8Array {
  const shared: string[] = [];
  const sharedIndex = new Map<string, number>();
  const si = (value: string): number => {
    let idx = sharedIndex.get(value);
    if (idx === undefined) {
      idx = shared.length;
      shared.push(value);
      sharedIndex.set(value, idx);
    }
    return idx;
  };

  const rels: string[] = [];
  const overrides: string[] = [];
  const sheetEntries: Record<string, Uint8Array> = {};

  sheets.forEach((sheet, sIdx) => {
    const rowsXml = sheet.rows
      .map((row, rIdx) => {
        const cells = row
          .map((value, cIdx) => {
            if (value === '') return '';
            const ref = `${colLetter(cIdx)}${rIdx + 1}`;
            const numeric = /^-?\d+(\.\d+)?$/.test(value);
            if (numeric) {
              return `<c r="${ref}"><v>${value}</v></c>`;
            }
            return `<c r="${ref}" t="s"><v>${si(value)}</v></c>`;
          })
          .join('');
        return `<row r="${rIdx + 1}">${cells}</row>`;
      })
      .join('');
    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowsXml}</sheetData></worksheet>`;
    sheetEntries[`xl/worksheets/sheet${sIdx + 1}.xml`] = strToU8(xml);
    rels.push(
      `<Relationship Id="rId${sIdx + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${sIdx + 1}.xml"/>`,
    );
    overrides.push(
      `<Override PartName="/xl/worksheets/sheet${sIdx + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
    );
    void sIdx;
  });

  const sheetsXml = sheets
    .map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
    .join('');

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${sheetsXml}</sheets></workbook>`;

  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}<Relationship Id="rIdS" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`;

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  const sharedXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">${shared
    .map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`)
    .join('')}</sst>`;

  const contentTypes = CONTENT_TYPES_XLSX.replace(
    '</Types>',
    `${overrides.join('')}</Types>`,
  );

  return zipSync(
    {
      '[Content_Types].xml': strToU8(contentTypes),
      '_rels/.rels': strToU8(rootRels),
      'xl/workbook.xml': strToU8(workbook),
      'xl/_rels/workbook.xml.rels': strToU8(workbookRels),
      'xl/sharedStrings.xml': strToU8(sharedXml),
      ...sheetEntries,
    },
    { level: 6 },
  );
}

export function protectedToDocx(doc: CorpusDoc): Uint8Array {
  return buildDocx(
    doc.blocks.map((b) => ({
      text: b.text,
      heading: b.kind === 'heading',
      tableRow: b.kind === 'row',
    })),
  );
}

export function protectedToXlsx(doc: CorpusDoc): Uint8Array {
  const sheets: XlsxSheet[] = [];
  for (const block of doc.blocks) {
    const name = block.sheet ?? doc.sheets?.[0] ?? 'Sheet1';
    let sheet = sheets.find((s) => s.name === name);
    if (!sheet) {
      sheet = { name, rows: [] };
      sheets.push(sheet);
    }
    sheet.rows.push(block.text.split(' | '));
  }
  return buildXlsx(sheets);
}

export function outgoingToDocx(sample: OutgoingSample): Uint8Array {
  return buildDocx(
    sample.blocks.map((b) => ({
      text: b.text,
      heading: b.kind === 'heading',
      tableRow: b.kind === 'row',
    })),
  );
}

export function outgoingToXlsx(sample: OutgoingSample): Uint8Array {
  const sheets: XlsxSheet[] = [];
  for (const block of sample.blocks) {
    const name = block.sheet ?? sample.sheets?.[0] ?? 'Sheet1';
    let sheet = sheets.find((s) => s.name === name);
    if (!sheet) {
      sheet = { name, rows: [] };
      sheets.push(sheet);
    }
    sheet.rows.push(block.text.split(' | '));
  }
  return buildXlsx(sheets);
}

export function toTxt(blocks: { text: string }[]): Uint8Array {
  return strToU8(blocks.map((b) => b.text).join('\n\n') + '\n');
}
