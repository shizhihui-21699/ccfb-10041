import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { pbkdf2 } from '@noble/hashes/pbkdf2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

/** FNV-1a 32 bit over UTF-16 code units. Fast, deterministic, not cryptographic. */
export function hashToken(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function hashBytes(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}

function mix(seed: number, id: number): number {
  let h = seed ^ id;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

function hex8(n: number): string {
  return (n >>> 0).toString(16).padStart(8, '0');
}

/**
 * 64-bit fingerprint of a token window, emitted as 16 hex chars.
 * Two independent 32-bit lanes are combined; collisions on the pair are
 * vanishingly unlikely for our corpus sizes.
 */
export function fingerprintOf(ids: Uint32Array, offset: number, length: number): string {
  let a = 0x811c9dc5;
  let b = 0x9e3779b9;
  for (let i = offset; i < offset + length; i++) {
    const id = ids[i];
    a = mix(a, id + i);
    b = mix(b, id ^ (i * 0x27d4eb2d));
  }
  return hex8(a) + hex8(b);
}

/** Fingerprint of a bag of token ids after canonical numeric sorting. */
export function bagFingerprintOf(ids: Uint32Array, offset: number, length: number): string {
  const window = Array.from(ids.subarray(offset, offset + length)).sort((x, y) => x - y);
  let a = 0x811c9dc5;
  let b = 0x9e3779b9;
  for (let i = 0; i < window.length; i++) {
    a = mix(a, window[i] + i);
    b = mix(b, window[i] ^ (i * 0x27d4eb2d));
  }
  return hex8(a) + hex8(b);
}

export type VaultKey = Uint8Array;

export function randomSalt(length = 32): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

/** HMAC-SHA256 of a normalized value, 32-byte keyed hash. */
export function keyedHash(key: VaultKey, normalizedValue: string): string {
  return bytesToHex(hmac(sha256, key, utf8ToBytes(normalizedValue)));
}

/** Short keyed hash used for candidate prefiltering. */
export function keyedShort(key: VaultKey, normalizedValue: string, bytes = 8): string {
  return bytesToHex(hmac(sha256, key, utf8ToBytes(normalizedValue))).slice(0, bytes * 2);
}

export function vaultCheckValue(key: VaultKey, vaultId: string): string {
  return bytesToHex(hmac(sha256, key, utf8ToBytes(`vault-check:${vaultId}`))).slice(0, 16);
}

/** PBKDF2-SHA256 derivation for passphrase-protected vaults. */
export function deriveVaultKey(passphrase: string, salt: Uint8Array, iterations = 210_000): VaultKey {
  return pbkdf2(sha256, utf8ToBytes(passphrase), salt, { c: iterations, dkLen: 32 });
}

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Stable id from bytes; also usable as a deterministic sample identifier. */
export function shortId(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes)).slice(0, 12);
}

export function uuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = randomSalt(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytesToHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
