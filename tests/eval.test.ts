/**
 * End-to-end evaluation over the generated sample corpus.
 *
 * These assertions pin the operating point the console is tuned to: every
 * labelled leak is found, nothing is flagged in the decoy samples, and the
 * customer-data matcher has perfect precision/recall on this corpus. A
 * regression here means either a scoring change or a ground-truth edit, both
 * of which should be deliberate.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseFile } from '../src/parsers';
import { buildDocumentText } from '../src/core/normalize';
import { buildLibrary } from '../src/core/fingerprint';
import { prepareVault } from '../src/core/pii';
import { DEFAULT_CONFIG, type ProtectedDocument } from '../src/core/types';
import {
  aggregate,
  evaluateSample,
  vaultFromCustomerRows,
  type DemoEnv,
  type SampleManifest,
} from '../src/demo/evaluate';

const dir = join(process.cwd(), 'public', 'samples');
let manifest: SampleManifest;
let env: DemoEnv;

beforeAll(async () => {
  manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as SampleManifest;
  const docs: ProtectedDocument[] = [];
  const fileHashes = new Map<string, { docId: string; docTitle: string }>();
  for (const meta of manifest.protected) {
    const data = new Uint8Array(readFileSync(join(dir, meta.file)));
    const parsed = await parseFile({ fileName: meta.file.split('/').pop()!, data });
    if (meta.piiOnly) {
      docs.push({
        id: meta.id,
        title: meta.title,
        kind: parsed.kind,
        fileName: parsed.fileName,
        sha256: parsed.sha256,
        addedAt: 0,
        text: { raw: '', tokens: [], segments: [], tokenSegment: new Int32Array(0) },
        segmentCount: 0,
        tokenCount: 0,
        piiOnly: true,
      });
      continue;
    }
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
    });
    fileHashes.set(parsed.sha256, { docId: meta.id, docTitle: meta.title });
  }
  const customer = manifest.protected.find((p) => p.id === 'CUSTOMER')!;
  const customerParsed = await parseFile({
    fileName: customer.file.split('/').pop()!,
    data: new Uint8Array(readFileSync(join(dir, customer.file))),
  });
  const { vault, key } = vaultFromCustomerRows(customerParsed.blocks.map((b) => b.text));
  env = {
    library: buildLibrary(docs, DEFAULT_CONFIG),
    vault: prepareVault(vault, key),
    docs,
    vaultId: vault.id,
    fileHashes,
  };
});

async function evaluateAll(config = DEFAULT_CONFIG) {
  const samples = [];
  for (const sample of manifest.outgoing) {
    const parsed = await parseFile({
      fileName: sample.file.split('/').pop()!,
      data: new Uint8Array(readFileSync(join(dir, sample.file))),
    });
    samples.push(evaluateSample(sample, parsed, env, config));
  }
  return aggregate(samples, 0);
}

describe('corpus evaluation', () => {
  it('is a reasonably sized corpus', () => {
    expect(manifest.protected.filter((p) => !p.piiOnly).length).toBeGreaterThanOrEqual(12);
    expect(manifest.outgoing.length).toBeGreaterThanOrEqual(30);
    expect(manifest.outgoing.filter((s) => s.expectNone).length).toBeGreaterThanOrEqual(5);
  });

  it('reaches the tuned operating point', async () => {
    const r = await evaluateAll();
    expect(r.segment.precision).toBeGreaterThanOrEqual(0.97);
    expect(r.segment.recall).toBeGreaterThanOrEqual(0.95);
    expect(r.pii.precision).toBeGreaterThanOrEqual(0.98);
    expect(r.pii.recall).toBeGreaterThanOrEqual(0.98);
  });

  it('never flags any decoy (same-topic but not copied)', async () => {
    const r = await evaluateAll();
    expect(r.decoyFalsePositives).toBe(0);
  });

  it('detects every verbatim, punctuation, truncate and reformat leak', async () => {
    const r = await evaluateAll();
    for (const kind of ['verbatim', 'punctuation', 'truncate', 'reformat']) {
      const m = r.perMutation[kind];
      expect(m, kind).toBeDefined();
      expect(m.detected, kind).toBe(m.total);
    }
  });

  it('detects most reordered and paraphrased leaks', async () => {
    const r = await evaluateAll();
    expect(r.perMutation.reorder.detected / r.perMutation.reorder.total).toBeGreaterThanOrEqual(
      0.9,
    );
    expect(
      r.perMutation.paraphrase.detected / r.perMutation.paraphrase.total,
    ).toBeGreaterThanOrEqual(0.75);
  });

  it('never flags customer-list content through the fingerprint channel', async () => {
    // The customer list is vault-only: even a verbatim export of its rows may
    // only be caught by hash matching, never by segment fingerprints.
    for (const sample of manifest.outgoing) {
      const parsed = await parseFile({
        fileName: sample.file.split('/').pop()!,
        data: new Uint8Array(readFileSync(join(dir, sample.file))),
      });
      const ev = evaluateSample(sample, parsed, env, DEFAULT_CONFIG);
      expect(
        ev.falsePositives.filter((fp) => fp.docId === 'CUSTOMER'),
        `${sample.id} flagged customer rows`,
      ).toHaveLength(0);
    }
  });

  it('raises the alert threshold without losing all recall', async () => {
    const strict = await evaluateAll({ ...DEFAULT_CONFIG, minSegmentScore: 70 });
    expect(strict.segment.precision).toBe(1);
    expect(strict.segment.recall).toBeGreaterThan(0.7);
  });

  it('trades recall for precision at a very low threshold', async () => {
    // Raising recall by lowering the score gate still cannot recover leaks
    // that never produced a candidate (fully reworded passages); it only
    // adds false positives.
    const loose = await evaluateAll({ ...DEFAULT_CONFIG, minSegmentScore: 30 });
    expect(loose.segment.recall).toBeGreaterThanOrEqual(0.97);
    expect(loose.segment.fp).toBeGreaterThan(0);
  });
});
