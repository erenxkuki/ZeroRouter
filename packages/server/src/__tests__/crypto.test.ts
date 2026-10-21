import { describe, expect, it } from 'vitest';
import {
  decryptCredentials,
  encryptCredentials,
  hashSecret,
  newGatewayKey,
  prefixOf,
  randomId,
  sha256Hex,
  verifySecret,
} from '../crypto.js';
import { createHash, randomBytes } from 'node:crypto';

describe('gateway key generation', () => {
  it('produces zr_-prefixed tokens with 12-char prefixes', () => {
    for (let i = 0; i < 20; i++) {
      const { plaintext, prefix } = newGatewayKey();
      expect(plaintext.startsWith('zr_')).toBe(true);
      expect(plaintext.length).toBeGreaterThanOrEqual(40);
      expect(prefix).toBe(prefixOf(plaintext));
      expect(prefix.length).toBe(12);
      // charset is base64url
      expect(/^[A-Za-z0-9_-]+$/.test(plaintext.slice(3))).toBe(true);
    }
    // uniqueness sanity
    const seen = new Set(Array.from({ length: 50 }, () => newGatewayKey().plaintext));
    expect(seen.size).toBe(50);
  });
});

describe('hashSecret / verifySecret (scrypt)', () => {
  it('round-trips the correct secret and rejects wrong ones', async () => {
    const token = 'zr_someLongTestToken1234567890';
    const hash = await hashSecret(token);
    expect(hash.startsWith('v1$')).toBe(true);
    expect(hash.split('$').length).toBe(6);
    expect(await verifySecret(token, hash)).toBe(true);
    expect(await verifySecret('zr_wrong', hash)).toBe(false);
    // distinct hashes for same secret (random salt)
    const hash2 = await hashSecret(token);
    expect(hash2).not.toBe(hash);
    expect(await verifySecret(token, hash2)).toBe(true);
    // unicode normalization consistency
    const unicode = 'zr_key‮RLO';
    const uHash = await hashSecret(unicode);
    expect(await verifySecret(unicode, uHash)).toBe(true);
  });

  it('rejects malformed stored hashes without throwing', async () => {
    const secret = 'hello';
    const shortHash = await hashSecret(secret);
    // short stored hash → length guard fails
    expect(await verifySecret(secret, 'v1$16384$8$2$AAAA$AAAA')).toBe(false);
    expect(await verifySecret(secret, 'garbage')).toBe(false);
    expect(await verifySecret(secret, '')).toBe(false);
    expect(await verifySecret(secret, 'v1$wrong$hash$shape$AA$BB')).toBe(false);
    void shortHash;
  });

  it('rejects oversized scrypt memory parameters from a tampered hash (DoS guard)', async () => {
    // Craft an N far beyond SCRYPT_MAXMEM (64 MiB): N=2^21, r=8 → 2 GiB needed.
    const salt = randomBytes(16).toString('base64');
    const forged = ['v1', String(1 << 21), '8', '2', salt, randomBytes(64).toString('base64')].join('$');
    const before = Date.now();
    expect(await verifySecret('anything', forged)).toBe(false);
    // Must be refused by the in-process maxmem guard, not attempt the KDF.
    // 10s accommodates test-runner scheduling jitter (a parallel CI worker can
    // starve the thread); the guarded path costs milliseconds, an attempt at
    // N=2^21 would cost seconds of CPU plus gigabytes of memory.
    expect(Date.now() - before).toBeLessThan(10_000);
  });
});

describe('credential encryption (AES-256-GCM)', () => {
  const key = randomBytes(32);

  it('round-trips arbitrary credential objects', () => {
    const cred = { api_key: 'sk-or-v1-abc', extra_headers: { 'X-Test': 'unit' } };
    const enc = encryptCredentials(cred, key);
    expect(enc.startsWith('enc1:')).toBe(true);
    expect(enc).not.toContain('sk-or-v1-abc'); // ciphertext is binary/base64
    const dec = decryptCredentials(enc, key);
    expect(dec).toEqual(cred);
  });

  it('ciphertext differs for identical inputs (fresh nonce)', () => {
    const cred = { api_key: 'same' };
    const a = encryptCredentials(cred, key);
    const b = encryptCredentials(cred, key);
    expect(a).not.toBe(b);
    expect(decryptCredentials(b, key)).toEqual(cred);
  });

  it('fails on tampering, wrong key, and malformed payloads', () => {
    const enc = encryptCredentials({ api_key: 'x' }, key);
    // wrong key
    expect(() => decryptCredentials(enc, randomBytes(32))).toThrow();
    // flipped ciphertext byte
    const parts = enc.split(':');
    const raw = Buffer.from(parts[2]!, 'base64');
    raw[0] = raw[0]! ^ 1;
    const tampered = `${parts[0]}:${parts[1]}:${raw.toString('base64')}`;
    expect(() => decryptCredentials(tampered, key)).toThrow();
    expect(() => decryptCredentials('plaintext-not-encrypted', key)).toThrow('Unsupported credential encoding');
    expect(() => decryptCredentials('enc1:nonsense', key)).toThrow();
  });
});

describe('misc', () => {
  it('randomId produces prefixed url-safe identifiers', () => {
    const id = randomId('key');
    expect(id.startsWith('key_')).toBe(true);
    expect(/^[A-Za-z0-9_-]+$/.test(id.slice('key_'.length))).toBe(true);
    const custom = randomId('sess', 24);
    expect(custom.startsWith('sess_')).toBe(true);
  });

  it('sha256Hex matches node:crypto', () => {
    expect(sha256Hex('abc')).toBe(createHash('sha256').update('abc').digest('hex'));
    expect(sha256Hex(Buffer.from([1, 2, 3]))).toBe(createHash('sha256').update(Buffer.from([1, 2, 3])).digest('hex'));
  });
});
