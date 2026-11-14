import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseFile } from '../src/parsers';
import { buildDocumentText, buildCanonicalStream } from '../src/core/normalize';
import { createVault, detectField, matchPii, prepareVault, type RawCustomerRecord } from '../src/core/pii';
import { DEFAULT_CONFIG } from '../src/core/types';
import { runScan } from '../src/core/scan';
import { buildLibrary } from '../src/core/fingerprint';
import { vaultFromCustomerRows } from '../src/demo/evaluate';

/**
 * Build a vault from an arbitrary tabular file the way the UI does: detect
 * columns from the header, then hash each data row.
 */
async function vaultFromFile(rel: string, passphrase?: string) {
  const data = new Uint8Array(readFileSync(join(process.cwd(), 'public', 'samples', rel)));
  const parsed = await parseFile({ fileName: rel.split('/').pop()!, data });
  const header = parsed.blocks[0].text.split(' | ');
  const fields = header.map(detectField);
  const records: RawCustomerRecord[] = [];
  for (const block of parsed.blocks.slice(1)) {
    const cells = block.text.split(' | ');
    const rec: RawCustomerRecord = {};
    fields.forEach((f, i) => {
      if (f && cells[i]) rec[f] = cells[i];
    });
    if (Object.keys(rec).length > 0) records.push(rec);
  }
  return { ...createVault('客户名单', records, passphrase ? { passphrase } : {}), fields };
}

describe('building a vault from a real spreadsheet', () => {
  it('detects every column of the customer sheet', async () => {
    const { fields, vault } = await vaultFromFile('protected/CUSTOMER.xlsx');
    expect(fields).toContain('name');
    expect(fields).toContain('phone');
    expect(fields).toContain('email');
    expect(fields).toContain('company');
    expect(fields).toContain('account');
    expect(vault.stats.records).toBe(18);
    expect(vault.stats.values).toBe(90);
  });

  it('leaves no plaintext in the stored vault', async () => {
    const { vault } = await vaultFromFile('protected/CUSTOMER.xlsx');
    const json = JSON.stringify(vault);
    // Sample a few known values from the sheet.
    for (const value of ['陈国栋', '13800138001', 'jianghai-energy', '6222021001123001', '江海新能源']) {
      expect(json).not.toContain(value);
    }
  });

  it('finds a customer in free text after import', async () => {
    // Ids are derived from the customer-code column, so C004 stays C004.
    const data = new Uint8Array(readFileSync(join(process.cwd(), 'public', 'samples/protected/CUSTOMER.xlsx')));
    const parsed = await parseFile({ fileName: 'CUSTOMER.xlsx', data });
    const { vault, key } = vaultFromCustomerRows(parsed.blocks.map((b) => b.text));
    const prepared = prepareVault(vault, key);
    const doc = buildDocumentText([
      { text: '联系人周慧敏，电话 136-0013-6004，邮箱 zhou.hm@bluewind.example', location: 'l1' },
    ]);
    const result = matchPii(doc, buildCanonicalStream(doc.tokens), prepared, DEFAULT_CONFIG);
    expect(result.groups.some((g) => g.recordId === 'C004')).toBe(true);
    expect(result.groups.find((g) => g.recordId === 'C004')!.fields).toEqual(
      expect.arrayContaining(['name', 'phone', 'email']),
    );
  });

  it('works end-to-end through runScan', async () => {
    const { vault, key } = await vaultFromFile('protected/CUSTOMER.xlsx');
    const doc = buildDocumentText([
      { text: '付款账户：6222 0210 0112 3005，户名天工新材料股份有限公司', location: 'l1' },
    ]);
    const protectedDoc = {
      id: 'X',
      title: 'x',
      kind: 'txt' as const,
      fileName: 'x.txt',
      sha256: 'x',
      addedAt: 0,
      text: doc,
      segmentCount: doc.segments.length,
      tokenCount: doc.tokens.length,
    };
    const result = runScan({
      parsed: {
        fileName: 's.txt',
        kind: 'txt',
        blocks: [{ text: '付款账户：6222 0210 0112 3005，户名天工新材料股份有限公司', location: 'l1' }],
        byteLength: 1,
        sha256: 's',
        warnings: [],
        notes: [],
      },
      library: buildLibrary([protectedDoc], DEFAULT_CONFIG),
      vault: prepareVault(vault, key),
      config: DEFAULT_CONFIG,
      suppression: { evidence: new Set(), segments: new Set() },
    });
    const piiAlert = result.alerts.find((a) => a.detector === 'pii_combo');
    expect(piiAlert).toBeDefined();
    expect(piiAlert!.fields).toEqual(expect.arrayContaining(['account', 'company']));
    // The alert must not echo the full account number.
    expect(piiAlert!.detail).not.toContain('6222021001123005');
  });

  it('supports a passphrase so the vault survives a reload', async () => {
    const { vault, key } = await vaultFromFile('protected/CUSTOMER.xlsx', 'team-secret');
    expect(vault.keyMode).toBe('passphrase');
    const scanned = buildDocumentText([{ text: '陈国栋 13800138001', location: 'l1' }]);
    // Without the key there is nothing to match with; with it, matching works.
    const prepared = prepareVault(vault, key);
    const result = matchPii(scanned, buildCanonicalStream(scanned.tokens), prepared, DEFAULT_CONFIG);
    expect(result.groups.length).toBeGreaterThan(0);
  });
});

describe('vault from the demo helper', () => {
  it('keeps customer ids stable across rebuilds of the same rows', async () => {
    const data = new Uint8Array(readFileSync(join(process.cwd(), 'public', 'samples/protected/CUSTOMER.xlsx')));
    const parsed = await parseFile({ fileName: 'CUSTOMER.xlsx', data });
    const rows = parsed.blocks.map((b) => b.text);
    const a = vaultFromCustomerRows(rows);
    const b = vaultFromCustomerRows(rows);
    expect(a.vault.records.map((r) => r.id)).toEqual(b.vault.records.map((r) => r.id));
    // But each build gets a fresh salt and therefore different hashes.
    expect(a.vault.entries[0].h).not.toBe(b.vault.entries[0].h);
  });
});
