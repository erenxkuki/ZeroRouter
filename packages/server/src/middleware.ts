/**
 * Gateway and dashboard authentication middleware.
 *
 * Dashboard: the owner credential can be provisioned into the DB (owner CLI)
 * or provided via ZEROROUTER_DASHBOARD_PASSWORD. With no credential, admin API
 * access is allowed only from loopback (config/bootstrap forbids remote binds
 * without a credential). Sessions are DB-backed; login creates a fresh session
 * id. CSRF defense: mutating admin requests must carry the `x-requested-with`
 * header set by the dashboard client (SameSite=Strict cookie + custom header).
 *
 * Gateway (/v1): always requires a gateway API key (`zr_…`) — the only secret
 * type accepted; hashed with scrypt and verified in constant time. Browser
 * session cookies are never accepted on /v1, and gateway keys are never
 * accepted on /admin.
 */
import { timingSafeEqual, createHash } from 'node:crypto';
import type { Context, Next } from 'hono';
import type { ApiKeyRepo, SessionRepo } from './db/repos.js';
import type { OwnerAuthMode } from './services/ownerAuth.js';

export const SESSION_COOKIE = 'zr_admin';

/** Minimal owner-auth surface used by the session middleware. */
export interface OwnerAuthLike {
  mode: OwnerAuthMode;
  verify(username: string | null, password: string): Promise<boolean>;
}

export interface AdminAuthDeps {
  ownerAuth: OwnerAuthLike;
  sessions: SessionRepo;
  sessionTtlMs: number;
}

/** Normalizes IPv4-mapped IPv6 and loopback forms. `null` when indeterminate. */
export function remoteAddressOf(c: Context): string | null {
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  const addr = env?.incoming?.socket?.remoteAddress ?? null;
  if (!addr) return null;
  return addr.replace(/^::ffff:/, '');
}

export function isLoopbackAddress(addr: string | null): boolean {
  if (!addr) return false;
  if (addr === '::1' || addr === '127.0.0.1') return true;
  return /^127\./.test(addr);
}

/**
 * Client address for abuse counters. Only trusts X-Forwarded-For when the
 * deployment explicitly opts in (ZEROROUTER_TRUST_PROXY=true), since the
 * header is client-forgeable when no trusted proxy sits in front.
 */
export function clientAddressOf(c: Context, trustProxy: boolean): string | null {
  if (trustProxy) {
    const fwd = c.req.header('x-forwarded-for');
    const first = fwd?.split(',')[0]?.trim();
    if (first) return first;
  }
  return remoteAddressOf(c);
}

/** First value of x-forwarded-proto (set by TLS-terminating reverse proxies). */
export function forwardedProto(c: Context): string | null {
  const proto = c.req.header('x-forwarded-proto');
  const first = proto?.split(',')[0]?.trim().toLowerCase();
  return first || null;
}

/** `Secure` cookie flag: explicit remote-bind opt-in (deployment requires TLS)
 *  or — when behind a trusted proxy — an HTTPS request as reported by the proxy. */
export function secureCookieFor(c: Context, allowRemote: boolean, trustProxy: boolean): boolean {
  if (allowRemote) return true;
  return trustProxy && forwardedProto(c) === 'https';
}

/**
 * CSRF guard for mutating admin requests: custom header + Origin/host
 * cross-check. Returns a 403 Response on violation, `null` when the request
 * may proceed to authentication. Shared by the auth gate and the login route.
 */
export function csrfGuard(c: Context): Response | null {
  if (['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) return null;
  if (c.req.header('x-requested-with') !== 'zerorouter') {
    return c.json({ error: { message: 'Missing CSRF header (x-requested-with).', code: 'auth_required', type: 'authentication_error' } }, 403);
  }
  // Extra cross-origin hardcheck when the browser sent an Origin header.
  const origin = c.req.header('origin');
  if (origin) {
    try {
      const originHost = new URL(origin).host;
      const hostHeader = c.req.header('host');
      if (hostHeader && originHost !== hostHeader) {
        return c.json({ error: { message: 'Cross-origin admin request rejected.', code: 'auth_required', type: 'authentication_error' } }, 403);
      }
    } catch {
      return c.json({ error: { message: 'Malformed Origin header.', code: 'auth_required', type: 'authentication_error' } }, 403);
    }
  }
  return null;
}

export function setSessionCookie(c: Context, id: string, ttlMs: number, secure: boolean): void {
  const maxAge = Math.floor(ttlMs / 1000);
  c.header(
    'Set-Cookie',
    `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`,
    { append: false },
  );
}

export function clearSessionCookie(c: Context, secure: boolean): void {
  c.header('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`);
}

function readCookie(c: Context, name: string): string | null {
  const header = c.req.header('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return null;
}

export interface AdminAuthResult {
  authenticated: boolean;
  mode: 'password disabled (loopback)' | 'session' | 'unauthenticated';
  remote: string | null;
}

/** Gate for /admin/* requests besides the login endpoint itself. */
export async function adminSessionAuth(deps: AdminAuthDeps, c: Context, next: Next): Promise<Response | void> {
  const remote = remoteAddressOf(c);

  const csrf = csrfGuard(c);
  if (csrf) return csrf;

  if (deps.ownerAuth.mode === 'loopback_only') {
    if (!isLoopbackAddress(remote)) {
      return c.json({ error: { message: 'Dashboard is limited to loopback until an owner credential is provisioned.', code: 'auth_required', type: 'authentication_error' } }, 403);
    }
    c.set('adminAuth', { authenticated: true, mode: 'password disabled (loopback)', remote });
    await next();
    return;
  }

  const sid = readCookie(c, SESSION_COOKIE);
  if (sid && (await deps.sessions.valid(sid))) {
    c.set('adminAuth', { authenticated: true, mode: 'session', remote });
    await next();
    return;
  }
  return c.json({ error: { message: 'Dashboard session required. Log in first.', code: 'auth_required', type: 'authentication_error' } }, 401);
}

/** Constant-time password check (hash both sides to equalize length). */
export function passwordMatches(input: string, configured: string): boolean {
  const a = createHash('sha256').update(input).digest();
  const b = createHash('sha256').update(configured).digest();
  return timingSafeEqual(a, b);
}

/* ─────────────────────────── gateway key auth ─────────────────────────── */

export interface GatewayKeyDeps {
  keys: ApiKeyRepo;
  authenticate: (plaintext: string) => Promise<{ id: string; label: string } | null>;
}

export function extractBearerKey(c: Context): string | null {
  const header = c.req.header('authorization');
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m?.[1]) return null;
  const token = m[1].trim();
  return token.startsWith('zr_') ? token : null;
}

export async function gatewayKeyAuth(deps: GatewayKeyDeps, c: Context, next: Next): Promise<Response | void> {
  const key = extractBearerKey(c);
  if (!key) {
    return c.json(
      { error: { message: 'Missing gateway API key. Send "Authorization: Bearer zr_…" (create keys in the dashboard).', code: 'auth_required', type: 'authentication_error' } },
      401,
    );
  }
  const authed = await deps.authenticate(key);
  if (!authed) {
    return c.json({ error: { message: 'Invalid, revoked, or expired gateway API key.', code: 'auth_required', type: 'authentication_error' } }, 401);
  }
  c.set('gatewayKey', authed);
  await next();
}
