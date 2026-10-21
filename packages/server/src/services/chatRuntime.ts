import { ApiError } from '../errors.js';
import { logger } from '../logger.js';
import type { Executor } from '../db/storage.js';
import { ProviderRepo, ModelRepo, AliasRepo, RoutingRepo } from '../db/repos.js';
import { getAdapter } from '../adapters/registry.js';
import { makeTransportHooks } from '../adapters/transport-helpers.js';
import type {
  AliasRecord,
  Credentials,
  ProviderRecord,
  ResolvedTarget,
  UnifiedChatRequest,
  UnifiedChatResponse,
  UnifiedStreamEvent,
  UnifiedStreamEvent as USTE,
} from '../types.js';
import { randomId } from '../crypto.js';
import type { UrlPolicy } from '../transport.js';
import type { AdapterContext } from '../adapters/base.js';
import { providerUrlPolicy } from './providerService.js';

const log = logger('chat-runtime');

export interface ChatRuntimeConfig {
  /** Legacy global policy default; per-provider config always overrides. */
  urlPolicy: UrlPolicy;
}

export interface ChatAttempt {
  provider: ProviderRecord;
  model: string;
  viaAlias: string | null;
  fallbackIndex: number;
}

/**
 * Executes a validated unified chat request end-to-end: resolves the target,
 * loads provider credentials, and performs a non-streaming or streaming call.
 * Handles alias parameter overrides and explicit fallback targets.
 */
export class ChatRuntime {
  private routing: RoutingRepo;

  constructor(
    private readonly db: Executor,
    private readonly providers: ProviderRepo,
    models: ModelRepo,
    aliases: AliasRepo,
    private readonly cfg: ChatRuntimeConfig,
  ) {
    this.routing = new RoutingRepo(db, providers, models, aliases);
  }

  /* ── target resolution ── */

  async resolveTarget(modelRaw: string): Promise<
    | { kind: 'target'; target: { providerId: string; provider: ProviderRecord; modelId: string; alias: AliasRecord | null; fallbacks: { provider_id: string; model: string }[] } }
    | ApiError
  > {
    const resolved = await this.routing.resolve(modelRaw);
    if (resolved === null) {
      // produce helpful candidates
      const hints = await this.modelCandidates(modelRaw);
      const err = new ApiError(404, 'not_found', `Model "${modelRaw}" is not registered. Available identifiers use "provider/model" form or a configured alias.`, {
        details: { candidates: hints.slice(0, 5) },
      });
      return err;
    }
    if ('ambiguous' in resolved) {
      const matches = ((resolved as { ambiguous?: unknown }).ambiguous as string[]) ?? [];
      if (matches.length === 0) {
        return ApiError.notFound(`Model "${modelRaw}" is not registered. Use "provider/model" or a configured alias.`);
      }
      return ApiError.conflict(
        `Ambiguous model "${modelRaw}" exists on multiple providers. Route explicitly with "provider/model".`,
        { matches },
      );
    }
    if ('providerId' in resolved) {
      const direct = resolved as ResolvedTarget;
      const provider = await this.providers.get(direct.providerId);
      if (!provider) {
        return ApiError.notFound(`Provider "${direct.providerId}" does not exist. Use "provider/model" or an alias.`);
      }
      if (!provider.enabled) {
        return ApiError.disabled(`Provider "${provider.id}" is disabled.`);
      }
      return {
        kind: 'target',
        target: { providerId: provider.id, provider, modelId: direct.modelId, alias: null, fallbacks: [] },
      };
    }
    if ('alias' in resolved) {
      const alias = resolved as AliasRecord;
      if (!alias.enabled) {
        return ApiError.disabled(`Alias "${alias.alias}" is disabled.`);
      }
      const provider = await this.providers.get(alias.provider_id);
      if (!provider) return ApiError.notFound(`Alias target provider "${alias.provider_id}" no longer exists.`);
      return {
        kind: 'target',
        target: {
          providerId: provider.id,
          provider,
          modelId: alias.model,
          alias,
          fallbacks: alias.fallbacks ?? [],
        },
      };
    }
    return ApiError.notFound(`Unroutable model "${modelRaw}".`);
  }

  private async modelCandidates(query: string): Promise<string[]> {
    const rows = (await this.db.query(
      'SELECT provider_id, upstream_id, display_name FROM models WHERE upstream_id LIKE ? OR display_name LIKE ? LIMIT 6',
      [`%${query}%`, `%${query}%`],
    )) as Array<{ provider_id: string; upstream_id: string; display_name: string }>;
    return rows.map((r) => `${r.provider_id}/${r.upstream_id}`);
  }

  /* ── adapter context ── */

  private contextFor(provider: ProviderRecord): { ctx: AdapterContext; error?: ApiError } {
    const adapter = getAdapter(provider.adapter);
    if (!adapter) {
      return { ctx: undefined as never, error: ApiError.internal(`Unknown adapter "${provider.adapter}".`) };
    }
    const credentials = this.providers.credentials(provider);
    const ctx: AdapterContext = {
      provider,
      credentials,
      transport: makeTransportHooks(providerUrlPolicy(provider.config)),
    };
    return { ctx };
  }

  /* ── merge alias params safely (non-stream only; stream untouched) ── */

  static overrideRequest(req: UnifiedChatRequest, aliasParams: Record<string, unknown> | null | undefined): UnifiedChatRequest {
    if (!aliasParams || typeof aliasParams !== 'object') return req;
    const next: UnifiedChatRequest = { ...req };
    if (typeof aliasParams['temperature'] === 'number') next.temperature = aliasParams['temperature'];
    if (typeof aliasParams['top_p'] === 'number') next.top_p = aliasParams['top_p'];
    if (typeof aliasParams['max_tokens'] === 'number') (next as { max_tokens?: number }).max_tokens = aliasParams['max_tokens'];
    if (typeof aliasParams['stop'] === 'string') next.stop = aliasParams['stop'];
    return next;
  }

  /* ── non-streaming ── */

  async chatOnce(req: UnifiedChatRequest, target: { provider: ProviderRecord; modelId: string }): Promise<import('../adapters/base.js').ChatOutcome> {
    const provider = target.provider;
    if (!provider.enabled) throw ApiError.disabled(`Provider "${provider.id}" is disabled.`);
    const adapter = getAdapter(provider.adapter);
    if (!adapter) throw ApiError.internal(`Unknown adapter "${provider.adapter}".`);
    const { ctx } = this.contextFor(provider);
    return adapter.chat(ctx, req, target.modelId);
  }

  /**
   * Full non-streaming call with explicit, user-configured fallback chain
   * (aliases only, bounded, never implicit).
   */
  async chatWithFallbacks(
    reqBase: UnifiedChatRequest,
    target: { provider: ProviderRecord; modelId: string; alias: AliasRecord | null; fallbacks: { provider_id: string; model: string }[] },
  ): Promise<
    | {
        shape: import('../adapters/base.js').UnifiedChatResponseShape;
        providerMeta?: Record<string, unknown>;
        attempts: ChatAttempt[];
      }
    | { attempts: ChatAttempt[]; error: ApiError }
  > {
    const req = ChatRuntime.overrideRequest(reqBase, target.alias?.params ?? null);
    const attempts: ChatAttempt[] = [];
    const chain: { provider: ProviderRecord; modelId: string }[] = [
      { provider: target.provider, modelId: target.modelId },
    ];
    for (const fb of target.fallbacks.slice(0, 3)) {
      const p = await this.providers.get(fb.provider_id);
      if (p && p.enabled) chain.push({ provider: p, modelId: fb.model });
    }
    let lastError: ApiError | null = null;
    for (const attempt of chain) {
      attempts.push({ provider: attempt.provider, model: attempt.modelId, viaAlias: target.alias?.alias ?? null, fallbackIndex: attempts.length });
      try {
        const res = await this.chatOnce(req, attempt);
        const shape = finalizeShape(res.response, attempt.provider, attempt.modelId, target.alias?.alias ?? reqBase.model);
        return { shape, providerMeta: res.providerMeta, attempts };
      } catch (err) {
        lastError = err instanceof ApiError ? err : (log_error(err), ApiError.internal());
        if (!lastError.retriable || chain.length === 1) break;
        log.warn('attempt failed; trying next configured fallback', {
          provider: attempt.provider.id,
          model: attempt.modelId,
          error: lastError.code,
        });
      }
    }
    return { attempts, error: lastError ?? ApiError.internal() };
  }

  /* ── streaming ── */

  async streamOnce(reqBase: UnifiedChatRequest, attempt: { provider: ProviderRecord; modelId: string }): Promise<ChatStreamHandle> {
    const provider = attempt.provider;
    if (!provider.enabled) {
      throw ApiError.disabled(`Provider "${provider.id}" is disabled.`);
    }
    const adapter = getAdapter(provider.adapter);
    if (!adapter) throw ApiError.internal(`Unknown adapter "${provider.adapter}".`);
    if (!adapter.capabilities.streaming) {
      throw ApiError.upstream(
        400,
        'unsupported_feature',
        `Provider "${provider.id}" (adapter ${adapter.id}) does not support streaming. Send stream:false or choose another provider.`,
      );
    }
    const { ctx } = this.contextFor(provider);
    const req = ChatRuntime.overrideRequest(reqBase, await this.aliasParamsForStreaming(reqBase));
    return adapter.chatStream(ctx, req, attempt.modelId).then((outcome) => ({
      ...outcome,
      adapter,
      provider,
      modelId: attempt.modelId,
    }));
  }

  private async aliasParamsForStreaming(req: UnifiedChatRequest): Promise<Record<string, unknown> | null> {
    const direct = await this.resolveTarget(req.model);
    if (direct && 'kind' in direct && direct.kind === 'target' && direct.target.alias) {
      return direct.target.alias.params ?? null;
    }
    return null;
  }

  async resolveAliasFallbacks(req: UnifiedChatRequest): Promise<{ provider: ProviderRecord; modelId: string; alias: AliasRecord | null; fallbacks: { provider_id: string; model: string }[] }> {
    const t = await this.resolveTarget(req.model);
    if (t instanceof ApiError) throw t;
    if (!('kind' in t)) throw ApiError.internal('unexpected resolution state');
    return { provider: t.target.provider, modelId: t.target.modelId, alias: t.target.alias, fallbacks: t.target.fallbacks };
  }
}

function log_error(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  log.error('unknown error during chat', { err: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
  return ApiError.internal();
}

function finalizeShape(
  shape: import('../adapters/base.js').UnifiedChatResponseShape,
  provider: ProviderRecord,
  modelId: string,
  requestedModel: string,
): import('../types.js').UnifiedChatResponse {
  const rid = randomId('req');
  const response: UnifiedChatResponse = {
    id: `chatcmpl-${rid.slice(4)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: `${provider.id}/${modelId}`,
    provider: provider.id,
    choices: shape.choices.map((c) => ({
      index: c.index,
      message: {
        role: 'assistant',
        content: c.message.content,
        tool_calls: c.message.tool_calls as UnifiedChatResponse['choices'][number]['message']['tool_calls'],
        refusal: c.message.refusal ?? null,
      },
      finish_reason: (c.finish_reason as import('../types.js').UnifiedFinishReason) ?? null,
      native_finish_reason: c.native_finish_reason ?? undefined,
    })),
    usage: shape.usage ?? null,
    request_id: rid,
    provider_meta: {
      requested: requestedModel,
      upstream_model: shape.model,
    },
  };
  return response;
}

export interface ChatStreamHandle {
  events: AsyncIterable<UnifiedStreamEvent>;
  providerMeta?: Record<string, unknown>;
  adapter: import('../adapters/base.js').Adapter;
  provider: ProviderRecord;
  modelId: string;
}

export type { USTE };
