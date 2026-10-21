/**
 * Authentication & access-control end-to-end suite (task §14, scenarios 1–15).
 *
 * Boots the REAL app (config, DB, middleware, routes). Isolated servers:
 *   A. environment mode — ZEROROUTER_DASHBOARD_PASSWORD (core scenarios)
 *   B. throttle boot    — login abuse protection (Retry-After, cooldown, reset)
 *   C. database mode    — provisioned owner credential (username + password)
 *   D. bootstrap guard  — remote bind without any credential is refused
 *
 * Scenario 11's safe-redirect logic lives in the browser and is covered by
 * packages/web/src/lib/safeRedirect.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { bootstrap, type RunningServer } from '../index.js';
import { Db } from '../db/database.js';
import { LoginThrottleRepo, OwnerCredentialRepo, SessionRepo } from '../db/repos.js';
import { OwnerAuthService } from '../services/ownerAuth.js';

const ENV_PASSWORD = 'owner-pass-env-13';
const DB_PASSWORD = 'correct-horse-battery staple';

interface HttpResponse {
  status: number;
  body: string;
  headers: Record<string, string>;
}

async function call(
  zr: RunningServer,
  method: string,
  urlPath: string,
  opts: { headers?: Record<string, string>; body?: unknown } = {},
): Promise<HttpResponse> {
  const res = await fetch(`http://127.0.0.1:${zr.config.port}${urlPath}`, {
    method,
    headers: {
      'content-type': 'application/json',
      // fresh socket per request: avoids stale keep-alive reuse across the
      // sequential test boots that share a loopback port range
      connection: 'close',
      'x-requested-with': 'zerorouter',
      ...opts.headers,
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => (headers[k] = v));
  return { status: res.status, body: await res.text(), headers };
}

function cookieFrom(res: HttpResponse): string {
  const raw = res.headers['set-cookie'] ?? '';
  const m = /zr_admin=([^;]+)/.exec(raw);
  if (!m) throw new Error(`no session cookie in response: ${raw}`);
  return `zr_admin=${m[1]}`;
}

async function loginAs(zr: RunningServer, creds: { username?: string; password: string }): Promise<HttpResponse> {
  return call(zr, 'POST', '/admin/session/login', { body: creds });
}

/** Error bodies carry a per-request id; strip it for byte-comparison of the
 *  meaningful part ("generic across factors" assertion). */
function errorBodyComparable(raw: string): string {
  const parsed = JSON.parse(raw) as { error: { request_id?: string } };
  delete parsed.error.request_id;
  return JSON.stringify(parsed);
}

function bootOptions(dataDir: string, portSeed: number, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    ZEROROUTER_DATA_DIR: dataDir,
    ZEROROUTER_PORT: String(21000 + ((process.pid + portSeed) % 4096)),
    ZEROROUTER_LOG_LEVEL: 'error',
    ...extra,
  };
}

/* ════════════════ A. environment mode ════════════════ */
describe('dashboard auth (environment mode, real bootstrap)', () => {
  let zr: RunningServer;

  beforeAll(async () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'zr-authA-'));
    zr = await bootstrap(bootOptions(dataDir, 0, { ZEROROUTER_DASHBOARD_PASSWORD: ENV_PASSWORD }));
  }, 30_000);

  afterAll(async () => {
    await zr?.stop();
  });

  it('exposes the session status honestly (environment mode, no username required)', async () => {
    const res = await call(zr, 'GET', '/admin/session');
    expect(res.status).toBe(200);
    const s = JSON.parse(res.body) as {
      mode: string;
      password_required: boolean;
      username_required: boolean;
      authenticated: boolean;
    };
    expect(s.mode).toBe('environment');
    expect(s.password_required).toBe(true);
    expect(s.username_required).toBe(false);
    expect(s.authenticated).toBe(false);
  });

  it('1. authenticates with valid credentials and issues an HttpOnly session cookie', async () => {
    const res = await loginAs(zr, { password: ENV_PASSWORD });
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body) as { ok: boolean; expires_at: number };
    expect(parsed.ok).toBe(true);
    expect(parsed.expires_at).toBeGreaterThan(Date.now());
    expect(res.headers['set-cookie']).toContain('HttpOnly');
    expect(res.headers['set-cookie']).toContain('SameSite=Strict');

    const overview = await call(zr, 'GET', '/admin/overview', { headers: { cookie: cookieFrom(res) } });
    expect(overview.status).toBe(200);
    expect(JSON.parse(overview.body)).toHaveProperty('stats');
  });

  it('2. rejects invalid credentials with a generic, detail-free error', async () => {
    const res = await loginAs(zr, { password: 'definitely-wrong-13' });
    expect(res.status).toBe(401);
    const parsed = JSON.parse(res.body) as { error: { code: string; message: string } };
    expect(parsed.error.code).toBe('auth_required');
    expect(parsed.error.message).toBe('Incorrect owner credentials.');
    expect(res.body.toLowerCase()).not.toContain('stack');
    expect(res.headers['content-type']).toContain('application/json');
  });

  it('4. enforces session expiration server-side', async () => {
    // Rows created directly in the running server's DB — same storage logins use.
    await zr.db.exec('INSERT INTO sessions (id, created_at, expires_at) VALUES (?, ?, ?)', ['sess_expired-unit-test', Date.now(), Date.now() - 5]);
    await zr.db.exec('INSERT INTO sessions (id, created_at, expires_at) VALUES (?, ?, ?)', ['sess_future-unit-test', Date.now(), Date.now() + 60_000]);
    const sessions = new SessionRepo(zr.db);
    expect(await sessions.valid('sess_expired-unit-test')).toBe(false);
    expect(await sessions.valid('sess_future-unit-test')).toBe(true);

    const res = await call(zr, 'GET', '/admin/overview', { headers: { cookie: 'zr_admin=sess_expired-unit-test' } });
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body).error.code).toBe('auth_required');
  });

  it('5. invalidates the server-side session on logout and blocks reuse', async () => {
    const login = await loginAs(zr, { password: ENV_PASSWORD });
    const cookie = cookieFrom(login);
    expect((await call(zr, 'GET', '/admin/overview', { headers: { cookie } })).status).toBe(200);

    const out = await call(zr, 'POST', '/admin/session/logout', { headers: { cookie } });
    expect(out.status).toBe(200);
    expect(out.headers['set-cookie']).toContain('Max-Age=0');

    const reuse = await call(zr, 'GET', '/admin/overview', { headers: { cookie } });
    expect(reuse.status).toBe(401);
  });

  it('6. protected pages reject unauthenticated requests with JSON (never HTML redirects)', async () => {
    const res = await call(zr, 'GET', '/admin/overview', { headers: { 'x-requested-with': '' } });
    expect(res.status).toBe(401);
    expect(res.headers['content-type']).toContain('application/json');
    expect(JSON.parse(res.body).error.code).toBe('auth_required');
  });

  it('7. protected API mutations reject unauthenticated requests', async () => {
    const res = await call(zr, 'POST', '/admin/providers', {
      body: { id: 'x', name: 'x', adapter: 'openai-compatible' },
    });
    expect(res.status).toBe(401);
    const settings = await call(zr, 'PUT', '/admin/settings', { body: { log_retention_days: 14 } });
    expect(settings.status).toBe(401);
  });

  it('8. gateway API keys never grant dashboard access', async () => {
    const cookie = cookieFrom(await loginAs(zr, { password: ENV_PASSWORD }));
    const created = await call(zr, 'POST', '/admin/keys', { headers: { cookie }, body: { label: 'auth-test-key' } });
    expect(created.status).toBe(201);
    const plaintext = (JSON.parse(created.body) as { plaintext: string }).plaintext;

    const res = await call(zr, 'GET', '/admin/overview', { headers: { authorization: `Bearer ${plaintext}` } });
    expect(res.status).toBe(401);
    const res2 = await call(zr, 'POST', '/admin/keys', {
      headers: { authorization: `Bearer ${plaintext}` },
      body: { label: 'nope' },
    });
    expect(res2.status).toBe(401);
  });

  it('9. browser session cookies are never accepted as gateway API keys', async () => {
    const cookie = cookieFrom(await loginAs(zr, { password: ENV_PASSWORD }));
    const res = await call(zr, 'GET', '/v1/models', { headers: { cookie } });
    expect(res.status).toBe(401);
    const parsed = JSON.parse(res.body) as { error: { code: string; message: string } };
    expect(parsed.error.code).toBe('auth_required');
    expect(parsed.error.message).toMatch(/Bearer zr_/);

    const res2 = await call(zr, 'POST', '/v1/chat/completions', { headers: { cookie }, body: { model: 'x', messages: [] } });
    expect(res2.status).toBe(401);
  });

  it('10. invalid and revoked gateway keys are rejected on the gateway', async () => {
    const cookie = cookieFrom(await loginAs(zr, { password: ENV_PASSWORD }));
    const created = await call(zr, 'POST', '/admin/keys', { headers: { cookie }, body: { label: 'revoke-me' } });
    const { plaintext, key } = JSON.parse(created.body) as { plaintext: string; key: { id: string } };

    const ok = await call(zr, 'GET', '/v1/models', { headers: { authorization: `Bearer ${plaintext}` } });
    expect(ok.status).toBe(200);

    const revoked = await call(zr, 'POST', `/admin/keys/${key.id}/revoke`, { headers: { cookie } });
    expect(revoked.status).toBe(200);

    const denied = await call(zr, 'GET', '/v1/models', { headers: { authorization: `Bearer ${plaintext}` } });
    expect(denied.status).toBe(401);
    expect(JSON.parse(denied.body).error.message).toMatch(/revoked|Invalid/i);

    const garbage = await call(zr, 'GET', '/v1/models', { headers: { authorization: 'Bearer zr_not-a-real-key-0000' } });
    expect(garbage.status).toBe(401);
  });

  it('11. auth failures return JSON without redirecting API clients', async () => {
    const res = await loginAs(zr, { password: 'wrong-wrong-wrong' });
    expect(res.status).toBe(401);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.headers['location']).toBeUndefined();
  });

  it('12. CSRF protection covers login and logout mutations', async () => {
    const noHeader = await call(zr, 'POST', '/admin/session/login', {
      body: { password: ENV_PASSWORD },
      headers: { 'x-requested-with': '' },
    });
    expect(noHeader.status).toBe(403);
    expect(JSON.parse(noHeader.body).error.code).toBe('auth_required');

    const evilOrigin = await call(zr, 'POST', '/admin/session/login', {
      body: { password: ENV_PASSWORD },
      headers: { origin: 'https://evil.example' },
    });
    expect(evilOrigin.status).toBe(403);

    const cookie = cookieFrom(await loginAs(zr, { password: ENV_PASSWORD }));
    const logoutNoCsrf = await call(zr, 'POST', '/admin/session/logout', { headers: { cookie, 'x-requested-with': '' } });
    expect(logoutNoCsrf.status).toBe(403);
  });

  it('13. provider credentials never appear in public or admin responses', async () => {
    const anon = await call(zr, 'GET', '/admin/providers');
    expect(anon.status).toBe(401);

    const SECRET = 'sk-provider-secret-ZZ99';
    const cookie = cookieFrom(await loginAs(zr, { password: ENV_PASSWORD }));
    const created = await call(zr, 'POST', '/admin/providers', {
      headers: { cookie },
      body: {
        id: 'secret-provider',
        name: 'Secret Provider',
        adapter: 'openai-compatible',
        base_url: 'https://example.invalid/v1',
        api_key: SECRET,
      },
    });
    expect(created.status).toBe(201);
    expect(created.body).not.toContain(SECRET);
    expect(JSON.parse(created.body).provider.has_credentials).toBe(true);

    const list = await call(zr, 'GET', '/admin/providers', { headers: { cookie } });
    expect(list.body).not.toContain(SECRET);
    expect(list.body).not.toContain('credentials_enc');

    const models = await call(zr, 'GET', '/v1/models');
    expect(models.status).toBe(401);
    expect(models.body).not.toContain(SECRET);
  });

  it('14. provisioning is not publicly repeatable: no setup/registration endpoint exists', async () => {
    const attempts = [
      await call(zr, 'POST', '/admin/setup', { body: { username: 'attacker', password: 'attacker-pass-13' } }),
      await call(zr, 'POST', '/admin/owner', { body: { username: 'attacker', password: 'attacker-pass-13' } }),
      await call(zr, 'POST', '/setup', { body: { username: 'attacker', password: 'attacker-pass-13' } }),
      await call(zr, 'POST', '/session/register', { body: { username: 'attacker', password: 'attacker-pass-13' } }),
    ];
    // Gated admin paths answer 401, unknown paths 404 — never a writable endpoint.
    for (const res of attempts) {
      expect([401, 404]).toContain(res.status);
      expect(res.status).not.toBe(200);
      expect(res.status).not.toBe(201);
    }
    // Credential creation stays impossible over HTTP; login with attacker
    // credentials fails generically and the auth mode is untouched.
    const attackerLogin = await call(zr, 'POST', '/admin/session/login', {
      body: { username: 'attacker', password: 'attacker-pass-13' },
    });
    expect(attackerLogin.status).toBe(401);
    expect(JSON.parse(attackerLogin.body).error.message).toBe('Incorrect owner credentials.');
  });

  it('15. authentication errors keep internals out of responses', async () => {
    const res = await loginAs(zr, { password: 'wrong-again-13' });
    const body = res.body.toLowerCase();
    expect(body).not.toContain('scrypt');
    expect(body).not.toContain('owner_credential');
    expect(body).not.toContain('verifysecret');
    expect(JSON.parse(res.body).error.message).toBe('Incorrect owner credentials.');
  });

  it('regenerates the session id on every login (no fixation)', async () => {
    const a = cookieFrom(await loginAs(zr, { password: ENV_PASSWORD }));
    const b = cookieFrom(await loginAs(zr, { password: ENV_PASSWORD }));
    expect(a).not.toBe(b);
  });
});

/* ════════════════ B. login throttling ════════════════ */
describe('login throttling (real bootstrap)', () => {
  let zr: RunningServer;

  beforeAll(async () => {
    zr = await bootstrap(bootOptions(mkdtempSync(path.join(os.tmpdir(), 'zr-authB-')), 1, { ZEROROUTER_DASHBOARD_PASSWORD: ENV_PASSWORD }));
  }, 30_000);

  afterAll(async () => {
    await zr?.stop();
  });

  it('3. applies a cooldown after consecutive failures and recovers afterwards', async () => {
    // 3 rapid failures → progressive cooldown engages → even the CORRECT
    // password is throttled with a Retry-After header.
    for (let i = 0; i < 3; i += 1) {
      const res = await loginAs(zr, { password: 'wrong-pass-attempt' });
      expect(res.status).toBe(401);
    }
    const throttled = await loginAs(zr, { password: ENV_PASSWORD });
    expect(throttled.status).toBe(429);
    expect(throttled.headers['retry-after']).toBeDefined();
    expect(Number(throttled.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect((JSON.parse(throttled.body) as { error: { message: string } }).error.message).toContain('Too many login attempts');

    // Cooldown elapses → a correct login succeeds and clears the counters.
    const cooldownMs = Number(throttled.headers['retry-after']) * 1000 + 80;
    await new Promise((r) => setTimeout(r, cooldownMs));
    const recovered = await loginAs(zr, { password: ENV_PASSWORD });
    expect(recovered.status).toBe(200);

    // Success reset the failure counters: two fresh failures no longer trip it.
    await loginAs(zr, { password: 'wrong-pass-attempt' });
    await loginAs(zr, { password: 'wrong-pass-attempt' });
    const stillOk = await loginAs(zr, { password: ENV_PASSWORD });
    expect(stillOk.status).toBe(200);
  }, 20_000);

  it('failures stay generic regardless of a supplied username', async () => {
    const res = await loginAs(zr, { username: 'impersonator', password: 'another-wrong-pass' });
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body).error.message).toBe('Incorrect owner credentials.');
  });
});

/* ════════════════ C. database mode (provisioned owner) ════════════════ */
describe('dashboard auth (database mode, provisioned owner credential)', () => {
  let zr: RunningServer;

  beforeAll(async () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'zr-authC-'));
    // Provision exactly the way the owner CLI does (same service path).
    const db = new Db(path.join(dataDir, 'gateway.db'));
    await db.migrate();
    const ownerAuth = await OwnerAuthService.create({
      db,
      ownerRepo: new OwnerCredentialRepo(db),
      sessions: new SessionRepo(db),
      loginThrottleRepo: new LoginThrottleRepo(db),
      envPassword: null,
    });
    await ownerAuth.provision('owner', DB_PASSWORD);
    await db.close();
    zr = await bootstrap(bootOptions(dataDir, 2));
  }, 30_000);

  afterAll(async () => {
    await zr?.stop();
  });

  it('reports database mode + username requirement on the pre-auth status endpoint', async () => {
    const res = await call(zr, 'GET', '/admin/session');
    const s = JSON.parse(res.body) as { mode: string; username_required: boolean; password_required: boolean };
    expect(s.mode).toBe('database');
    expect(s.username_required).toBe(true);
    expect(s.password_required).toBe(true);
  });

  it(
    '1+15. logs in with username+password; wrong username and wrong password are indistinguishable',
    async () => {
      const ok = await loginAs(zr, { username: 'owner', password: DB_PASSWORD });
      expect(ok.status).toBe(200);

      const wrongUser = await loginAs(zr, { username: 'impersonator', password: DB_PASSWORD });
      const wrongPass = await loginAs(zr, { username: 'owner', password: 'not-the-password' });
      expect(wrongUser.status).toBe(wrongPass.status);
      expect(errorBodyComparable(wrongUser.body)).toBe(errorBodyComparable(wrongPass.body)); // identical apart from request id
      expect(JSON.parse(wrongUser.body).error.message).toBe('Incorrect owner credentials.');
    },
    30_000,
  );

  it('5b. rotating the credential revokes existing sessions', async () => {
    const cookie = cookieFrom(await loginAs(zr, { username: 'owner', password: DB_PASSWORD }));
    expect((await call(zr, 'GET', '/admin/overview', { headers: { cookie } })).status).toBe(200);

    // Rotate via the same service path the CLI uses.
    const db = new Db(path.join(zr.config.dataDir, 'gateway.db'));
    await db.migrate();
    const ownerAuth = await OwnerAuthService.create({
      db,
      ownerRepo: new OwnerCredentialRepo(db),
      sessions: new SessionRepo(db),
      loginThrottleRepo: new LoginThrottleRepo(db),
      envPassword: null,
    });
    await ownerAuth.provision('owner', 'rotated-password-99');
    await db.close();

    const reuse = await call(zr, 'GET', '/admin/overview', { headers: { cookie } });
    expect(reuse.status).toBe(401);

    const newPassword = await loginAs(zr, { username: 'owner', password: 'rotated-password-99' });
    expect(newPassword.status).toBe(200);
    const oldPassword = await loginAs(zr, { username: 'owner', password: DB_PASSWORD });
    expect(oldPassword.status).toBe(401);
  }, 60_000);
});

/* ════════════════ D. bootstrap guard ════════════════ */
it('bootstrap refuses a remote bind without any dashboard credential', async () => {
  await expect(
    bootstrap(bootOptions(mkdtempSync(path.join(os.tmpdir(), 'zr-authD-')), 3, { ZEROROUTER_ALLOW_REMOTE: 'true' })),
  ).rejects.toThrow(/dashboard credential|owner credential|ZEROROUTER_DASHBOARD_PASSWORD/i);
}, 30_000);
