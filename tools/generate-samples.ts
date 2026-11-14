/**
 * Generate the labelled sample corpus as real files under public/samples/.
 *
 *   npm run samples
 *
 * docx/xlsx/txt are written directly. PDFs are rendered with headless Chrome
 * so they carry a genuine PDF font/text layer, which the in-browser pdf.js
 * parser then has to decode for real.
 */
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORPUS } from '../src/samples/corpus';
import { OUTGOING } from '../src/samples/outgoing';
import {
  protectedToDocx,
  protectedToXlsx,
  outgoingToDocx,
  outgoingToXlsx,
  toTxt,
} from '../src/samples/writers';
import { launchPdfRenderer, type PdfBlock } from './pdf-render';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const outDir = join(root, 'public', 'samples');

interface ManifestDoc {
  id: string;
  title: string;
  owner: string;
  classification: string;
  format: string;
  file: string;
  segments: number;
  piiOnly: boolean;
}

interface ManifestSample {
  id: string;
  scenario: string;
  format: string;
  file: string;
  leaks: { docId: string; segment: number; mutation: string }[];
  pii: { recordId: string; fields: string[] }[];
  expectNone: boolean;
  notes?: string;
}

async function main() {
  if (existsSync(outDir)) rmSync(outDir, { recursive: true });
  mkdirSync(join(outDir, 'protected'), { recursive: true });
  mkdirSync(join(outDir, 'outgoing'), { recursive: true });

  const protectedManifest: ManifestDoc[] = [];
  const outgoingManifest: ManifestSample[] = [];

  const renderer = await launchPdfRenderer();
  try {
    for (const doc of CORPUS) {
      const base = `${doc.id}`;
      let file: string;
      if (doc.format === 'docx') {
        file = `protected/${base}.docx`;
        writeFileSync(join(outDir, file), protectedToDocx(doc));
      } else if (doc.format === 'xlsx') {
        file = `protected/${base}.xlsx`;
        writeFileSync(join(outDir, file), protectedToXlsx(doc));
      } else if (doc.format === 'pdf') {
        file = `protected/${base}.pdf`;
        const blocks: PdfBlock[] = doc.blocks.map((b) => ({ text: b.text, heading: false }));
        writeFileSync(join(outDir, file), await renderer.render(doc.title, blocks));
      } else {
        file = `protected/${base}.txt`;
        writeFileSync(join(outDir, file), toTxt(doc.blocks));
      }
      protectedManifest.push({
        id: doc.id,
        title: doc.title,
        owner: doc.owner,
        classification: doc.classification,
        format: doc.format,
        file,
        segments: doc.blocks.length,
        piiOnly: Boolean(doc.piiOnly),
      });
      process.stdout.write(`✓ ${doc.id} (${doc.format})\n`);
    }

    for (const sample of OUTGOING) {
      const base = sample.id;
      let file: string;
      if (sample.format === 'docx') {
        file = `outgoing/${base}.docx`;
        writeFileSync(join(outDir, file), outgoingToDocx(sample));
      } else if (sample.format === 'xlsx') {
        file = `outgoing/${base}.xlsx`;
        writeFileSync(join(outDir, file), outgoingToXlsx(sample));
      } else if (sample.format === 'pdf') {
        file = `outgoing/${base}.pdf`;
        const blocks: PdfBlock[] = sample.blocks.map((b) => ({ text: b.text, heading: false }));
        writeFileSync(join(outDir, file), await renderer.render(sample.scenario, blocks));
      } else {
        file = `outgoing/${base}.txt`;
        writeFileSync(join(outDir, file), toTxt(sample.blocks));
      }
      outgoingManifest.push({
        id: sample.id,
        scenario: sample.scenario,
        format: sample.format,
        file,
        leaks: sample.leaks,
        pii: sample.pii,
        expectNone: sample.expectNone,
        notes: sample.notes,
      });
      process.stdout.write(`✓ ${sample.id} (${sample.format})\n`);
    }
  } finally {
    await renderer.close();
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    protected: protectedManifest,
    outgoing: outgoingManifest,
  };
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(
    `\n${protectedManifest.length} protected docs, ${outgoingManifest.length} outgoing samples -> public/samples/`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
