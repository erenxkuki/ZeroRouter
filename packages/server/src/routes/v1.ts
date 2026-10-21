/**
 * The OpenAI-compatible gateway surface: /v1/chat/completions + /v1/models.
 * Authentication, rate limiting, request logging, and error normalization
 * happen here; providers differ only through their adapters.
 */
import { Hono } from 'hono';
import { UnifiedChatRequestSchema, type ProviderRecord, type UnifiedChatRequest } from '../types.js';
import { ApiError, toApiError } from '../errors.js';
import { randomId } from '../crypto.js';
import { logger } from '../logger.js';
import type { ChatRuntime } from '../services/chatRuntime.js';
import type { RequestLogs, RequestLogInput } from '../services/requestLogs.js';
import type { RateLimiter } from '../services/rateLimit.js';
import type { SettingsService } from '../services/settings.js';
import { relaySse, applySseHeaders, type RelayStats } from '../services/sseRelay.js';
import { gatewayKeyAuth, type GatewayKeyDeps } from '../middleware.js';
import type { AliasRepo, AuthenticatedKey, ModelRepo, ProviderRepo } from '../db/repos.js';

const log = logger('v1');

export interface V1Deps {
  runtime: ChatRuntime;
  providers: ProviderRepo;
  models: ModelRepo;
  aliases: AliasRepo;
  logs: RequestLogs;
  limiter: RateLimiter;
  settings: SettingsService;
  auth: GatewayKeyDeps;
}

export interface V1Variables {
  gatewayKey: AuthenticatedKey;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return '';
  }
}

export function createV1Routes(deps: V1Deps): Hono<{ Variables: V1Variables }> {
  const app = new Hono<{ Variables: V1Variables }>();

  app.use('*', async (c, next) => {
    const res = await gatewayKeyAuth(deps.auth, c, next);
    if (res) return res;
  });

  /* ─── service info & discovery ─── */

  app.get('/', (c) =>
    c.json({
      ok: true,
      service: 'zerorouter',
      version: 1,
      endpoints: ['/v1/chat/completions', '/v1/models'],
    }),
  );

  app.get('/models', async (c) => {
    const now = Math.floor(Date.now() / 1000);
    const data: Array<{ id: string; object: string; created: number; owned_by: string }> = [];
    for (const provider of await deps.providers.list()) {
      if (!provider.enabled) continue;
      for (const m of await deps.models.forProvider(provider.id)) {
        data.push({ id: `${provider.id}/${m.upstream_id}`, object: 'model', created: now, owned_by: provider.id });
      }
    }
    for (const alias of await deps.aliases.list()) {
      if (!alias.enabled) continue;
      data.push({ id: alias.alias, object: 'model', created: now, owned_by: 'zerorouter:alias' });
    }
    data.sort((a, b) => a.id.localeCompare(b.id));
    return c.json({ object: 'list', data });
  });

  app.post('/chat/completions', async (c) => {
    const started = Date.now();
    const requestId = randomId('req');
    const key = c.get('gatewayKey');
    const inflightKey = key.id;
    let modelRaw: string | null = null;
    let stream = false;
    let parsed: UnifiedChatRequest | null = null;

    // Limiter reservation (must precede any provider contact)
    const rateWait = deps.limiter.tryConsume(inflightKey);
    if (rateWait !== null) {
      await deps.logs.add(gatewayRecord(started, requestId, key, { model: null, stream: false, body: null }, 429, 'rate_limited', 'Rate limit exceeded.', 0));
      const err = ApiError.rateLimited(rateWait);
      log.warn('rate limit rejected', { key: inflightKey, retry_after_ms: rateWait });
      throw err;
    }
    const inflightWait = deps.limiter.tryAcquireInflight(inflightKey);
    if (inflightWait !== null) {
      await deps.logs.add(gatewayRecord(started, requestId, key, { model: null, stream: false, body: null }, 429, 'rate_limited', 'Concurrent request cap reached.', 0));
      throw ApiError.rateLimited(inflightWait, 'Concurrent request cap reached. Slow down or retry shortly.');
    }

    try {
      let rawBody: unknown;
      try {
        rawBody = await c.req.json();
      } catch {
        throw ApiError.badRequest('Request body must be valid JSON.');
      }
      const parsedBody = UnifiedChatRequestSchema.safeParse(rawBody);
      if (!parsedBody.success) {
        throw ApiError.unprocessable('Invalid chat request.', {
          issues: parsedBody.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
      }
      parsed = parsedBody.data;
      modelRaw = parsed.model;
      stream = parsed.stream === true;
      const bodyStore = deps.settings.live.debug_log_request_bodies ? safeJson(parsed) : null;

      if (stream) {
        const resolved = await deps.runtime.resolveTarget(parsed.model);
        if (resolved instanceof ApiError) throw resolved;
        if (resolved.kind !== 'target') throw ApiError.internal('Unexpected route resolution state.');
        const handle = await deps.runtime.streamOnce(parsed, {
          provider: resolved.target.provider,
          modelId: resolved.target.modelId,
        });
        applySseHeaders(c);
        c.header('x-request-id', requestId);
        const { stream: body } = relaySse(
          handle.events,
          {
            requestedModel: parsed.model,
            provider: handle.provider.id,
            modelId: handle.modelId,
            requestId,
            maxEvents: deps.settings.live.stream_max_events,
          },
          (stats) => void recordStreamCompletion(deps, handle.provider, parsed as UnifiedChatRequest, requestId, started, key, bodyStore, stats),
        );
        log.info('stream started', { id: requestId, provider: handle.provider.id, model: resolved.target.modelId });
        return c.newResponse(body, 200);
      }

      const target = await deps.runtime.resolveTarget(parsed.model);
      if (target instanceof ApiError) throw target;
      if (target.kind !== 'target') throw ApiError.internal('Unexpected route resolution state.');
      const outcome = await deps.runtime.chatWithFallbacks(
        parsed,
        {
          provider: target.target.provider,
          modelId: target.target.modelId,
          alias: target.target.alias,
          fallbacks: target.target.fallbacks,
        },
      );
      if ('error' in outcome) throw outcome.error;
      const last = outcome.attempts.at(-1) ?? null;
      log.info('chat completed', {
        id: requestId,
        provider: last?.provider.id ?? null,
        model: target.target.modelId,
        ms: Date.now() - started,
      });
      await deps.logs.add(gatewayRecord(started, requestId, key, { model: modelRaw, stream: false, body: bodyStore }, 200, null, null, Date.now() - started, {
        provider_id: last?.provider.id ?? null,
        provider_name: last?.provider.name ?? null,
        alias: target.target.alias?.alias ?? null,
        prompt_tokens: outcome.shape.usage?.prompt_tokens ?? null,
        completion_tokens: outcome.shape.usage?.completion_tokens ?? null,
      }));
      return c.json(outcome.shape, 200);
    } catch (err) {
      const apiErr = toApiError(err);
      await deps.logs.add(
        gatewayRecord(started, requestId, key, { model: modelRaw, stream, body: deps.settings.live.debug_log_request_bodies && parsed ? safeJson(parsed) : null }, apiErr.status >= 400 ? apiErr.status : 500, apiErr.code, apiErr.message, Date.now() - started),
      );
      throw err;
    } finally {
      deps.limiter.releaseInflight(inflightKey);
    }
  });

  return app;
}

/* ─── helpers ─── */

/** Records a stream run's final state (called exactly once from relaySse). */
async function recordStreamCompletion(
  deps: V1Deps,
  provider: ProviderRecord,
  req: UnifiedChatRequest,
  requestId: string,
  started: number,
  key: AuthenticatedKey,
  bodyStore: string | null,
  stats: RelayStats,
): Promise<void> {
  const status = stats.aborted && !stats.usage ? 499 : 200;
  await deps.logs.add({
    id: requestId,
    ts: started,
    source: 'gateway',
    client_key_id: key.id,
    provider_id: provider.id,
    provider_name: provider.name,
    model: req.model,
    alias: null,
    stream: true,
    status,
    duration_ms: Date.now() - started,
    prompt_tokens: stats.usage?.prompt_tokens ?? null,
    completion_tokens: stats.usage?.completion_tokens ?? null,
    error_code: stats.errorCode,
    error_message: stats.errorMessage,
    body_json: bodyStore,
  });
  log.info('stream finished', {
    id: requestId,
    provider: provider.id,
    chunks: stats.chunks,
    finish: stats.finishReason,
    error: stats.errorCode,
    aborted: stats.aborted,
  });
}

function gatewayRecord(
  startedTs: number,
  requestId: string,
  key: AuthenticatedKey,
  ctx: { model: string | null; stream: boolean; body: string | null },
  status: number,
  errorCode: string | null,
  errorMessage: string | null,
  durationMs: number,
  extra: Partial<RequestLogInput> = {},
): RequestLogInput {
  return {
    id: requestId,
    ts: startedTs,
    source: 'gateway',
    client_key_id: key.id,
    model: ctx.model,
    stream: ctx.stream,
    status,
    duration_ms: durationMs,
    error_code: errorCode,
    error_message: errorMessage,
    body_json: ctx.body,
    ...extra,
  };
}
