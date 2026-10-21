import {
  createHash,
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
  createCipheriv,
  createDecipheriv,
} from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  opts: { N?: number; r?: number; p?: number; maxmem?: number },
) => Promise<Buffer>;

const SCRYPT = { N: 1 << 15, r: 8, p: 2, keylen: 64 } as const;

/**
 * Upper bound on scrypt memory OpenSSH-style validation will accept.
 *
 * Our parameters need 128 * r * N = 128 * 8 * 32768 = 32 MiB exactly, which hits
 * OpenSSL's default 32 MiB maxmem limit (`memory limit exceeded` on Node 24).
 * Declare the cap explicitly — slightly above our footprint; this is a ceiling,
 * it does not weaken the KDF.
 */
const SCRYPT_MAXMEM = 64 << 20; // 64 MiB

/** Cryptographically strong new gateway API token: `zr_<base64url 40 chars>`. */
export function newGatewayKey(): { plaintext: string; prefix: string } {
  const rand = randomBytes(30).toString('base64url'); // ~40 chars
  const plaintext = `zr_${rand}`;
  return { plaintext, prefix: prefixOf(plaintext) };
}

export function prefixOf(secret: string): string {
  return secret.slice(0, 12);
}

/** Scrypt hash in the format `v1$N$r$p$saltB64$hashB64`. */
export async function hashSecret(secret: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(secret.normalize('NFKC'), salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: SCRYPT_MAXMEM,
  });
  return [
    'v1',
    String(SCRYPT.N),
    String(SCRYPT.r),
    String(SCRYPT.p),
    salt.toString('base64'),
    hash.toString('base64'),
  ].join('$');
}

/** Constant-time verification of a secret against a stored scrypt hash. */
export async function verifySecret(secret: string, storedHash: string): Promise<boolean> {
  try {
    const parts = storedHash.split('$');
    if (parts.length !== 6 || parts[0] !== 'v1') return false;
    const n = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    const salt = Buffer.from(parts[4] ?? '', 'base64');
    const expect = Buffer.from(parts[5] ?? '', 'base64');
    if (salt.length < 8 || expect.length < 32) return false;
    const got = await scrypt(secret.normalize('NFKC'), salt, expect.length, {
      N: n,
      r,
      p,
      maxmem: SCRYPT_MAXMEM,
    });
    return timingSafeEqual(got, expect);
  } catch {
    return false;
  }
}

/** SHA-256 hex of arbitrary data (used for content ids, body fingerprints, etc.). */
export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

const CRED_PREFIX = 'enc1:';

/** AES-256-GCM. Output `enc1:<nonce b64>:<ciphertext+tag b64>` or plain-nil marker. */
export function encryptCredentials(obj: unknown, masterKey: Buffer): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', masterKey, nonce);
  const plain = Buffer.from(JSON.stringify(obj), 'utf8');
  const ct = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  return `${CRED_PREFIX}${nonce.toString('base64')}:${ct.toString('base64')}`;
}

export function decryptCredentials(stored: string, masterKey: Buffer): unknown {
  if (!stored.startsWith(CRED_PREFIX)) throw new Error('Unsupported credential encoding');
  const body = stored.slice(CRED_PREFIX.length);
  const colon = body.indexOf(':');
  if (colon <= 0) throw new Error('Malformed credential payload');
  const nonce = Buffer.from(body.slice(0, colon), 'base64');
  const ct = Buffer.from(body.slice(colon + 1), 'base64');
  if (nonce.length !== 12 || ct.length < 16) throw new Error('Malformed credential payload');
  const tag = ct.subarray(ct.length - 16);
  const data = ct.subarray(0, ct.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', masterKey, nonce);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  return JSON.parse(plain);
}

export function randomId(prefix: string, bytes = 12): string {
  return `${prefix}_${randomBytes(bytes).toString('base64url')}`;
}
