/**
 * Dashboard admin API (/admin/*). Session-authenticated (see middleware.ts).
 * Guarantees:
 *  - provider credentials are never returned to the browser (only
 *    `has_credentials` booleans);
 *  - gateway API key plaintexts are shown exactly once at creation;
 *  - alias edits validate provider/model targets and bounded fallbacks;
 *  - provider removal is blocked while aliases still reference it.
 */
import { existsSync } from 'node:fs';
import { Hono, type Context } from 'hono';
import { ApiError, toApiError } from '../errors.js';
import { randomId } from '../crypto.js';
import { z } from 'zod';
import { logger } from '../logger.js';
import {
  adminSessionAuth,
  setSessionCookie,
  clearSessionCookie,
  remoteAddressOf,
  isLoopbackAddress,
  clientAddressOf,
  secureCookieFor,
  csrfGuard,
  SESSION_COOKIE,
  type AdminAuthDeps,
} from '../middleware.js';
import { loginKeyHash } from '../services/loginThrottle.js';
import type { OwnerAuthService } from '../services/ownerAuth.js';
import type { LoginThrottleService } from '../services/loginThrottle.js';
import {
  AliasUpsertSchema,
  ALIAS_RE,
  ApiKeyCreateSchema,
  ManualModelUpsertSchema,
  ProviderUpsertSchema,
  SettingsPatchSchema,
  UnifiedChatRequestSchema,
  type AliasRecord,
  type UnifiedChatRequest,
} from '../types.js';
import type { AppConfig, Settings } from '../config.js';
import {
  AliasRepo,
  ApiKeyRepo,
  KeyAuth,
  ModelRepo,
  ProviderEventRepo,
  ProviderRepo,
  SessionRepo,
  type AuthenticatedKey,
} from '../db/repos.js';
import { ProviderService, providerUrlPolicy } from '../services/providerService.js';
import type { ChatRuntime } from '../services/chatRuntime.js';
import type { RequestLogInput, RequestLogs } from '../services/requestLogs.js';
import type { RateLimiter } from '../services/rateLimit.js';
import { relaySse, applySseHeaders, type RelayStats } from '../services/sseRelay.js';
import type { SettingsService } from '../services/settings.js';
import { adapterSummaries, getAdapter, listAdapters, loadCustomAdapterModule } from '../adapters/registry.js';

const log = logger('admin');

export interface AdminDeps {
  cfg: AppConfig;
  providers: ProviderService;
  providerRepo: ProviderRepo;
  models: ModelRepo;
  aliases: AliasRepo;
  events: ProviderEventRepo;
  keys: ApiKeyRepo;
  keyAuth: KeyAuth;
  sessions: SessionRepo;
  settings: SettingsService;
  logs: RequestLogs;
  limiter: RateLimiter;
  runtime: ChatRuntime;
  /** Owner-credential verification (database / environment / loopback mode). */
  ownerAuth: OwnerAuthService;
  /** Dashboard-login abuse counters (SQLite-backed). */
  loginThrottle: LoginThrottleService;
  /** Trust x-forwarded-for/-proto headers (documented deployment flag). */
  trustProxy: boolean;
}

export interface AdminVariables {
  adminAuth: { authenticated: boolean; mode: string; remote: string | null };
}

const SESSION_TTL_MS = 12 * 3600_000;

function parseOrThrow<T extends z.ZodType>(schema: T, data: unknown): z.output<T> {
  const res = schema.safeParse(data);
  if (!res.success) {
    throw ApiError.unprocessable('Validation failed.', {
      issues: res.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return res.data;
}

/** Parses a JSON body with a uniform malformed-body error. */
async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw ApiError.badRequest('Request body must be valid JSON.');
  }
}

export function createAdminRoutes(deps: AdminDeps): Hono<{ Variables: AdminVariables }> {
  const app = new Hono<{ Variables: AdminVariables }>();

  const authDeps: AdminAuthDeps = {
    ownerAuth: deps.ownerAuth,
    sessions: deps.sessions,
    sessionTtlMs: SESSION_TTL_MS,
  };

  /* ─── pre-auth session endpoints ─── */

  app.get('/session', (c) => {
    const cookieAuth = readSessionValid(deps, c);
    const loopbackOnly = deps.ownerAuth.mode === 'loopback_only';
    return c.json({
      password_required: !loopbackOnly,
      username_required: deps.ownerAuth.mode === 'database',
      authenticated: loopbackOnly ? isLoopbackAddress(remoteAddressOf(c)) : cookieAuth,
      mode: deps.ownerAuth.mode,
      secure_context: deps.cfg.allowRemote,
    });
  });

  app.post('/session/login', async (c) => {
    if (deps.ownerAuth.mode === 'loopback_only') {
      throw ApiError.badRequest('No owner credential is provisioned; admin access is unlocked for loopback clients.');
    }
    // Login is a mutation: same CSRF requirements as every other admin route
    // (the dashboard client already sends the header on every request).
    const csrf = csrfGuard(c);
    if (csrf) return csrf;

    const body = (await readJson(c)) as { username?: unknown; password?: unknown };
    const password = typeof body.password === 'string' ? body.password : null;
    if (!password) {
      throw ApiError.badRequest('Field "password" is required.');
    }
    let username: string | null = null;
    if (deps.ownerAuth.mode === 'database') {
      if (typeof body.username !== 'string' || body.username.trim().length === 0) {
        throw ApiError.badRequest('Field "username" is required.');
      }
      username = body.username.trim();
      if (username.length > 64 || password.length > 1024) {
        throw ApiError.badRequest('Credentials are too long.');
      }
    } else if (password.length > 1024) {
      throw ApiError.badRequest('Credentials are too long.');
    }

    // Abuse protection: bucket + progressive cooldown, keyed by hashed client
    // address. Adding the Retry-After header, message stays generic.
    const keyHash = loginKeyHash(clientAddressOf(c, deps.trustProxy));
    const retryMs = deps.loginThrottle.precheck(keyHash);
    if (retryMs !== null) {
      c.header('retry-after', String(Math.max(1, Math.ceil(retryMs / 1000))));
      log.warn('dashboard login throttled', { remote: remoteAddressOf(c) });
      return c.json(
        { error: { message: 'Too many login attempts. Try again later.', code: 'rate_limited', type: 'rate_limit_error' } },
        429,
      );
    }
    deps.loginThrottle.consume(keyHash);

    const ok = await deps.ownerAuth.verify(username, password);
    if (!ok) {
      deps.loginThrottle.recordFailure(keyHash);
      log.warn('failed dashboard login', { remote: remoteAddressOf(c) });
      // Generic message: does not reveal which factor failed (single owner).
      throw ApiError.upstream(401, 'auth_required', 'Incorrect owner credentials.');
    }
    deps.loginThrottle.recordSuccess(keyHash);

    // Fresh session id per login (no fixation of any pre-known value).
    const sess = deps.sessions.create(SESSION_TTL_MS);
    setSessionCookie(c, sess.id, SESSION_TTL_MS, secureCookieFor(c, deps.cfg.allowRemote, deps.trustProxy));
    log.info('dashboard login', { remote: remoteAddressOf(c) });
    return c.json({ ok: true, expires_at: sess.expiresAt });
  });

  /* ─── auth gate for everything below (login/status exempt) ─── */

  app.use('*', async (c, next) => {
    const p = c.req.path;
    if (p.endsWith('/session') || p.endsWith('/session/login')) {
      await next();
      return;
    }
    const res = await adminSessionAuth(authDeps, c, next);
    if (res) return res;
  });

  app.post('/session/logout', (c) => {
    const sid = readCookie(c, SESSION_COOKIE);
    if (sid) deps.sessions.delete(sid);
    clearSessionCookie(c, deps.cfg.allowRemote);
    return c.json({ ok: true });
  });

  /* ─── overview / stats ─── */

  app.get('/overview', (c) =>
    c.json({
      stats: deps.logs.stats(),
      activity: deps.logs.activitySeries24h(),
      events: deps.events.recent(20),
      providers: deps.providers.list().map((p) => deps.providers.toApi(p)),
    }),
  );

  app.get('/stats', (c) => c.json({ stats: deps.logs.stats(), activity: deps.logs.activitySeries24h() }));

  /* ─── providers ─── */

  app.get('/providers', (c) =>
    c.json({
      providers: deps.providers.list().map((p) => deps.providers.toApi(p)),
      adapters: adapterSummaries(),
    }),
  );

  app.post('/providers', async (c) => {
    const input = parseOrThrow(ProviderUpsertSchema, await readJson(c));
    const created = deps.providers.create(input);
    log.info('provider created', { id: created.id, adapter: created.adapter });
    return c.json({ provider: deps.providers.toApi(created) }, 201);
  });

  app.get('/providers/:id', (c) => {
    const id = c.req.param('id');
    const provider = deps.providers.get(id);
    const adapter = getAdapter(provider.adapter);
    return c.json({
      provider: deps.providers.toApi(provider),
      adapter_capabilities: adapter?.capabilities ?? null,
      events: deps.events.forProvider(id, 25),
      resolved_url_policy: providerUrlPolicy(provider.config),
    });
  });

  app.put('/providers/:id', async (c) => {
    const patch = parseOrThrow(ProviderUpsertSchema.partial(), await readJson(c));
    const updated = deps.providers.update(c.req.param('id'), patch);
    log.info('provider updated', { id: updated.id });
    return c.json({ provider: deps.providers.toApi(updated) });
  });

  app.delete('/providers/:id', (c) => {
    const force = c.req.query('force') === '1';
    const result = deps.providers.remove(c.req.param('id'), force);
    if (!result.removed) {
      throw ApiError.conflict(
        `Provider is still referenced by ${result.blockedByAliases?.length} alias(es). Repeat with ?force=1 to delete anyway.`,
        { blocked_by_aliases: result.blockedByAliases ?? [] },
        'disabled',
      );
    }
    log.info('provider deleted', { id: c.req.param('id'), forced: force });
    return c.json({ ok: true, forced: force });
  });

  app.post('/providers/:id/test', async (c) => {
    const result = await deps.providers.testConnection(c.req.param('id'));
    return c.json({ ok: result.ok, message: result.message, latency_ms: result.latencyMs });
  });

  app.post('/providers/:id/discover', async (c) => {
    const summary = await deps.providers.discoverModels(c.req.param('id'));
    return c.json({ discovery: summary });
  });

  app.get('/providers/:id/events', (c) => c.json({ events: deps.events.forProvider(c.req.param('id'), 50) }));

  /* provider models */

  app.get('/providers/:id/models', (c) => {
    const id = c.req.param('id');
    const provider = deps.providers.get(id);
    const adapter = getAdapter(provider.adapter);
    return c.json({
      models: deps.models.forProvider(id).map((m) => ({
        ...m,
        supports_streaming: adapter ? adapter.capabilities.streaming && (m.streaming ?? false) : null,
      })),
    });
  });

  app.post('/providers/:id/models', async (c) => {
    const input = parseOrThrow(ManualModelUpsertSchema, await readJson(c));
    deps.providers.addManualModel(c.req.param('id'), input);
    return c.json({ ok: true }, 201);
  });

  app.patch('/providers/:id/models/:upstreamId', async (c) => {
    const body = (await readJson(c)) as { display_name?: unknown };
    if (typeof body.display_name !== 'string' || body.display_name.trim().length === 0) {
      throw ApiError.badRequest('Field "display_name" (1..160 chars) is required.');
    }
    deps.models.rename(c.req.param('id'), c.req.param('upstreamId'), body.display_name.trim().slice(0, 160));
    return c.json({ ok: true });
  });

  app.delete('/providers/:id/models/:upstreamId', (c) => {
    const { id, upstreamId } = c.req.param();
    if (!deps.models.get(id, upstreamId)) throw ApiError.notFound('Model not registered for this provider.');
    deps.models.delete(id, upstreamId);
    return c.json({ ok: true });
  });

  /* ─── global model explorer ─── */

  app.get('/models', (c) => {
    const q = (c.req.query('q') ?? '').toLowerCase();
    const providerFilter = c.req.query('provider_id') ?? null;
    const page = Math.max(1, Number.parseInt(c.req.query('page') ?? '1', 10) || 1);
    const perPage = Math.min(200, Math.max(10, Number.parseInt(c.req.query('per_page') ?? '50', 10) || 50));
    const sort = c.req.query('sort') ?? 'provider';

    let rows = deps.models.listAll();
    const providersById = new Map(deps.providerRepo.list().map((p) => [p.id, p] as const));
    if (providerFilter) rows = rows.filter((m) => m.provider_id === providerFilter);
    if (q) rows = rows.filter((m) => m.upstream_id.toLowerCase().includes(q) || m.display_name.toLowerCase().includes(q));
    if (sort === 'name') rows = [...rows].sort((a, b) => a.display_name.localeCompare(b.display_name));
    else if (sort === 'context') rows = [...rows].sort((a, b) => (b.context_length ?? 0) - (a.context_length ?? 0));
    else rows = [...rows].sort((a, b) => a.provider_id.localeCompare(b.provider_id) || a.upstream_id.localeCompare(b.upstream_id));

    const total = rows.length;
    const start = (page - 1) * perPage;
    return c.json({
      total,
      page,
      per_page: perPage,
      models: rows.slice(start, start + perPage).map((m) => {
        const p = providersById.get(m.provider_id);
        return {
          ...m,
          provider_enabled: p?.enabled ?? false,
          provider_adapter: p?.adapter ?? null,
          provider_name: p?.name ?? null,
        };
      }),
    });
  });

  /* ─── aliases ─── */

  app.get('/aliases', (c) => c.json({ aliases: deps.aliases.list() }));

  app.put('/aliases/:alias', async (c) => {
    const alias = c.req.param('alias');
    if (!ALIAS_RE.test(alias)) {
      throw ApiError.badRequest('Alias name must match ^[a-zA-Z0-9][a-zA-Z0-9._-]{1,63}$ (no "/").');
    }
    const rawBody = (await readJson(c)) as Record<string, unknown>;
    const input = parseOrThrow(AliasUpsertSchema, { ...rawBody, alias });
    const provider = deps.providerRepo.get(input.provider_id);
    if (!provider) throw ApiError.badRequest(`Target provider "${input.provider_id}" does not exist.`);
    if (!deps.models.get(input.provider_id, input.model)) {
      throw ApiError.badRequest(`Model "${input.model}" is not registered for provider "${input.provider_id}".`);
    }
    const fallbackRefs: string[] = [];
    for (const fb of input.fallbacks ?? []) {
      const p = deps.providerRepo.get(fb.provider_id);
      if (!p) fallbackRefs.push(fb.provider_id);
      else if (!deps.models.get(fb.provider_id, fb.model)) fallbackRefs.push(`${fb.provider_id}/${fb.model}`);
    }
    if (fallbackRefs.length > 0) {
      throw ApiError.badRequest(`Fallback targets not registered: ${fallbackRefs.join(', ')}.`);
    }
    if (input.enabled && !provider.enabled) {
      throw ApiError.badRequest(`Alias "${alias}" cannot be enabled against a disabled provider ("${provider.id}").`);
    }
    const existing = deps.aliases.get(alias);
    const record: AliasRecord = {
      alias,
      provider_id: input.provider_id,
      model: input.model,
      enabled: input.enabled,
      params: input.params ?? null,
      fallbacks: input.fallbacks ?? null,
      notes: input.notes ?? null,
      created_at: existing?.created_at ?? Date.now(),
      updated_at: Date.now(),
    };
    deps.aliases.upsert(record);
    log.info('alias saved', { alias, provider: record.provider_id, model: record.model, fallbacks: record.fallbacks?.length ?? 0 });
    return c.json({ alias: deps.aliases.get(alias) });
  });

  app.delete('/aliases/:alias', (c) => {
    const alias = c.req.param('alias');
    if (!deps.aliases.get(alias)) throw ApiError.notFound(`Alias "${alias}" does not exist.`);
    deps.aliases.delete(alias);
    return c.json({ ok: true });
  });

  /* ─── gateway keys ─── */

  app.get('/keys', (c) => c.json({ keys: deps.keys.list() }));

  app.post('/keys', async (c) => {
    const input = parseOrThrow(ApiKeyCreateSchema, await readJson(c));
    const { record, plaintext } = await deps.keys.create(input.label, input.expires_in_days ?? null);
    log.info('gateway key created', { id: record.id, prefix: record.key_prefix });
    return c.json(
      {
        key: record,
        /* Shown exactly once — the gateway stores only a scrypt hash. */
        plaintext,
        note: 'Copy this token now — it is revealed only once.',
      },
      201,
    );
  });

  app.post('/keys/:id/revoke', (c) => {
    if (!deps.keys.revoke(c.req.param('id'))) throw ApiError.notFound('Key not found or already revoked.');
    log.info('gateway key revoked', { id: c.req.param('id') });
    return c.json({ ok: true });
  });

  app.delete('/keys/:id', (c) => {
    if (!deps.keys.delete(c.req.param('id'))) throw ApiError.notFound('Key not found.');
    return c.json({ ok: true });
  });

  /* ─── request logs ─── */

  app.get('/logs', (c) => {
    const status = c.req.query('status');
    const { rows, total } = deps.logs.list({
      provider_id: c.req.query('provider_id') || null,
      status: status === 'ok' || status === 'error' ? status : null,
      since: c.req.query('since') ? Number(c.req.query('since')) : null,
      limit: c.req.query('limit') ? Number(c.req.query('limit')) : 50,
      offset: c.req.query('offset') ? Number(c.req.query('offset')) : 0,
    });
    return c.json({
      total,
      rows: rows.map(({ body_json, ...rest }) => ({ ...rest, has_body: body_json != null })),
    });
  });

  app.get('/logs/:id', (c) => {
    const rec = deps.logs.find(c.req.param('id'));
    if (!rec) throw ApiError.notFound('Log entry not found.');
    return c.json({ entry: rec });
  });

  app.delete('/logs', (c) => {
    deps.logs.clear();
    log.info('request logs cleared');
    return c.json({ ok: true });
  });

  /* ─── events feed ─── */

  app.get('/events', (c) => c.json({ events: deps.events.recent(Number(c.req.query('limit') ?? '50')) }));

  /* ─── adapters ─── */

  app.get('/adapters', (c) => c.json({ adapters: adapterSummaries() }));

  app.post('/adapters/custom', async (c) => {
    const body = (await readJson(c)) as { module_path?: unknown };
    if (typeof body.module_path !== 'string' || body.module_path.trim().length === 0) {
      throw ApiError.badRequest('Field "module_path" is required.');
    }
    const modulePath = body.module_path.trim();
    if (!/^([A-Za-z]:[\\/]|\/|file:\/\/)/.test(modulePath)) {
      throw ApiError.badRequest('module_path must be an absolute local path or file:// URL.');
    }
    if (!/\.(js|mjs|cjs)$/.test(modulePath) && !modulePath.startsWith('file://')) {
      throw ApiError.badRequest('module_path must reference a compiled JS module (.js/.mjs/.cjs).');
    }
    if (!modulePath.startsWith('file://') && !existsSync(modulePath)) {
      throw ApiError.badRequest(`Module file does not exist: ${modulePath}`);
    }
    const adapter = await loadCustomAdapterModule(modulePath);
    log.warn('custom adapter loaded', { adapter: adapter.id, path: modulePath });
    return c.json(
      { ok: true, adapter: { id: adapter.id, label: adapter.label, description: adapter.description, capabilities: adapter.capabilities } },
      201,
    );
  });

  /* ─── settings ─── */

  app.get('/settings', (c) =>
    c.json({
      settings: { ...deps.settings.live },
      dashboard_password:
        deps.ownerAuth.mode === 'database'
          ? 'provisioned (owner credential, scrypt hash)'
          : deps.ownerAuth.mode === 'environment'
            ? 'configured (environment)'
            : 'not configured (loopback-only mode)',
      notes: {
        rate_limit_per_minute: 'Sustained requests per minute per gateway key.',
        rate_limit_burst: 'Token-bucket burst ceiling per gateway key.',
        max_inflight_requests: 'Global concurrent in-flight request cap.',
        stream_max_events: 'Safety cap on relayed SSE chunks per response.',
        debug_log_request_bodies: 'Stores request bodies in request logs (privacy-sensitive).',
      },
    }),
  );

  app.put('/settings', async (c) => {
    const patch = parseOrThrow(SettingsPatchSchema, await readJson(c));
    if (
      patch.rate_limit_burst !== undefined &&
      patch.rate_limit_per_minute !== undefined &&
      patch.rate_limit_burst < patch.rate_limit_per_minute / 60
    ) {
      throw ApiError.badRequest('rate_limit_burst must be at least rate_limit_per_minute / 60.');
    }
    const merged = deps.settings.patch(patch);
    log.info('settings updated', { keys: Object.keys(patch) });
    return c.json({ settings: merged satisfies Settings });
  });

  /* ─── playground ─── */

  app.post('/playground/chat', async (c) => {
    const started = Date.now();
    const requestId = `pg_${randomId('r').slice(2)}`;
    const raw = await readJson(c);
    const parse = parseOrThrow(UnifiedChatRequestSchema, raw);
    const req: UnifiedChatRequest = parse;
    const stream = req.stream === true;
    const inflightKey = 'playground';

    const inflightWait = deps.limiter.tryAcquireInflight(inflightKey);
    if (inflightWait !== null) throw ApiError.rateLimited(inflightWait, 'Playground concurrent cap reached.');

    const bodyStore = deps.settings.live.debug_log_request_bodies ? safeJson(req) : null;
    let providerUsed: { id: string; name: string } | null = null;

    try {
      const resolved = deps.runtime.resolveTarget(req.model);
      if (resolved instanceof ApiError) throw resolved;
      if (resolved.kind !== 'target') throw ApiError.internal('Unexpected route resolution state.');
      providerUsed = { id: resolved.target.provider.id, name: resolved.target.provider.name };

      if (stream) {
        const handle = await deps.runtime.streamOnce(req, {
          provider: resolved.target.provider,
          modelId: resolved.target.modelId,
        });
        applySseHeaders(c);
        c.header('x-request-id', requestId);
        const { stream: body } = relaySse(
          handle.events,
          {
            requestedModel: req.model,
            provider: handle.provider.id,
            modelId: handle.modelId,
            requestId,
            maxEvents: deps.settings.live.stream_max_events,
          },
          (stats) => recordPlayground(deps, requestId, started, req, { id: handle.provider.id, name: handle.provider.name }, true, bodyStore, stats),
        );
        return c.newResponse(body, 200);
      }

      const outcome = await deps.runtime.chatWithFallbacks(req, {
        provider: resolved.target.provider,
        modelId: resolved.target.modelId,
        alias: resolved.target.alias,
        fallbacks: resolved.target.fallbacks,
      });
      if ('error' in outcome) throw outcome.error;
      deps.logs.add(
        playgroundBlockingLog(requestId, started, req, providerUsed, resolved.target.alias?.alias ?? null, bodyStore, Date.now() - started, outcome.shape.usage ?? null),
      );
      return c.json(outcome.shape, 200);
    } catch (err) {
      const apiErr = toApiError(err);
      deps.logs.add({
        id: requestId,
        ts: started,
        source: 'playground',
        client_key_id: null,
        provider_id: providerUsed?.id ?? null,
        provider_name: providerUsed?.name ?? null,
        model: req.model,
        alias: null,
        stream,
        status: apiErr.status >= 400 ? apiErr.status : 500,
        duration_ms: Date.now() - started,
        error_code: apiErr.code,
        error_message: apiErr.message,
        body_json: bodyStore,
      });
      throw err;
    } finally {
      deps.limiter.releaseInflight(inflightKey);
    }
  });

  /* ─── diagnostics ─── */

  app.get('/diagnostics', (c) =>
    c.json({
      server: {
        env: deps.cfg.env,
        host: deps.cfg.host,
        port: deps.cfg.port,
        allow_remote: deps.cfg.allowRemote,
        dashboard_password: deps.ownerAuth.mode !== 'loopback_only',
        data_dir: deps.cfg.dataDir,
        dev_cors_origin: deps.cfg.devCorsOrigin,
      },
      counts: {
        providers: deps.providerRepo.list().length,
        providers_enabled: deps.providerRepo.list().filter((p) => p.enabled).length,
        models: deps.models.countAll(),
        aliases: deps.aliases.list().length,
        gateway_keys: deps.keys.list().length,
        gateway_keys_active: deps.keys.list().filter((k) => !k.revoked_at && (!k.expires_at || k.expires_at > Date.now())).length,
      },
      settings: { ...deps.settings.live },
      adapters: listAdapters().map((a) => ({ id: a.id, capabilities: a.capabilities })),
      limits: {
        request_body_bytes: '2 MiB (gateway + admin)',
        upstream_response_bytes: '16 MiB cap per upstream response',
        master_key: 'AES-256-GCM; stored in data/.master_key or ZEROROUTER_MASTER_KEY',
      },
    }),
  );

  return app;
}

/* ─── helpers ─── */

function recordPlayground(
  deps: AdminDeps,
  requestId: string,
  started: number,
  req: UnifiedChatRequest,
  provider: { id: string; name: string },
  stream: boolean,
  bodyStore: string | null,
  stats: RelayStats,
): void {
  deps.logs.add({
    id: requestId,
    ts: started,
    source: 'playground',
    client_key_id: null,
    provider_id: provider.id,
    provider_name: provider.name,
    model: req.model,
    alias: null,
    stream,
    status: stats.aborted && !stats.usage ? 499 : 200,
    duration_ms: Date.now() - started,
    prompt_tokens: stats.usage?.prompt_tokens ?? null,
    completion_tokens: stats.usage?.completion_tokens ?? null,
    error_code: stats.errorCode,
    error_message: stats.errorMessage,
    body_json: bodyStore,
  });
  log.info('playground stream finished', { id: requestId, chunks: stats.chunks, error: stats.errorCode, aborted: stats.aborted });
}

function playgroundBlockingLog(
  id: string,
  ts: number,
  req: UnifiedChatRequest,
  provider: { id: string; name: string } | null,
  alias: string | null,
  bodyStore: string | null,
  durationMs: number,
  usage: { prompt_tokens?: number; completion_tokens?: number } | null,
): RequestLogInput {
  return {
    id,
    ts,
    source: 'playground',
    client_key_id: null,
    provider_id: provider?.id ?? null,
    provider_name: provider?.name ?? null,
    model: req.model,
    alias,
    stream: false,
    status: 200,
    duration_ms: durationMs,
    prompt_tokens: usage?.prompt_tokens ?? null,
    completion_tokens: usage?.completion_tokens ?? null,
    error_code: null,
    error_message: null,
    body_json: bodyStore,
  };
}

function readSessionValid(deps: AdminDeps, c: Context): boolean {
  const sid = readCookie(c, SESSION_COOKIE);
  return sid !== null && deps.sessions.valid(sid);
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

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return '';
  }
}
