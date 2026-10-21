/**
 * Generic declarative REST adapter.
 *
 * Maps a unified chat request into an arbitrary JSON HTTP API using a
 * validated field-mapping configuration. No streaming (declared via
 * capabilities): requests with stream:true are rejected with an explicit error
 * rather than silently degrading to buffered output.
 *
 * Mapping grammar (see docs/adapters.md):
 *  - body_template: JSON object; string values equal to "$messages",
 *    "$last_user", "$model", "$max_tokens", "$temperature", "$top_p", "$stop",
 *    "$stream" are substituted. Other strings must not contain dollar refs.
 *  - response.*_path: dot/bracket extraction paths, e.g. "choices[0].message.content".
 */
import { ApiError } from '../errors.js';
import { logger } from '../logger.js';
import type {
  Adapter,
  AdapterCapabilities,
  AdapterContext,
  ChatOutcome,
  ChatStreamOutcome,
  ConfigValidation,
  ConnectionTestResult,
  DiscoveryOutcome,
  DiscoveredModel,
  UnifiedChatResponseChoiceShape,
  UnifiedChatResponseShape,
} from './base.js';
import { performJson, upstreamStatusError } from './transport-helpers.js';
import { urlPathJoin } from './utils.js';
import { authHeadersFor } from './base.js';
import type { UnifiedChatRequest, UnifiedUsage } from '../types.js';

const log = logger('adapter.generic-rest');

const VARIABLES = ['$model', '$messages', '$last_user', '$max_tokens', '$temperature', '$top_p', '$stop', '$stream'] as const;
type Variable = (typeof VARIABLES)[number];

export class GenericRestAdapter implements Adapter {
  readonly id = 'generic-rest';
  readonly label = 'Generic REST (declarative mapping)';
  readonly description =
    'Custom HTTP APIs via declarative body template and response field extraction. Non-streaming.';

  readonly capabilities: AdapterCapabilities = {
    discovery: true, // only when models_path configured; discovery reports empty otherwise
    streaming: false,
    tools: false,
    multimodalTextImage: false,
  };

  validateConfig(config: unknown, baseUrl: string | null): ConfigValidation {
    const cfg = (typeof config === 'object' && config !== null ? config : {}) as Record<string, unknown>;
    if (!baseUrl) {
      return { ok: false, error: 'base_url is required for generic-rest providers.' };
    }
    const bodyTemplate = cfg['body_template'];
    if (!bodyTemplate || typeof bodyTemplate !== 'object' || Array.isArray(bodyTemplate)) {
      return { ok: false, error: 'body_template must be a JSON object.' };
    }
    for (const [value] of walkValues(bodyTemplate as Record<string, unknown>, '')) {
      if (typeof value === 'string') {
        for (const seg of value.split(/\s+/)) {
          const ref = seg.replace(/[\s\S]*\$/, (_m) => `$${seg.slice(seg.indexOf('$') + 1)}`);
          if (seg.startsWith('$') && !(VARIABLES as readonly string[]).includes(seg)) {
            return { ok: false, error: `Unknown template variable "${ref}". Allowed: ${VARIABLES.join(' ')}` };
          }
        }
        if (value.includes('$') && !value.startsWith('$')) {
          return { ok: false, error: `Template strings must be exact variable references, e.g. "$last_user" (got "${value}").` };
        }
      }
    }
    const response = cfg['response'];
    if (!response || typeof response !== 'object' || Array.isArray(response)) {
      return { ok: false, error: 'response mapping object is required.' };
    }
    const resp = response as Record<string, unknown>;
    if (typeof resp['content_path'] !== 'string' || !(resp['content_path'] as string).length) {
      return { ok: false, error: 'response.content_path is required (dot path to the output text).' };
    }
    for (const k of ['usage', 'id_path', 'model_path', 'finish_reason_path', 'tool_calls_path'] as const) {
      const v = resp[k];
      if (k === 'usage') {
        if (v !== undefined) {
          if (typeof v !== 'object' || v === null || Array.isArray(v)) {
            return { ok: false, error: 'response.usage must be an object with prompt/completion paths.' };
          }
          for (const sub of ['prompt', 'completion'] as const) {
            const sv = (v as Record<string, unknown>)[sub];
            if (sv !== undefined && typeof sv !== 'string') {
              return { ok: false, error: `response.usage.${sub} must be a dot path string.` };
            }
          }
        }
      } else if (v !== undefined && typeof v !== 'string') {
        return { ok: false, error: `response.${k} must be a dot path string.` };
      }
    }
    if (cfg['stream_format'] !== undefined && cfg['stream_format'] !== 'none') {
      return { ok: false, error: 'generic-rest supports stream_format "none" only.' };
    }
    return { ok: true, config: cfg };
  }

  async discover(ctx: AdapterContext): Promise<DiscoveryOutcome> {
    const modelsPath = ctx.provider.config['models_path'];
    if (typeof modelsPath !== 'string' || !modelsPath) {
      return {
        models: [],
        note: 'No models_path configured for this provider. Register models manually.',
      };
    }
    const url = urlPathJoin(baseOf(ctx), modelsPath);
    const res = await performJson(ctx, {
      url,
      method: 'GET',
      headers: { ...authHeadersFor(ctx.provider, ctx.credentials, { authTypeDefault: 'bearer' }), accept: 'application/json' },
      timeoutMs: testTimeoutOf(ctx),
    });
    if (res.statusFailed) throw upstreamStatusError(ctx, res.status, res.text);
    const list = extractList(res.json);
    const models: DiscoveredModel[] = [];
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const rec = item as Record<string, unknown>;
      const id = rec['id'];
      if (typeof id !== 'string' || !id) continue;
      models.push({
        upstreamId: id,
        displayName: typeof rec['name'] === 'string' && rec['name'] ? rec['name'] : id,
        contextLength: null,
        inputModalities: null,
        outputModalities: null,
        supportedParameters: null,
        streaming: null,
        tools: null,
        reasoning: null,
        pricing: null,
        raw: undefined,
      });
    }
    return { models, note: models.length === 0 ? 'No usable model entries (entries need a string "id").' : undefined };
  }

  async testConnection(ctx: AdapterContext): Promise<ConnectionTestResult> {
    const started = Date.now();
    try {
      const cfg = ctx.provider.config;
      let url: string;
      let reachableCheckOnly = false;
      if (typeof cfg['models_path'] === 'string' && cfg['models_path']) {
        url = urlPathJoin(baseOf(ctx), cfg['models_path']);
      } else {
        reachableCheckOnly = true;
        url = baseOf(ctx);
      }
      const res = await ctx.transport.perform({
        url,
        method: 'GET',
        headers: { ...authHeadersFor(ctx.provider, ctx.credentials, { authTypeDefault: 'bearer' }), accept: 'application/json' },
        timeoutMs: testTimeoutOf(ctx),
        signal: AbortSignal.timeout(testTimeoutOf(ctx)),
        policy: ctx.transport.policy,
      });
      const latency = Date.now() - started;
      if (res.status >= 400) {
        const apiErr = upstreamStatusError(ctx, res.status, res.body?.toString('utf8') ?? '');
        return { ok: false, message: apiErr.message, latencyMs: latency, upstreamStatus: res.status };
      }
      return {
        ok: true,
        message: reachableCheckOnly
          ? `Reachability check ok (HTTP ${res.status}). No model listing configured; register models manually.`
          : `Connection ok (HTTP ${res.status}).`,
        latencyMs: latency,
        upstreamStatus: res.status,
      };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err), latencyMs: Date.now() - started };
    }
  }

  async chat(ctx: AdapterContext, req: UnifiedChatRequest, resolvedModel: string): Promise<ChatOutcome> {
    const cfg = ctx.provider.config;
    const chatPath = typeof cfg['chat_path'] === 'string' && cfg['chat_path'] ? cfg['chat_path'] : '/completions';
    const url = urlPathJoin(baseOf(ctx), chatPath);
    const body = buildRequestBody(cfg['body_template'] as Record<string, unknown>, req, resolvedModel);
    const res = await performJson(ctx, {
      url,
      method: 'POST',
      headers: { ...authHeadersFor(ctx.provider, ctx.credentials, { authTypeDefault: 'bearer' }), accept: 'application/json' },
      body,
      timeoutMs: ctx.provider.timeout_ms,
    });
    if (res.statusFailed) throw upstreamStatusError(ctx, res.status, res.text);
    if (res.json === null) {
      throw ApiError.upstream(502, 'malformed_response', 'Provider response was not valid JSON.');
    }
    return { response: mapResponse(cfg['response'] as Record<string, unknown>, res.json, resolvedModel), providerMeta: {} };
  }

  async chatStream(): Promise<ChatStreamOutcome> {
    throw ApiError.upstream(
      400,
      'unsupported_feature',
      'This provider does not support streaming (generic-rest adapter). Disable stream or use an adapter with streaming support.',
    );
  }

  errorFromUpstream(status: number, bodyText: string | null): ApiError {
    return upstreamStatusError(
      { provider: { id: 'provider' } as AdapterContext['provider'] } as AdapterContext,
      status,
      bodyText ?? '',
    );
  }
}

/* ── mapping helpers ── */

export function buildRequestBody(
  template: Record<string, unknown>,
  req: UnifiedChatRequest,
  resolvedModel: string,
): Record<string, unknown> {
  const lastUser = [...req.messages].reverse().find((m) => m.role === 'user');
  const lastUserText =
    typeof lastUser?.content === 'string'
      ? lastUser.content
      : Array.isArray(lastUser?.content)
        ? lastUser.content.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('\n')
        : '';
  const vars: Record<Variable, unknown> = {
    '$model': resolvedModel,
    '$messages': req.messages,
    '$last_user': lastUserText,
    '$max_tokens': req.max_tokens,
    '$temperature': req.temperature,
    '$top_p': req.top_p,
    '$stop': Array.isArray(req.stop) ? req.stop : req.stop,
    '$stream': false,
  };
  const out = substituteVariables(template, vars);
  return out as Record<string, unknown>;
}

function applyTemplate(node: unknown, vars: Record<Variable, unknown>): unknown {
  if (typeof node === 'string') {
    return node in vars ? vars[node as Variable] : node;
  }
  if (Array.isArray(node)) return node.map((n) => applyTemplate(n, vars));
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      out[k] = applyTemplate(v, vars);
    }
    return out;
  }
  return node;
}

export function getByPath(json: unknown, path: string): unknown {
  const segments = path.split('.');
  let cur: unknown = json;
  for (const rawSeg of segments) {
    if (cur === null || cur === undefined) return undefined;
    const segSplits = rawSeg.split(/\[|\]/).filter((s) => s !== '');
    for (const seg of segSplits) {
      if (/^\d+$/.test(seg)) {
        if (Array.isArray(cur)) {
          cur = cur[Number.parseInt(seg, 10)];
          continue;
        }
        return undefined;
      }
      if (cur && typeof cur === 'object') {
        cur = (cur as Record<string, unknown>)[seg];
        continue;
      }
      return undefined;
    }
  }
  return cur;
}

export function substituteVariables(json: unknown, vars: Record<Variable, unknown>): unknown {
  if (typeof json === 'string') {
    if (json in vars) {
      return vars[json as Variable];
    }
    return json;
  }
  if (Array.isArray(json)) return json.map((n) => substituteVariables(n, vars));
  if (json && typeof json === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(json as Record<string, unknown>)) {
      out[k] = substituteVariables(v, vars);
    }
    return out;
  }
  return json;
}

export function extractList(json: unknown): unknown[] {
  if (Array.isArray(json)) return json;
  if (json && typeof json === 'object') {
    const root = json as Record<string, unknown>;
    for (const key of ['data', 'models', 'items']) {
      const v = root[key];
      if (Array.isArray(v)) return v;
    }
  }
  return [];
}

export function mapResponse(
  mapping: Record<string, unknown>,
  json: unknown,
  resolvedModel: string,
): UnifiedChatResponseShape {
  const contentPath = String(mapping['content_path'] ?? 'choices[0].message.content');
  const content = getByPath(json, contentPath);
  if (content === undefined || typeof content !== 'string') {
    throw ApiError.upstream(
      502,
      'malformed_response',
      `Response mapping failed: expected a string at "${contentPath}".`,
    );
  }
  const toolCallsRaw = mapping['tool_calls_path'] ? getByPath(json, String(mapping['tool_calls_path'])) : undefined;
  const toolCalls: import('./base.js').UnifiedChatResponseChoiceShapeToolCall[] | undefined = Array.isArray(toolCallsRaw)
    ? (toolCallsRaw as Record<string, unknown>[])
        .filter((t): t is { id?: unknown; function: { name: unknown; arguments: unknown } } => {
          return Boolean(t) && typeof t === 'object' && typeof (t as { function?: { name?: unknown } }).function?.name === 'string';
        })
        .map((t, i) => ({
          id: typeof t.id === 'string' ? t.id : `call_${i}`,
          type: 'function' as const,
          function: {
            name: String(t.function.name),
            arguments:
              typeof t.function.arguments === 'string' ? (t.function as { arguments: string }).arguments : JSON.stringify(t.function.arguments ?? {}),
          },
        }))
    : undefined;
  const finishRaw = mapping['finish_reason_path'] ? getByPath(json, String(mapping['finish_reason_path'])) : undefined;
  const finish = typeof finishRaw === 'string' ? finishRaw : 'stop';
  const usageObj = (mapping['usage'] ?? {}) as Record<string, string | undefined>;
  const promptRaw = usageObj['prompt'] != null ? numberOrNull(getByPath(json, String(usageObj['prompt']))) : undefined;
  const completionRaw = usageObj['completion'] != null ? numberOrNull(getByPath(json, String(usageObj['completion']))) : undefined;
  const promptTokens: number | undefined | null = promptRaw;
  const completionTokens: number | undefined | null = completionRaw;
  const usage: UnifiedUsage | null =
    promptTokens !== null && promptTokens !== undefined && completionTokens !== null && completionTokens !== undefined
      ? { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens }
      : promptTokens !== null && promptTokens !== undefined
        ? { prompt_tokens: promptTokens }
        : completionTokens !== null && completionTokens !== undefined
          ? { completion_tokens: completionTokens }
          : null;

  const choice: UnifiedChatResponseChoiceShape = {
    index: 0,
    message: {
      role: 'assistant' as const,
      content,
      tool_calls: toolCalls ?? undefined,
      refusal: null,
    },
    finish_reason: finish,
    native_finish_reason: undefined,
  };
  const idPath = typeof mapping['id_path'] === 'string' ? mapping['id_path'] : 'id';
  const modelPath = typeof mapping['model_path'] === 'string' ? mapping['model_path'] : 'model';
  const id = getByPath(json, idPath);
  const model = getByPath(json, modelPath);
  return {
    id: typeof id === 'string' ? id : `gen_${Math.random().toString(36).slice(2, 12)}`,
    model: typeof model === 'string' ? model : resolvedModel,
    choices: [choice],
    usage,
    native: undefined,
  };
}

function numberOrNull(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function baseOf(ctx: AdapterContext): string {
  const base = ctx.provider.base_url;
  if (!base) throw ApiError.badRequest(`Provider "${ctx.provider.id}" has no base_url configured.`);
  return base.replace(/\/+$/, '');
}

function testTimeoutOf(ctx: AdapterContext): number {
  return Math.min(ctx.provider.timeout_ms || 30_000, 15_000);
}

function* walkValues(node: unknown, path: string): Generator<[unknown, string]> {
  if (node && typeof node === 'object' && !Array.isArray(node)) {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      yield* walkValues(v, path ? `${path}.${k}` : k);
    }
    return;
  }
  if (Array.isArray(node)) {
    for (const [i, v] of node.entries()) {
      void i;
      yield* walkValues(v, path);
    }
    return;
  }
  yield [node, path];
}
