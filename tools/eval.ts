/**
 * CLI evaluation over the generated sample corpus.
 *
 *   npm run eval              # default config
 *   npm run eval -- --sweep   # threshold sweep for calibration analysis
 *
 * Prints per-sample ground-truth resolution plus aggregate precision/recall
 * for segment detection and PII detection, and a false-positive count on the
 * decoy samples.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFile } from '../src/parsers';
import { buildLibrary } from '../src/core/fingerprint';
import { prepareVault } from '../src/core/pii';
import { DEFAULT_CONFIG, type DetectionConfig, type ProtectedDocument } from '../src/core/types';
import { buildDocumentText } from '../src/core/normalize';
import {
  aggregate,
  evaluateSample,
  vaultFromCustomerRows,
  type DemoEnv,
  type SampleManifest,
} from '../src/demo/evaluate';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'public', 'samples');

async function loadEnv(manifest: SampleManifest, config: DetectionConfig): Promise<DemoEnv> {
  const docs: ProtectedDocument[] = [];
  const fileHashes = new Map<string, { docId: string; docTitle: string }>();
  for (const meta of manifest.protected) {
    const data = new Uint8Array(readFileSync(join(dir, meta.file)));
    const parsed = await parseFile({ fileName: meta.file.split('/').pop()!, data });
    const text = buildDocumentText(parsed.blocks);
    docs.push({
      id: meta.id,
      title: meta.title,
      kind: parsed.kind,
      fileName: parsed.fileName,
      sha256: parsed.sha256,
      addedAt: 0,
      text,
      segmentCount: text.segments.length,
      tokenCount: text.tokens.length,
      piiOnly: meta.piiOnly,
      owner: meta.owner,
      classification: meta.classification,
    });
    fileHashes.set(parsed.sha256, { docId: meta.id, docTitle: meta.title });
  }
  const customer = manifest.protected.find((p) => p.id === 'CUSTOMER')!;
  const customerParsed = await parseFile({
    fileName: customer.file.split('/').pop()!,
    data: new Uint8Array(readFileSync(join(dir, customer.file))),
  });
  const { vault, key } = vaultFromCustomerRows(customerParsed.blocks.map((b) => b.text));
  return {
    library: buildLibrary(docs, config),
    vault: prepareVault(vault, key),
    docs,
    vaultId: vault.id,
    fileHashes,
  };
}

async function scanAll(
  manifest: SampleManifest,
  env: DemoEnv,
  config: DetectionConfig,
) {
  const t0 = performance.now();
  const evalu = [];
  for (const sample of manifest.outgoing) {
    const data = new Uint8Array(readFileSync(join(dir, sample.file)));
    const parsed = await parseFile({ fileName: sample.file.split('/').pop()!, data });
    evalu.push(evaluateSample(sample, parsed, env, config));
  }
  return aggregate(evalu, performance.now() - t0);
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

async function main() {
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as SampleManifest;
  const sweep = process.argv.includes('--sweep');
  const config = { ...DEFAULT_CONFIG };

  console.log(`Loading ${manifest.protected.length} protected docs + ${manifest.outgoing.length} samples...`);
  const env = await loadEnv(manifest, config);
  console.log(
    `Library: ${env.library.segmentCount} segments, ${env.library.fingerprintCount} ordered fingerprints, ` +
      `${env.library.bagFingerprintCount} bag fingerprints; vault: ${env.vault.vault.stats.records} records / ` +
      `${env.vault.vault.stats.values} field hashes\n`,
  );

  const report = await scanAll(manifest, env, config);
  for (const s of report.samples) {
    const mark = s.expectNone ? 'DECOY' : '     ';
    const leaks = `${s.segmentCounts.tp}/${s.leaks.length}`;
    const pii = `${s.piiCounts.tp}/${s.pii.length}`;
    const ok =
      s.segmentCounts.fn === 0 &&
      s.segmentCounts.fp === 0 &&
      s.piiCounts.fn === 0 &&
      s.piiCounts.fp === 0;
    console.log(
      `${ok ? '✓' : '·'} ${mark} ${s.id}  leaks ${leaks}  pii ${pii}  fp(seg ${s.segmentCounts.fp}, pii ${s.piiFalsePositives.length})`,
    );
    for (const l of s.leaks) {
      if (!l.detected) console.log(`    MISSED ${l.docId}/${l.segment} (${l.mutation})`);
      else if (process.argv.includes('--verbose'))
        console.log(`    hit ${l.docId}/${l.segment} (${l.mutation}) score=${l.score.toFixed(1)}`);
    }
    if (process.argv.includes('--verbose')) {
      for (const fp of s.falsePositives) console.log(`    FP seg ${fp.title} score=${fp.score.toFixed(1)}`);
      for (const fp of s.piiFalsePositives) console.log(`    FP pii ${fp.recordId} ${fp.fields.join('+')}`);
    }
  }

  console.log('\nSegment detection:', report.segment, '\nPII detection:', report.pii);
  console.log(
    `\nprecision ${pct(report.segment.precision)}  recall ${pct(report.segment.recall)}  f1 ${pct(report.segment.f1)}`,
  );
  console.log(
    `PII precision ${pct(report.pii.precision)}  recall ${pct(report.pii.recall)}  f1 ${pct(report.pii.f1)}`,
  );
  console.log(`Decoys flagged: ${report.decoyFalsePositives}/${report.decoys}`);
  console.log('By mutation:');
  for (const [m, v] of Object.entries(report.perMutation)) {
    console.log(`  ${m.padEnd(12)} ${v.detected}/${v.total}`);
  }
  console.log(`\nElapsed ${report.elapsedMs.toFixed(0)} ms`);

  if (sweep) {
    console.log('\nThreshold sweep (segment minScore):');
    const header = ['thr', 'tp', 'fp', 'fn', 'prec', 'rec', 'f1', 'decoyFP'];
    console.log(header.join('\t'));
    for (let t = 30; t <= 80; t += 5) {
      const c = { ...config, minSegmentScore: t };
      const r = await scanAll(manifest, env, c);
      console.log(
        [
          t,
          r.segment.tp,
          r.segment.fp,
          r.segment.fn,
          pct(r.segment.precision),
          pct(r.segment.recall),
          pct(r.segment.f1),
          `${r.decoyFalsePositives}/${r.decoys}`,
        ].join('\t'),
      );
    }
    console.log('\nThreshold sweep (PII minScore):');
    console.log(header.join('\t'));
    for (let t = 20; t <= 90; t += 5) {
      const c = { ...config, minPiiScore: t };
      const r = await scanAll(manifest, env, c);
      console.log(
        [
          t,
          r.pii.tp,
          r.pii.fp,
          r.pii.fn,
          pct(r.pii.precision),
          pct(r.pii.recall),
          pct(r.pii.f1),
          `${r.decoyFalsePositives}/${r.decoys}`,
        ].join('\t'),
      );
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
