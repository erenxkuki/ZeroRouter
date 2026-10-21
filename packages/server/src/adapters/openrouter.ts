/**
 * OpenRouter adapter.
 *
 * Verified against the live API (October 2026):
 *  - POST {base}/chat/completions  (OpenAI-compatible shape)
 *  - GET  {base}/models  → { data: [ { id, canonical_slug, name, description, context_length,
 *      architecture: { modality, input_modalities, output_modalities },
 *      pricing: { prompt, completion, ... }, supported_parameters, top_provider } ] }
 *  - Errors: { error: { code, message, metadata? } } with typed `error_type`.
 *  - Streaming: OpenAI SSE chunks; mid-stream errors as chunk with top-level `error`
 *    and `choices[0].finish_reason: "error"`.
 *
 * Only implemented verified behavior; unknowns stay unknown.
 */
import type {
  AdapterContext,
  ChatOutcome,
  ChatStreamOutcome,
  ConfigValidation,
  ConnectionTestResult,
  DiscoveryOutcome,
  DiscoveredModel,
  AdapterCapabilities,
  Adapter,
} from './base.js';
import { upstreamStatusError } from './transport-helpers.js';
import { urlWithQuery } from './utils.js';
import {
  OpenAICompatibleAdapter,
  baseUrlOf,
  modelsPathOf,
  testTimeoutOf,
  requireAuthHeaders,
  mapToOpenaiBody,
  createOpenAiSseIterator,
  type StreamStateRef,
} from './openai-compatible.js';
import { performJson } from './transport-helpers.js';
import type { UnifiedChatRequest } from '../types.js';

interface OpenRouterModel {
  id: unknown;
  name?: unknown;
  created?: unknown;
  description?: unknown;
  context_length?: unknown;
  architecture?: {
    modality?: unknown;
    input_modalities?: unknown;
    output_modalities?: unknown;
    tokenizer?: unknown;
  };
  pricing?: Record<string, unknown>;
  top_provider?: { context_length?: unknown; max_completion_tokens?: unknown; is_moderated?: unknown };
  supported_parameters?: unknown;
}

export class OpenRouterAdapter extends OpenAICompatibleAdapter implements Adapter {
  override readonly id: string = 'openrouter';
  override readonly label: string = 'OpenRouter';
  override readonly description: string =
    'openrouter.ai — OpenAI-compatible chat completions with rich model metadata discovery.';

  override readonly capabilities: AdapterCapabilities = {
    discovery: true,
    streaming: true,
    tools: 'full',
    multimodalTextImage: true,
  };

  /** OpenRouter base URL defaults to https://openrouter.ai/api/v1 (verified). */
  override validateConfig(_config: unknown, baseUrl: string | null): ConfigValidation {
    const config = (typeof _config === 'object' && _config !== null ? _config : {}) as Record<string, unknown>;
    const allowed = new Set(['models_path', 'chat_path', 'extra_headers', 'http_referer', 'app_title']);
    for (const key of Object.keys(config)) {
      if (!allowed.has(key)) {
        return { ok: false, error: `Unknown OpenRouter option "${key}". Allowed: ${[...allowed].join(', ')}` };
      }
    }
    if (config['http_referer'] !== undefined && typeof config['http_referer'] !== 'string') {
      return { ok: false, error: 'http_referer must be a string URL.' };
    }
    if (config['app_title'] !== undefined && typeof config['app_title'] !== 'string') {
      return { ok: false, error: 'app_title must be a string.' };
    }
    // Delegate path/header/share validation to the shared engine
    const shared = super.validateConfig(
      { models_path: config['models_path'], chat_path: config['chat_path'], extra_headers: config['extra_headers'] },
      baseUrl ?? 'https://openrouter.ai/api/v1',
    );
    if (!shared.ok) return shared;
    return { ok: true, config };
  }

  override async discover(ctx: AdapterContext): Promise<DiscoveryOutcome> {
    const base = baseUrlOf(ctx);
    const url = urlWithQuery(base, modelsPathOf(ctx), {});
    const headers = requireAuthHeaders(ctx);
    const res = await performJson(ctx, {
      url,
      method: 'GET',
      headers,
      timeoutMs: testTimeoutOf(ctx),
    });
    if (res.statusFailed) throw upstreamStatusError(ctx, res.status, res.text);
    if (!res.json || typeof res.json !== 'object') {
      throw upstreamStatusError(ctx, 502, 'OpenRouter model list was not JSON.');
    }
    const data = (res.json as Record<string, unknown>)['data'];
    if (!Array.isArray(data)) {
      throw upstreamStatusError(ctx, 502, 'OpenRouter model list did not contain "data".');
    }
    const models: DiscoveredModel[] = [];
    for (const item of data as OpenRouterModel[]) {
      if (!item || typeof item !== 'object' || typeof item.id !== 'string') continue;
      const inputMods = modalitiesOf(item.architecture?.input_modalities);
      const outputMods = modalitiesOf(item.architecture?.output_modalities);
      const params = Array.isArray(item.supported_parameters)
        ? (item.supported_parameters as unknown[]).filter((x): x is string => typeof x === 'string')
        : null;
      models.push({
        upstreamId: item.id,
        displayName: typeof item.name === 'string' && item.name ? item.name : item.id,
        contextLength: intOrNull(item.context_length) ?? intOrNull(item.top_provider?.context_length),
        inputModalities: inputMods,
        outputModalities: outputMods,
        supportedParameters: params,
        streaming: params?.includes('stream') ? true : params === null ? null : false,
        tools: params?.includes('tools') || params?.includes('tool_choice') ? true : params === null ? null : false,
        reasoning: params?.includes('reasoning') || params?.includes('include_reasoning') ? true : params === null ? null : false,
        pricing: pricingOf(item.pricing),
        raw: rawCapped({ created: item.created, modality: item.architecture?.modality, max_completion_tokens: item.top_provider?.max_completion_tokens }),
      });
    }
    return { models, note: models.length === 0 ? 'OpenRouter returned no model entries.' : undefined };
  }

  override async testConnection(ctx: AdapterContext): Promise<ConnectionTestResult> {
    const started = Date.now();
    try {
      const url = urlWithQuery(baseUrlOf(ctx), modelsPathOf(ctx), {});
      const res = await performJson(ctx, {
        url,
        method: 'GET',
        headers: requireAuthHeaders(ctx),
        timeoutMs: testTimeoutOf(ctx),
      });
      const latency = Date.now() - started;
      if (res.statusFailed) {
        const apiErr = upstreamStatusError(ctx, res.status, res.text);
        return { ok: false, message: apiErr.message, latencyMs: latency, upstreamStatus: res.status };
      }
      const count = Array.isArray((res.json as Record<string, unknown> | null)?.['data'])
        ? ((res.json as { data: unknown[] }).data.length)
        : 0;
      return {
        ok: true,
        message: `OpenRouter reachable — ${count} model entries.`,
        latencyMs: latency,
        upstreamStatus: res.status,
      };
    } catch (err) {
      return { ok: false, message: String(err instanceof Error ? err.message : err), latencyMs: Date.now() - started };
    }
  }

  override chat(ctx: AdapterContext, req: UnifiedChatRequest, resolvedModel: string): Promise<ChatOutcome> {
    // Attribution headers are optional per OpenRouter docs; use configured values.
    const pluginCtx = withAttribution(ctx);
    return super.chat(pluginCtx, req, resolvedModel);
  }

  override chatStream(ctx: AdapterContext, req: UnifiedChatRequest, resolvedModel: string): Promise<ChatStreamOutcome> {
    return super.chatStream(withAttribution(ctx), req, resolvedModel);
  }

  /** OpenRouter mid-stream errors: chunk with top-level `error` and finish_reason "error". */
  override buildStreamParser(stream: import('node:http').IncomingMessage, state: StreamStateRef) {
    return createOpenAiSseIterator(stream, state);
  }
}

function typeMapOf(v: unknown): Record<string, string> {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val === 'string') out[k] = val;
    }
    return out;
  }
  return {};
}

/** Merges OpenRouter attribution headers (HTTP-Referer / X-Title) if configured. */
function withAttribution(ctx: AdapterContext): AdapterContext {
  const headers: Record<string, string> = {};
  const referer = ctx.provider.config['http_referer'];
  const title = ctx.provider.config['app_title'];
  if (typeof referer === 'string' && referer) headers['http-referer'] = referer;
  if (typeof title === 'string' && title) headers['x-title'] = title;
  if (Object.keys(headers).length === 0) return ctx;
  return {
    ...ctx,
    provider: {
      ...ctx.provider,
      config: {
        ...ctx.provider.config,
        extra_headers: { ...typeMapOf(ctx.provider.config['extra_headers']), ...headers },
      },
    },
  };
}

function modalitiesOf(v: unknown): string[] | null {
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v as string[];
  return null;
}

function intOrNull(v: unknown): number | null {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return v;
  return null;
}

function pricingOf(pricing: Record<string, unknown> | undefined):
  | { prompt_per_token: string; completion_per_token: string }
  | null {
  if (!pricing) return null;
  const prompt = pricing['prompt'];
  const completion = pricing['completion'];
  if (typeof prompt === 'string' && typeof completion === 'string') {
    return { prompt_per_token: prompt, completion_per_token: completion };
  }
  return null;
}

function rawCapped(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    out[k] = typeof v === 'object' ? safeSmallNode(v) : v;
  }
  return out;
}

function safeSmallNode(v: unknown): unknown {
  try {
    const s = JSON.stringify(v);
    return s.length > 120 ? undefined : v;
  } catch {
    return undefined;
  }
}
