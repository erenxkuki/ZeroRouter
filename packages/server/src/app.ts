/**
 * ZeroRouter HTTP application assembly.
 *
 * Middleware order (security-critical):
 *   1. request id + security headers (incl. strict CSP for HTML)
 *   2. optional dev CORS (explicit origin only, never '*')
 *   3. body size limit (2 MiB, gateway + admin)
 *   4. routes: /healthz, /v1/*, /admin/*, static dashboard (production)
 *   5. 404 + error normalization into the OpenAI-ish error envelope
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { bodyLimit } from 'hono/body-limit';
import { serveStatic } from '@hono/node-server/serve-static';
import { ApiError, toApiError } from './errors.js';
import { logger } from './logger.js';
import type { AppConfig } from './config.js';
import type { SettingsService } from './services/settings.js';
import type { RateLimiter } from './services/rateLimit.js';
import { createV1Routes, type V1Deps, type V1Variables } from './routes/v1.js';
import { createAdminRoutes, type AdminDeps, type AdminVariables } from './routes/admin.js';

const log = logger('app');

export type AppVariables = V1Variables & AdminVariables & { requestId: string };
export type AppEnv = { Variables: AppVariables };

export interface AppModuleDeps {
  cfg: AppConfig;
  settings: SettingsService;
  limiter: RateLimiter;
  admin: AdminDeps;
  v1: Omit<V1Deps, 'settings' | 'limiter' | 'auth'>;
  gatewayAuth: V1Deps['auth'];
}

export function createApp(deps: AppModuleDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  /* ─── 1. request id + security headers ─── */

  app.use(async (c, next) => {
    const rid = c.req.header('x-request-id') ?? randomRequestId();
    c.set('requestId', rid);
    c.header('x-request-id', rid);
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Frame-Options', 'DENY');
    c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    c.header(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self'",
        "img-src 'self' data:",
        "font-src 'self' data:",
        "connect-src 'self'",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'",
      ].join('; '),
    );
    await next();
  });

  /* ─── 2. restricted CORS (development only; one explicit origin) ─── */

  if (deps.cfg.devCorsOrigin) {
    app.use(async (c, next) => {
      c.header('Access-Control-Allow-Origin', deps.cfg.devCorsOrigin as string);
      c.header('Vary', 'Origin');
      if (c.req.method === 'OPTIONS') {
        c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
        c.header('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Requested-With');
        c.header('Access-Control-Max-Age', '600');
        return c.body(null, 204);
      }
      await next();
    });
  }

  /* ─── 3. body limit ─── */

  app.use(
    bodyLimit({
      maxSize: 2 * 1024 * 1024,
      onError: (c) =>
        c.json({ error: { message: 'Request body exceeds the 2 MiB limit.', code: 'payload_too_large', type: 'invalid_request_error' } }, 413),
    }),
  );

  /* ─── 4a. service routes ─── */

  app.get('/healthz', (c) =>
    c.json({
      ok: true,
      service: 'zerorouter',
      version: 1,
      env: deps.cfg.env,
      remote: deps.cfg.allowRemote,
      dashboard_password: deps.cfg.dashboardPassword !== null,
      ts: Date.now(),
    }),
  );

  app.route(
    '/v1',
    createV1Routes({
      ...deps.v1,
      settings: deps.settings,
      limiter: deps.limiter,
      auth: deps.gatewayAuth,
    } as V1Deps),
  );

  app.route('/admin', createAdminRoutes(deps.admin));

  /* ─── 4b. static dashboard (production build) ─── */

  const webDist = deps.cfg.webDist;
  if (webDist && existsIndex(webDist)) {
    app.use('*', serveStatic({ root: webDist }));
    // SPA fallback: any non-API GET without a matching asset gets the shell.
    app.get('*', (c) => {
      if (!isApiPath(c.req.path)) {
        return c.html(readFileSync(path.join(webDist, 'index.html'), 'utf8'));
      }
      return apiNotFound(c);
    });
  } else if (deps.cfg.env === 'development') {
    app.get('/', (c) =>
      c.json({
        service: 'zerorouter',
        endpoints: ['/healthz', '/v1/chat/completions', '/v1/models', '/admin/*'],
        note: 'API only. Launch the dashboard dev server with `npm run dev -w packages/web` (port 5173).',
      }),
    );
  }

  /* ─── 5. errors ─── */

  app.notFound((c) => apiNotFound(c));

  app.onError((err, c) => {
    const apiErr = toApiError(err);
    if (apiErr.status >= 500) {
      log.error('request failed', {
        id: c.get('requestId') as string,
        path: c.req.path,
        status: apiErr.status,
        code: apiErr.code,
        cause_name: err instanceof Error ? err.name : typeof err,
        cause_message: err instanceof Error ? err.message : String(err),
      });
    }
    if (apiErr.retryAfterMs !== undefined) {
      c.header('retry-after', String(Math.ceil(apiErr.retryAfterMs / 1000)));
    }
    return c.json(apiErr.toEnvelope(c.get('requestId') as string), apiErr.status as ContentfulStatusCode);
  });

  return app;
}

function randomRequestId(): string {
  return `req_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function existsIndex(webDist: string): boolean {
  try {
    readFileSync(path.join(webDist, 'index.html'));
    return true;
  } catch {
    return false;
  }
}

function isApiPath(p: string): boolean {
  return p === '/healthz' || p === '/v1' || p.startsWith('/v1/') || p === '/admin' || p.startsWith('/admin/');
}

function apiNotFound(c: Context): Response {
  const expectsHtml = (c.req.header('accept') ?? '').includes('text/html');
  if (expectsHtml && !isApiPath(c.req.path)) {
    // Not reachable when a webDist exists (SPA fallback covers it); safe default.
    return c.text('Not found', 404);
  }
  const err = ApiError.notFound(`Route "${c.req.path}" does not exist.`);
  return c.json(err.toEnvelope(c.get('requestId') as string), 404);
}
