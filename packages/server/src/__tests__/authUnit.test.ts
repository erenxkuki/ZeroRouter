/**
 * Unit tests for the dashboard auth building blocks:
 *  - OwnerAuthService (database / environment / loopback resolution + rotation)
 *  - LoginThrottleService (attempt bucket + progressive cooldown, success reset)
 *  - session cookie flags (HttpOnly, SameSite=Strict, Secure)
 *  - credentials never stored in plaintext
 */
import { describe, expect, it } from 'vitest';
import type { Context } from 'hono';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Db } from '../db/database.js';
import { OwnerCredentialRepo, LoginThrottleRepo, SessionRepo } from '../db/repos.js';
import { OwnerAuthService } from '../services/ownerAuth.js';
import { LoginThrottleService, LOGIN_THROTTLE_DEFAULTS, loginKeyHash } from '../services/loginThrottle.js';
import { setSessionCookie, secureCookieFor, clientAddressOf, SESSION_COOKIE } from '../middleware.js';

export async function makeService(opts: { envPassword?: string | null; dir?: string } = {}) {
  const dir = opts.dir ?? mkdtempSync(path.join(os.tmpdir(), 'zr-auth-unit-'));
  const db = new Db(path.join(dir, 'gateway.db'));
  await db.migrate();
  const ownerRepo = new OwnerCredentialRepo(db);
  const sessions = new SessionRepo(db);
  const throttleRepo = new LoginThrottleRepo(db);
  const service = await OwnerAuthService.create({
    db,
    ownerRepo,
    sessions,
    loginThrottleRepo: throttleRepo,
    envPassword: opts.envPassword ?? null,
  });
  return { db, dir, ownerRepo, sessions, throttleRepo, service };
}

type HeaderStore = Record<string, string | undefined>;
function stubCtx(
  headers: Record<string, string> = {},
  socketAddress: string | null = '127.0.0.1',
): Context {
  const store: HeaderStore = {};
  const stub = {
    _headers: store,
    env: socketAddress
      ? { incoming: { socket: { remoteAddress: socketAddress } } }
      : {},
    req: { header: (k: string) => headers[k.toLowerCase()] ?? null },
    header(name: string, value: string) {
      store[name] = value;
    },
  };
  return stub as unknown as Context;
}

describe('OwnerAuthService', () => {
  const PQ = 'correct-horse-battery-staple';

  it('resolves loopback_only mode when nothing is configured', async () => {
    const { service } = await makeService();
    expect(service.mode).toBe('loopback_only');
    expect(service.credentialRequired).toBe(false);
    expect(await service.verify(null, 'anything')).toBe(false);
  });

  it('environment mode verifies from the deployment password (username is not a factor)', async () => {
    const { service } = await makeService({ envPassword: 'env-secret-123' });
    expect(service.mode).toBe('environment');
    expect(await service.verify(null, 'env-secret-123')).toBe(true);
    expect(await service.verify('someone', 'env-secret-123')).toBe(true);
    expect(await service.verify(null, 'env-secret-124')).toBe(false);
    expect(await service.verify(null, '')).toBe(false);
  });

  it(
    'provisions the owner credential into database mode and verifies both factors',
    async () => {
      const { service, ownerRepo } = await makeService();
      await service.provision('Owner', PQ);
      expect(service.mode).toBe('database');
      expect(service.username).toBe('owner');
      expect(service.credentialRequired).toBe(true);
      // normalization: case + surrounding whitespace is tolerated
      expect(await service.verify('owner', PQ)).toBe(true);
      expect(await service.verify('  OWNER  ', PQ)).toBe(true);
      expect(await service.verify('owner', PQ + 'x')).toBe(false);
      expect(await service.verify('wrong-owner', PQ)).toBe(false);
      // stored hash never contains the plaintext and uses the v1 scrypt format
      const row = await ownerRepo.get();
      expect(row?.username).toBe('owner');
      expect(row?.passwordHash.startsWith('v1$')).toBe(true);
      expect(row?.passwordHash).not.toContain(PQ);
    },
    20_000,
  );

  it('rejects provisioning inputs that violate policy', async () => {
    const { service } = await makeService();
    await expect(service.provision('Bad Name!', PQ)).rejects.toThrow();
    await expect(service.provision('owner', 'short')).rejects.toThrow();
    await expect(service.provision('owner', '')).rejects.toThrow();
  });

  it(
    'database mode takes priority over the environment fallback',
    async () => {
      const { service } = await makeService({ envPassword: 'env-secret-123' });
      await service.provision('owner', PQ);
      expect(service.mode).toBe('database');
      expect(await service.verify('owner', 'env-secret-123')).toBe(false);
      expect(await service.verify('owner', PQ)).toBe(true);
    },
    20_000,
  );

  it(
    'rotating (re-provisioning) the credential revokes every session and clears throttles',
    async () => {
      const { service, sessions, throttleRepo } = await makeService();
      const s1 = await sessions.create(60_000);
      const s2 = await sessions.create(60_000);
      expect(await sessions.valid(s1.id)).toBe(true);
      await throttleRepo.upsert({
        keyHash: 'abc',
        attemptWindowStart: Date.now(),
        attemptCount: 9,
        failureWindowStart: Date.now(),
        failureCount: 9,
        cooldownUntil: Date.now() + 60_000,
      });
      await service.provision('owner', 'replaced-password-2');
      expect(await sessions.valid(s1.id)).toBe(false);
      expect(await sessions.valid(s2.id)).toBe(false);
      expect(await service.verify('owner', 'replaced-password-2')).toBe(true);
      expect(await service.verify('owner', PQ)).toBe(false);
      expect(await throttleRepo.get('abc')).toBeNull();
    },
    20_000,
  );
});

describe('LoginThrottleService', () => {
  const mk = async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'zr-throttle-unit-'));
    const db = new Db(path.join(dir, 'gateway.db'));
    await db.migrate();
    const svc = new LoginThrottleService(new LoginThrottleRepo(db), { ...LOGIN_THROTTLE_DEFAULTS });
    return { svc, key: loginKeyHash('127.0.0.1') };
  };

  it('allows the first attempts and hashes addresses stably', async () => {
    const { svc, key } = await mk();
    expect(await svc.precheck(key)).toBeNull();
    expect(loginKeyHash('127.0.0.1')).toBe(loginKeyHash('127.0.0.1'));
    expect(loginKeyHash('127.0.0.1')).not.toBe(loginKeyHash('10.0.0.8'));
    expect(loginKeyHash(null)).toBe(loginKeyHash(null));
  });

  it('blocks attempts beyond the per-minute attempt bucket (Retry-After > 0)', async () => {
    const { svc, key } = await mk();
    for (let i = 0; i < LOGIN_THROTTLE_DEFAULTS.attemptLimit; i += 1) {
      expect(await svc.precheck(key)).toBeNull();
      await svc.consume(key);
    }
    const retry = await svc.precheck(key);
    expect(retry).not.toBeNull();
    expect(retry as number).toBeGreaterThan(0);
  });

  it('applies a progressive cooldown from the 3rd consecutive failure', async () => {
    const { svc, key } = await mk();
    const now = Date.now();
    await svc.recordFailure(key, now);
    expect(await svc.precheck(key, now + 1)).toBeNull(); // failures 1–2: no cooldown
    await svc.recordFailure(key, now + 2);
    await svc.recordFailure(key, now + 3);
    expect(await svc.precheck(key, now + 3)).toBe(500); // 3rd failure: 0.5 s
    await svc.recordFailure(key, now + 4);
    expect(await svc.precheck(key, now + 4)).toBe(1000);
    await svc.recordFailure(key, now + 5);
    expect(await svc.precheck(key, now + 5)).toBe(2000);
    await svc.recordFailure(key, now + 6);
    await svc.recordFailure(key, now + 7);
    await svc.recordFailure(key, now + 8);
    expect(await svc.precheck(key, now + 8)).toBe(16_000);
  });

  it('caps the cooldown so the owner is never permanently locked out', async () => {
    const { svc, key } = await mk();
    const now = Date.now();
    for (let i = 1; i <= 40; i += 1) await svc.recordFailure(key, now + i);
    const retry = await svc.precheck(key, now + 41);
    expect(retry as number).toBeLessThanOrEqual(LOGIN_THROTTLE_DEFAULTS.maxCooldownMs);
  });

  it('expires cooldowns and resets continuously-failing windows', async () => {
    const { svc, key } = await mk();
    const now = Date.now();
    for (let i = 1; i <= 6; i += 1) await svc.recordFailure(key, now + i);
    const later = now + LOGIN_THROTTLE_DEFAULTS.maxCooldownMs + 5;
    expect(await svc.precheck(key, later)).toBeNull();
    // failure window elapsed → counter restarts instead of compounding
    await svc.recordFailure(key, now + LOGIN_THROTTLE_DEFAULTS.failureWindowMs + 5);
    expect(await svc.precheck(key, now + LOGIN_THROTTLE_DEFAULTS.failureWindowMs + 6)).toBeNull();
  });

  it('a successful login clears all state for that client', async () => {
    const { svc, key } = await mk();
    for (let i = 1; i <= 6; i += 1) await svc.recordFailure(key);
    expect(await svc.precheck(key)).not.toBeNull();
    for (let i = 0; i < LOGIN_THROTTLE_DEFAULTS.attemptLimit; i += 1) await svc.consume(key);
    expect(await svc.precheck(key)).not.toBeNull();
    await svc.recordSuccess(key);
    expect(await svc.precheck(key)).toBeNull();
  });

  it('prunes stale rows', async () => {
    const { svc, key } = await mk();
    await svc.recordFailure(key, 1_000);
    await svc.prune(Date.now() + 25 * 3600_000);
    expect(await svc.precheck(key, Date.now())).toBeNull();
  });
});

/** Reads the Set-Cookie value the middleware wrote through c.header(). */
function cookieHeader(ctx: Context): string | undefined {
  return (ctx as unknown as { _headers: HeaderStore })._headers['Set-Cookie'];
}

describe('session cookie + proxy helpers', () => {
  it('sets HttpOnly SameSite=Strict cookies; Secure only when requested', () => {
    const plain = stubCtx();
    setSessionCookie(plain, 'sess_abc', 60_000, false);
    expect(cookieHeader(plain)).toContain(`${SESSION_COOKIE}=sess_abc`);
    expect(cookieHeader(plain)).toContain('HttpOnly');
    expect(cookieHeader(plain)).toContain('SameSite=Strict');
    expect(cookieHeader(plain)).not.toContain('Secure');

    const secure = stubCtx();
    setSessionCookie(secure, 'sess_abc', 60_000, true);
    expect(cookieHeader(secure)).toContain('Secure');
  });

  it('Secure decision follows allowRemote and trusted proxy proto only', () => {
    expect(secureCookieFor(stubCtx(), true, false)).toBe(true);
    expect(secureCookieFor(stubCtx(), false, true)).toBe(false); // trusted proxy, but plain http
    expect(secureCookieFor(stubCtx({ 'x-forwarded-proto': 'https' }), false, true)).toBe(true);
    expect(secureCookieFor(stubCtx({ 'x-forwarded-proto': 'https' }), false, false)).toBe(false); // untrusted header
    expect(secureCookieFor(stubCtx({ 'x-forwarded-proto': 'http' }), true, true)).toBe(true);
  });

  it('clientAddressOf ignores forged forwarding headers unless trustProxy is on', () => {
    const headers = { 'x-forwarded-for': '203.0.113.66, 70.1.2.3' };
    // Untrusted: the real socket address wins.
    expect(clientAddressOf(stubCtx(headers, '127.0.0.1'), false)).toBe('127.0.0.1');
    // Trusted: first X-Forwarded-For hop wins.
    expect(clientAddressOf(stubCtx(headers, '127.0.0.1'), true)).toBe('203.0.113.66');
    // No socket address and no header → null → hashed 'unknown-address' key.
    expect(clientAddressOf(stubCtx({}, null), false)).toBeNull();
  });
});
