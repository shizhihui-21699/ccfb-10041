import { describe, expect, it } from 'vitest';
import { createVault, unlockVault } from '../src/core/pii';
import { buildDocumentText, buildCanonicalStream } from '../src/core/normalize';
import { matchPii, prepareVault } from '../src/core/pii';
import { DEFAULT_CONFIG } from '../src/core/types';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const rows = [{ name: '陈国栋', phone: '13800138001', email: 'chen.gd@jh.example' }];

describe('vault key handling', () => {
  it('never stores the HMAC key in the vault object', () => {
    const { vault, key } = createVault('名单', rows);
    // The key must not appear anywhere serialisable in the vault.
    const json = JSON.stringify(vault);
    const hex = bytesToHex(key);
    expect(json).not.toContain(hex);
    // salt is a *different* random value, so it cannot reveal the key.
    const saltHex = bytesToHex(
      Uint8Array.from(atob(vault.salt), (c) => c.charCodeAt(0)),
    );
    expect(saltHex).not.toBe(hex);
  });

  it('hashes are HMAC over canonical values with the returned key', () => {
    const { vault, key } = createVault('名单', rows);
    const entry = vault.entries.find((e) => e.field === 'phone')!;
    const expected = bytesToHex(hmac(sha256, key, new TextEncoder().encode('phone:13800138001')));
    expect(entry.h).toBe(expected);
  });

  it('session vaults cannot be unlocked from the stored data alone', () => {
    const { vault } = createVault('名单', rows);
    expect(vault.keyMode).toBe('session');
    // There is no passphrase that reproduces the key.
    expect(unlockVault(vault, '')).toBeNull();
    expect(unlockVault(vault, 'anything')).toBeNull();
  });

  it('passphrase vaults unlock with the right passphrase only', () => {
    const { vault, key } = createVault('名单', rows, { passphrase: 'correct horse' });
    expect(vault.keyMode).toBe('passphrase');
    const unlocked = unlockVault(vault, 'correct horse');
    expect(unlocked).not.toBeNull();
    expect(bytesToHex(unlocked!)).toBe(bytesToHex(key));
    expect(unlockVault(vault, 'wrong')).toBeNull();
  });

  it('a passphrase vault is still dictionary-resistant after a reload', () => {
    const { vault, key } = createVault('名单', rows, { passphrase: 'pw' });
    const salt = Uint8Array.from(atob(vault.salt), (c) => c.charCodeAt(0));
    expect(salt.length).toBe(32);
    expect(vault.iterations).toBeGreaterThan(100_000);
    // Matching works with the unlocked key and nothing else.
    const unlocked = unlockVault(vault, 'pw')!;
    const doc = buildDocumentText([{ text: '陈国栋 13800138001', location: 'l' }]);
    const stream = buildCanonicalStream(doc.tokens);
    const res = matchPii(doc, stream, prepareVault(vault, unlocked), DEFAULT_CONFIG);
    expect(res.groups.length).toBe(1);
    void key;
  });
});
