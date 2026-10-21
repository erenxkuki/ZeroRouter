import { logger } from '../logger.js';
import { ApiError } from '../errors.js';
import { authHeadersFor, missingCredentialsError, jsonParseLenient } from './base.js';
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
} from './base.js';
import { performJson, upstreamStatusError } from './transport-helpers.js';
import { urlPathJoin } from './utils.js';
import type { UnifiedChatRequest, UnifiedStreamEvent, UnifiedUsage } from '../types.js';

const log = logger('adapter.openai-compatible');

const DEFAULT_MODELS_PATH = '/v1/models';
const DEFAULT_CHAT_PATH = '/v1/chat/completions';

export class OpenAICompatibleAdapter implements Adapter {
  readonly id: string = 'openai-compatible';
  readonly label: string = 'OpenAI-compatible';
  readonly description: string =
    'Any API exposing OpenAI Chat Completions and (optionally) a /v1/models style listing.';

  readonly capabilities: AdapterCapabilities = {
    discovery: true,
    streaming: true,
    tools: 'full',
    multimodalTextImage: true,
  };

  validateConfig(_config: unknown, baseUrl: string | null): ConfigValidation {
    const config = (typeof _config === 'object' && _config !== null ? _config : {}) as Record<string, unknown>;
    const allowed = new Set(['models_path', 'chat_path', 'extra_headers', 'extra_body']);
    for (const key of Object.keys(config)) {
      if (!allowed.has(key)) {
        return { ok: false, error: `Unknown adapter option "${key}". Allowed: ${[...allowed].join(', ')}` };
      }
    }
    if (!baseUrl) {
      return { ok: false, error: 'base_url is required for OpenAI-compatible providers.' };
    }
    const modelPath = config['models_path'];
    if (modelPath !== undefined && (typeof modelPath !== 'string' || !modelPath.startsWith('/'))) {
      return { ok: false, error: 'models_path must be an absolute path starting with "/".' };
    }
    const chatPath = config['chat_path'];
    if (chatPath !== undefined && (typeof chatPath !== 'string' || !chatPath.startsWith('/'))) {
      return { ok: false, error: 'chat_path must be an absolute path starting with "/".' };
    }
    const extraHeaders = config['extra_headers'];
    if (extraHeaders !== undefined && !isStringMap(extraHeaders)) {
      return { ok: false, error: 'extra_headers must be an object of strings.' };
    }
    const extraBody = config['extra_body'];
    if (extraBody !== undefined && (typeof extraBody !== 'object' || extraBody === null || Array.isArray(extraBody))) {
      return { ok: false, error: 'extra_body must be a JSON object merged into request bodies.' };
    }
    return { ok: true, config };
  }

  async discover(ctx: AdapterContext): Promise<DiscoveryOutcome> {
    const url = urlPathJoin(baseUrlOf(ctx), modelsPathOf(ctx));
    const headers = requireAuthHeaders(ctx);
    const result = await performJson(ctx, {
      url,
      method: 'GET',
      headers,
      timeoutMs: testTimeoutOf(ctx),
    });
    if (result.statusFailed) {
      throw upstreamStatusError(ctx, result.status, result.text);
    }
    const parsed = parseModelsDocument(result.json);
    const models: DiscoveredModel[] = parsed.models.map((m) => {
      const params = Array.isArray(m.supported_parameters) ? (m.supported_parameters as string[]) : null;
      return {
        upstreamId: m.id,
        displayName: typeof m.name === 'string' && m.name ? m.name : m.id,
        contextLength: typeof m.context_length === 'number' ? m.context_length : null,
        inputModalities: asModalities(m.input_modalities),
        outputModalities: asModalities(m.output_modalities),
        supportedParameters: params,
        streaming: params?.includes('stream') ? true : null,
        tools: params?.includes('tools') ? true : params?.includes('tool_choice') ? true : params === null ? null : false,
        pricing: parsePricing(m),
        raw: undefined,
      };
    });
    return { models, note: parsed.note };
  }

  async testConnection(ctx: AdapterContext): Promise<ConnectionTestResult> {
    const started = Date.now();
    try {
      const url = urlPathJoin(baseUrlOf(ctx), modelsPathOf(ctx));
      const headers = requireAuthHeaders(ctx);
      const res = await performJson(ctx, {
        url,
        method: 'GET',
        headers,
        timeoutMs: testTimeoutOf(ctx),
      });
      const latencyMs = Date.now() - started;
      if (res.statusFailed) {
        const err = upstreamStatusError(ctx, res.status, res.text);
        return { ok: false, message: err.message, latencyMs, upstreamStatus: res.status };
      }
      const parsed = parseModelsDocument(res.json);
      return {
        ok: true,
        message: `Connection ok — model list returned ${parsed.models.length} entries.`,
        latencyMs,
        upstreamStatus: res.status,
      };
    } catch (err) {
      return { ok: false, message: String(describeTransportErr(err)), latencyMs: Date.now() - started };
    }
  }

  async chat(ctx: AdapterContext, req: UnifiedChatRequest, resolvedModel: string): Promise<ChatOutcome> {
    const url = urlPathJoin(baseUrlOf(ctx), chatPathOf(ctx));
    const body = mapToOpenaiBody(ctx, req, resolvedModel, false);
    const headers = requireAuthHeaders(ctx, /*stream*/ false);
    const result = await performJson(ctx, {
      url: `${url}`,
      method: 'POST',
      headers,
      body,
      timeoutMs: ctx.provider.timeout_ms,
    });
    if (result.statusFailed) {
      throw upstreamStatusError(ctx, result.status, result.text);
    }
    const shape = normalizeOpenaiChatCompleted(result.json, resolvedModel);
    return { response: shape, providerMeta: { upstream_model: shape.model } };
  }

  async chatStream(ctx: AdapterContext, req: UnifiedChatRequest, resolvedModel: string): Promise<ChatStreamOutcome> {
    const base = baseUrlOf(ctx);
    const url = urlPathJoin(base, chatPathOf(ctx));
    const body = mapToOpenaiBody(ctx, req, resolvedModel, true);
    const headers = requireAuthHeaders(ctx, true);
    const res = await ctx.transport.perform({
      url,
      method: 'POST',
      headers: { ...headers, accept: 'text/event-stream' },
      body: Buffer.from(JSON.stringify(body), 'utf8'),
      timeoutMs: ctx.provider.timeout_ms * 2 || 300_000,
      wantStream: true,
      signal: AbortSignal.timeout(ctx.provider.timeout_ms * 2 || 300_000),
      maxResponseBytes: 64 * 1024 * 1024,
      policy: ctx.transport.policy,
    });
    const streamRaw = res.stream;
    if (streamRaw === undefined) throw ApiError.internal('Upstream stream missing for streaming chat');
    const upstreamStream = streamRaw;
    const status = res.status;
    if (status >= 400) {
      const text = await waitForStreamBody(upstreamStream);
      throw upstreamStatusError(ctx, status, text);
    }
    if (!(res.contentType ?? '').includes('event-stream') && !isTextLikeCT((res.contentType ?? ''))) {
      const text = await waitForStreamBody(upstreamStream);
      log.warn('upstream stream content type unexpected', { url, contentType: res.contentType });
      throw ApiError.upstream(
        502,
        'malformed_response',
        `Provider stream content type "${res.contentType ?? 'unknown'}" is not an SSE event stream.`,
      );
    }
    const adapter = this;
    interface StreamState {
      providerMeta: Record<string, unknown>;
    }
    const state: StreamState = { providerMeta: { upstream_model: resolvedModel } };
    async function* iterate(): AsyncGenerator<UnifiedStreamEvent> {
      const parser = adapter.buildStreamParser(upstreamStream, state);
      /* Delegate every parsed event; if the parser throws (mid-stream transport
         failure), the error propagates to the relay which downgrades it to an
         in-stream error chunk. */
      yield* parser.events;
    }
    return { events: iterate(), providerMeta: state.providerMeta };
  }

  errorFromUpstream(status: number, bodyText: string | null): ApiError {
    const message =
      extractErrorMessageFromBody(bodyText ?? '') ??
      `Provider returned HTTP ${status}.`;
    const code =
      status === 401 || status === 402
        ? 'provider_auth_failed'
        : status === 429
          ? 'provider_unavailable'
          : status >= 500
            ? 'provider_error'
            : 'provider_error';
    return ApiError.upstream(status, code, message, { retriable: status >= 500 || status === 429 });
  }

  buildStreamParser(stream: import('node:http').IncomingMessage, state: StreamStateRef) {
    return createOpenAiSseIterator(stream, state);
  }
}

export interface StreamStateRef {
  providerMeta: Record<string, unknown>;
}export function createOpenAiSseIterator(
  stream: import('node:http').IncomingMessage,
  state: StreamStateRef,
  maxEvents = Number.POSITIVE_INFINITY,
): {
  run: Promise<void>;
  events: AsyncGenerator<UnifiedStreamEvent>;
} {
  type Waiter = { resolve: (ev: IteratorResult<UnifiedStreamEvent>) => void; reject: (err: unknown) => void };
  const queue: UnifiedStreamEvent[] = [];
  const waiters: Waiter[] = [];
  let done = false;
  let failure: unknown = null;

  const emit = (ev: UnifiedStreamEvent) => {
    if (done) return;
    if (waiters.length > 0) {
      const waiter = waiters.shift();
      waiter?.resolve({ value: ev, done: false });
      return;
    }
    queue.push(ev);
    if (queue.length > maxEvents) {
      stream.destroy(new Error('stream event cap exceeded'));
    }
  };

  const finish = () => {
    if (done) return;
    done = true;
    const waiter = waiters.shift();
    waiter?.resolve({ value: undefined, done: true });
  };

  const fail = (err: unknown) => {
    if (done) return;
    done = true;
    failure = err;
    const waiter = waiters.shift();
    waiter?.reject(err);
    if (queue.length) return;
  };

  const handleParsed = (eventName: string | null, data: string) => {
    if (data === '[DONE]') {
      finish();
      return;
    }
    if (eventName === '[TRANSPORT]') {
      emit({ kind: 'error', error: { message: data.replace('[TRANSPORT] ', '') } });
      finish();
      return;
    }
    const parsed = jsonParseLenient(data);
    if (parsed.parseError !== undefined) {
      log.debug('skipping malformed SSE payload', { event: eventName, data: data.slice(0, 120) });
      return; // tolerance: continue reading rest of stream
    }
    mapChunkToEvents(parsed.json as Record<string, unknown>, state.providerMeta, emit, finish);
  };

  const run = new Promise<void>((resolve, _reject) => {
    stream.setEncoding('utf8');
    let buffer = '';
    let eventName: string | null = null;
    let dataLines: string[] = [];
    const dispatch = () => {
      if (dataLines.length === 0) return;
      const data = dataLines.join('\n');
      eventName = null;
      dataLines = [];
      if (buffer.trim().startsWith(':')) {
        return; // comment
      }
      handleParsed(eventName, data);
    };
    const processLine = (raw: string) => {
      if (raw.startsWith(':')) return; // comment
      if (raw === '') {
        dispatch();
        return;
      }
      const colon = raw.indexOf(':');
      if (colon === -1) return;
      const field = raw.slice(0, colon).trim();
      let value = raw.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'data') dataLines.push(value);
      else if (field === 'event') eventName = value;
    };
    stream.on('data', (chunk: string) => {
      buffer += chunk;
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        let line = buffer.slice(0, index);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        buffer = buffer.slice(index + 1);
        processLine(line);
        index = buffer.indexOf('\n');
      }
      if (done) {
        stream.destroy();
      }
    });
    stream.on('end', () => {
      if (buffer.length > 0) {
        processLine(buffer.replace(/\r$/, ''));
        buffer = '';
      }
      dispatch();
      finish();
      resolve();
    });
    stream.on('error', (err) => {
      fail(err);
      resolve();
    });
    stream.on('close', () => {
      finish();
      resolve();
    });
  });

  const events = (async function* generator(): AsyncGenerator<UnifiedStreamEvent> {
    for (;;) {
      if (failure !== null) throw failure;
      if (queue.length > 0) {
        const next = queue.shift()!;
        yield next;
        continue;
      }
      if (done) return;
      const result = await new Promise<IteratorResult<UnifiedStreamEvent>>((res, rej) => {
        waiters.push({ resolve: res, reject: rej });
      });
      if (result.done) return;
      yield result.value;
    }
  })();

  return { run, events };
}

function mapChunkToEvents(
  chunk: Record<string, unknown>,
  providerMeta: Record<string, unknown>,
  emit: (ev: UnifiedStreamEvent) => void,
  finish: () => void,
): void {
  const choices = Array.isArray(chunk['choices']) ? (chunk['choices'] as Record<string, unknown>[]) : [];
  const choice = choices[0];

  // Mid-stream structured errors (OpenRouter semantics; tolerated generally)
  if (chunk['error']) {
    const errObj = chunk['error'] as Record<string, unknown>;
    const message = typeof errObj['message'] === 'string' ? errObj['message'] : 'Upstream stream error';
    const code = typeof errObj['code'] === 'number' ? errObj['code'] : undefined;
    emit({ kind: 'error', error: { code, message, type: typeof errObj['type'] === 'string' ? errObj['type'] : undefined } });
    finish();
    return;
  }

  const usage = chunk['usage'];
  if (usage && typeof usage === 'object') {
    emit({ kind: 'usage', usage: normalizeUsage(usage) });
  }

  if (choice !== undefined) {
    const delta = (choice['delta'] ?? {}) as Record<string, unknown>;
    const role = delta['role'];
    if (typeof role === 'string') emit({ kind: 'role', role });
    const content = delta['content'];
    if (typeof content === 'string' && content.length > 0) emit({ kind: 'text', text: content });
    else if (Array.isArray(content)) {
      for (const part of content as Record<string, unknown>[]) {
        if (part['type'] === 'text' && typeof part['text'] === 'string') emit({ kind: 'text', text: part['text'] });
      }
    }
    if (Array.isArray(delta['tool_calls'])) {
      for (const call of delta['tool_calls'] as Record<string, unknown>[]) {
        const index = typeof call['index'] === 'number' ? call['index'] : 0;
        const fn = (call['function'] ?? {}) as Record<string, unknown>;
        emit({
          kind: 'tool_call_delta',
          index,
          call: {
            id: typeof call['id'] === 'string' ? call['id'] : undefined,
            name: typeof fn['name'] === 'string' ? fn['name'] : undefined,
            args: typeof fn['arguments'] === 'string' ? fn['arguments'] : undefined,
          },
        });
      }
    }
    const finishReason = choice['finish_reason'];
    if (typeof finishReason === 'string' || finishReason === null) {
      if (finishReason !== null) {
        emit({
          kind: 'finish',
          finishReason: normalizeFinishReason(finishReason),
          nativeFinishReason: typeof choice['native_finish_reason'] === 'string' ? (choice['native_finish_reason'] as string) : undefined,
        });
      }
    }
  }
}

export function normalizeFinishReason(raw: string): UnifiedStreamEvent extends never ? never : import('../types.js').UnifiedFinishReason {
  switch (raw) {
    case 'stop':
    case 'length':
    case 'tool_calls':
    case 'content_filter':
    case 'function_call':
      return raw as import('../types.js').UnifiedFinishReason;
    case 'error':
      return 'error';
    default:
      return 'stop';
  }
}

export function normalizeUsage(usage: unknown): UnifiedUsage {
  const usageObj = (usage && typeof usage === 'object' ? usage : {}) as Record<string, unknown>;
  return {
    prompt_tokens: numOrUndefined(usageObj['prompt_tokens']),
    completion_tokens: numOrUndefined(usageObj['completion_tokens']),
    total_tokens: numOrUndefined(usageObj['total_tokens']),
    prompt_tokens_details: asDetails(usageObj['prompt_tokens_details']),
    completion_tokens_details: asDetails(usageObj['completion_tokens_details']),
  };
}

function numOrUndefined(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function asDetails(v: unknown): Record<string, unknown> | undefined {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  return undefined;
}

/** Full chat-completion response normalization (OpenAI + tolerant variants). */
export function normalizeOpenaiChatCompleted(json: unknown, resolvedModel: string): import('./base.js').UnifiedChatResponseShape {
  if (!json || typeof json !== 'object') {
    throw ApiError.upstream(502, 'malformed_response', 'Provider returned an unexpected response format (not JSON).');
  }
  const root = json as Record<string, unknown>;
  if (root['error'] !== undefined) {
    const errVP = root['error'];
    const errObj = (typeof errVP === 'object' && errVP !== null ? errVP : {}) as Record<string, unknown>;
    throw ApiError.upstream(
      typeof root.status === 'number' ? root.status : 502,
      'provider_error',
      typeof errObj['message'] === 'string' ? errObj['message'] : 'Provider returned an error envelope.',
    );
  }
  const rawChoices = Array.isArray(root['choices']) ? (root['choices'] as unknown[]) : null;
  if (!rawChoices || rawChoices.length === 0) {
    throw ApiError.upstream(502, 'malformed_response', 'Provider response contained no choices.');
  }
  const mapped = rawChoices.map((raw, index): import('./base.js').UnifiedChatResponseChoiceShape => {
    if (!raw || typeof raw !== 'object') throw ApiError.upstream(502, 'malformed_response', 'Malformed choice entry.');

    const choice = raw as Record<string, unknown>;
    const msg = (choice['message'] ?? {}) as Record<string, unknown>;
    let content: string | null = null;
    if (typeof msg['content'] === 'string') content = msg['content'];
    else if (Array.isArray(msg['content'])) {
      content = (msg['content'] as unknown[])
        .filter((p): p is Record<string, unknown> => p !== null && typeof p === 'object' && (p as Record<string, unknown>)['type'] === 'text')
        .map((p) => String((p as Record<string, unknown>)['text'] ?? ''))
        .join('');
    } else if (typeof msg['content'] !== 'undefined' && msg['content'] !== null) {
      content = String(msg['content']);
    }
    const toolCallsRaw = Array.isArray(msg['tool_calls']) ? (msg['tool_calls'] as unknown[]) : [];
    const toolCalls = toolCallsRaw
      .map((call): import('./base.js').UnifiedChatResponseChoiceShapeToolCall | null => {
        if (!call || typeof call !== 'object') return null;
        const c = call as Record<string, unknown>;
        const fn = (c['function'] ?? {}) as Record<string, unknown>;
        const name = typeof fn['name'] === 'string' ? fn['name'] : null;
        if (!name) return null;
        return {
          id: typeof c['id'] === 'string' ? c['id'] : `call_${index}_${toolCallsRaw.indexOf(call)}`,
          type: 'function' as const,
          function: {
            name,
            arguments: typeof fn['arguments'] === 'string' ? fn['arguments'] : JSON.stringify(c['arguments'] ?? {}),
          },
        };
      })
      .filter((t): t is import('./base.js').UnifiedChatResponseChoiceShapeToolCall => t !== null);
    const finish = choice['finish_reason'];
    const finish_reason =
      typeof finish === 'string' ? (normalizeFinishReason(finish) === 'error' ? 'stop' : finish) : null;
    const nativeFinish = choice['native_finish_reason'];
    return {
      index,
      message: {
        role: 'assistant' as const,
        content,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        refusal: typeof msg['refusal'] === 'string' ? msg['refusal'] : null,
      },
      finish_reason: finish_reason as string | null,
      native_finish_reason: typeof nativeFinish === 'string' ? nativeFinish : undefined,
    };
  });
  const usageRaw = root['usage'];
  return {
    id: typeof root['id'] === 'string' ? root['id'] : generateLocalId(),
    model: typeof root['model'] === 'string' ? root['model'] : resolvedModel,
    choices: mapped,
    usage: usageRaw ? normalizeUsage(usageRaw) : null,
    native: undefined,
  };
}

function generateLocalId(): string {
  return `chatcmpl-${Math.random().toString(36).slice(2, 12)}`;
}

export function mapToOpenaiBody(
  ctx: AdapterContext,
  req: UnifiedChatRequest,
  resolvedModel: string,
  stream: boolean,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: resolvedModel,
    messages: req.messages,
    stream,
  };
  if (req.temperature !== undefined) body['temperature'] = req.temperature;
  if (req.top_p !== undefined) body['top_p'] = req.top_p;
  if (req.max_tokens !== undefined) body['max_tokens'] = req.max_tokens;
  if (req.stop !== undefined) body['stop'] = Array.isArray(req.stop) ? req.stop : [req.stop];
  if (req.tools !== undefined) body['tools'] = req.tools;
  if (req.tool_choice !== undefined) body['tool_choice'] = req.tool_choice;
  if (req.user !== undefined) body['user'] = req.user;
  const extraBody = ctx.provider.config['extra_body'];
  if (extraBody && typeof extraBody === 'object' && !Array.isArray(extraBody)) {
    return { ...extraBody as Record<string, unknown>, ...body };
  }
  return body;
}

export function requireAuthHeaders(ctx: AdapterContext, streaming = false): Record<string, string> {
  const headers = authHeadersFor(ctx.provider, ctx.credentials, { authTypeDefault: 'bearer' });
  if (ctx.provider.auth_type !== 'none' && !ctx.credentials?.api_key && !ctx.provider.config['api_key']) {
    if (!streaming && ctx.provider.auth_type !== 'custom_header') {
      log.debug('provider credentials missing; call will fail downstream', { provider: ctx.provider.id });
    }
    throw missingCredentialsError(ctx.provider.id);
  }
  return headers;
}

export function baseUrlOf(ctx: AdapterContext): string {
  const base = ctx.provider.base_url;
  if (!base) throw ApiError.badRequest(`Provider "${ctx.provider.id}" has no base_url configured.`, undefined, 'invalid_request');
  return base.replace(/\/+$/, '');
}

export function modelsPathOf(ctx: AdapterContext): string {
  const v = ctx.provider.config['models_path'];
  return typeof v === 'string' && v ? v : DEFAULT_MODELS_PATH;
}

export function chatPathOf(ctx: AdapterContext): string {
  const v = ctx.provider.config['chat_path'];
  return typeof v === 'string' && v ? v : DEFAULT_CHAT_PATH;
}

export function testTimeoutOf(ctx: AdapterContext): number {
  return Math.min(ctx.provider.timeout_ms || 30_000, 15_000);
}

export function isStringMap(v: unknown): v is Record<string, string> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  return Object.values(v).every((x) => typeof x === 'string');
}

function waitForStreamBody(stream: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const parts: string[] = [];
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => parts.push(chunk));
    stream.on('end', () => resolve(parts.join('')));
    stream.on('error', () => resolve(parts.join('')));
  });
}

function isTextLikeCT(ct: string): boolean {
  return ct.includes('text/') || ct.includes('json');
}

interface ModelsDocEntry {
  id: string;
  name?: unknown;
  context_length?: unknown;
  input_modalities?: unknown;
  output_modalities?: unknown;
  supported_parameters?: unknown;
  pricing?: unknown;
}

function parseModelsDocument(json: unknown): { models: ModelsDocEntry[]; note?: string } {
  if (json === null) {
    throw ApiError.upstream(502, 'malformed_response', 'Provider model list was not valid JSON.');
  }
  let list: unknown = null;
  let note: string | undefined;
  if (Array.isArray(json)) list = json;
  else if (json && typeof json === 'object') {
    const root = json as Record<string, unknown>;
    if (Array.isArray(root['data'])) list = root['data'];
    else if (Array.isArray(root['models'])) list = root['models'];
  }
  if (!Array.isArray(list)) {
    throw ApiError.upstream(502, 'malformed_response', 'Provider model list did not contain a JSON array.');
  }
  const models = list.filter((item): item is ModelsDocEntry => {
    if (!item || typeof item !== 'object') return false;
    const id = (item as Record<string, unknown>)['id'];
    return typeof id === 'string' && id.length > 0;
  });
  if (models.length === 0 && list.length > 0) note = 'Model list entries had no string id — nothing imported.';
  if (models.length === 0 && list.length === 0) note = 'Provider returned an empty model list.';
  return { models, note };
}

function asModalities(v: unknown): string[] | null {
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v as string[];
  return null;
}

const OPENROUTER_PRICING_PREFIX = 'openrouter';
export function parsePricing(m: ModelsDocEntry):
  | { prompt_per_token: string; completion_per_token: string }
  | null {
  void OPENROUTER_PRICING_PREFIX;
  const pricing = m.pricing as Record<string, unknown> | undefined;
  if (pricing && typeof pricing['prompt'] === 'string' && typeof pricing['completion'] === 'string') {
    return { prompt_per_token: pricing['prompt'], completion_per_token: pricing['completion'] };
  }
  return null;
}

export function describeTransportErr(err: unknown): string {
  if (isTransportErrorInstance(err)) return err.message;
  if (err instanceof ApiError) return err.message;
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

function isTransportErrorInstance(err: unknown): err is import('../transport.js').TransportError {
  return Boolean(err) && typeof err === 'object' && (err as { name?: string }).name === 'TransportError';
}

/** Extracts a short message from OpenAI-style error bodies without leaking internals. */
export function extractErrorMessageFromBody(body: string): string | null {
  if (!body) return null;
  const trimmed = body.trim();
  if (trimmed.startsWith('{')) {
    const parsed = jsonParseLenient(trimmed);
    if (parsed.parseError === undefined && parsed.json && typeof parsed.json === 'object') {
      const errObj = (parsed.json as Record<string, unknown>)['error'];
      if (typeof errObj === 'string') return errObj;
      if (errObj && typeof errObj === 'object') {
        const msg = (errObj as Record<string, unknown>)['message'];
        if (typeof msg === 'string') return msg;
      }
    }
  }
  if (trimmed.length > 0 && trimmed.length <= 200) return trimmed;
  return null;
}
