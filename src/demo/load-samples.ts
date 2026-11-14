/**
 * Browser-side sample loading: fetches the generated files from
 * /samples/..., parses them with the same parsers the app uses, and builds
 * the fingerprint library and PII vault in one pass.
 */
import type { DetectionConfig, ProtectedDocument } from '../core/types';
import { buildDocumentText } from '../core/normalize';
import { buildLibrary, type PreparedLibrary } from '../core/fingerprint';
import { prepareVault, type PreparedVault } from '../core/pii';
import { parseFile } from '../parsers';
import type { ParsedDocument } from '../core/types';
import {
  vaultFromCustomerRows,
  type SampleManifest,
} from './evaluate';

export interface DemoData {
  manifest: SampleManifest;
  docs: ProtectedDocument[];
  library: PreparedLibrary;
  vault: PreparedVault;
  fileHashes: Map<string, { docId: string; docTitle: string }>;
}

async function fetchBytes(path: string): Promise<Uint8Array> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`无法加载 ${path}：HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}

export async function loadManifest(): Promise<SampleManifest> {
  const res = await fetch('samples/manifest.json');
  if (!res.ok) throw new Error('示例清单缺失，请先运行 npm run samples');
  return (await res.json()) as SampleManifest;
}

/**
 * Parse every protected document plus the customer list. The customer list is
 * parsed, immediately converted to salted hashes, and its text is discarded:
 * the ProtectedDocument returned to callers for it carries an empty token
 * stream and `piiOnly: true`.
 */
export async function buildDemoData(
  manifest: SampleManifest,
  config: DetectionConfig,
  onProgress?: (done: number, total: number, name: string) => void,
): Promise<DemoData> {
  const docs: ProtectedDocument[] = [];
  const fileHashes = new Map<string, { docId: string; docTitle: string }>();
  const total = manifest.protected.length;
  let done = 0;

  let customerRows: string[] | null = null;

  for (const meta of manifest.protected) {
    const data = await fetchBytes(`samples/${meta.file}`);
    const parsed = await parseFile({ fileName: meta.file.split('/').pop()!, data });
    if (meta.id === 'CUSTOMER') {
      customerRows = parsed.blocks.map((b) => b.text);
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
        owner: meta.owner,
        classification: meta.classification,
      });
    } else {
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
        owner: meta.owner,
        classification: meta.classification,
      });
      fileHashes.set(parsed.sha256, { docId: meta.id, docTitle: meta.title });
    }
    done++;
    onProgress?.(done, total, meta.title);
  }

  if (!customerRows) throw new Error('示例清单中缺少客户名单文档');
  const { vault, key } = vaultFromCustomerRows(customerRows);

  return {
    manifest,
    docs,
    library: buildLibrary(docs, config),
    vault: prepareVault(vault, key),
    fileHashes,
  };
}

export async function parseOutgoingSample(
  manifest: SampleManifest,
  id: string,
): Promise<{ parsed: ParsedDocument; meta: SampleManifest['outgoing'][number] }> {
  const meta = manifest.outgoing.find((s) => s.id === id);
  if (!meta) throw new Error(`未知样本 ${id}`);
  const data = await fetchBytes(`samples/${meta.file}`);
  const parsed = await parseFile({ fileName: meta.file.split('/').pop()!, data });
  return { parsed, meta };
}
