/**
 * Anthropic Messages adapter.
 *
 * Verified conventions (October 2026):
 *  - POST {base}/v1/messages — header auth: x-api-key + anthropic-version
 *  - Response: { id, model, content: [ {type:'text',text} | {type:'tool_use',id,name,input} ],
 *    usage: { input_tokens, output_tokens }, stop_reason }
 *  - Errors: { type:'error', error: { type, message } }
 *  - Streaming SSE: message_start / content_block_start / content_block_delta
 *    (text_delta | input_json_delta) / content_block_stop / message_delta / message_stop
 *  - GET /v1/models → { data: [ { id, display_name, created_at } ] } — capabilities unknown.
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
import type { UnifiedChatRequest, UnifiedStreamEvent, UnifiedUsage } from '../types.js';

const log = logger('adapter.anthropic');

const DEFAULT_BASE = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 4_096;

export class AnthropicAdapter implements Adapter {
  readonly id = 'anthropic';
  readonly label = 'Anthropic';
  readonly description = 'Anthropic Messages API with request/response and SSE normalization.';

  readonly capabilities: AdapterCapabilities = {
    discovery: true,
    streaming: true,
    tools: 'full',
    multimodalTextImage: true,
  };

  validateConfig(config: unknown, baseUrl: string | null): ConfigValidation {
    const cfg = (typeof config === 'object' && config !== null ? config : {}) as Record<string, unknown>;
    const allowed = new Set(['version', 'chat_path', 'models_path', 'extra_headers']);
    for (const key of Object.keys(cfg)) {
      if (!allowed.has(key)) {
        return { ok: false, error: `Unknown Anthropic option "${key}". Allowed: ${[...allowed].join(', ')}` };
      }
    }
    if (!baseUrl) {
      return { ok: false, error: 'base_url is required for Anthropic providers.' };
    }
    for (const k of ['version', 'chat_path', 'models_path'] as const) {
      const v = cfg[k];
      if (v !== undefined && typeof v !== 'string') {
        return { ok: false, error: `${k} must be a string.` };
      }
      if (k !== 'version' && typeof v === 'string' && !v.startsWith('/')) {
        return { ok: false, error: `${k} must be an absolute path starting with "/".` };
      }
    }
    if (cfg['extra_headers'] !== undefined) {
      const eh = cfg['extra_headers'];
      if (typeof eh !== 'object' || eh === null || Array.isArray(eh)) {
        return { ok: false, error: 'extra_headers must be an object of strings.' };
      }
      for (const v of Object.values(eh as Record<string, unknown>)) {
        if (typeof v !== 'string') return { ok: false, error: 'extra_headers must be an object of strings.' };
      }
    }
    return { ok: true, config: cfg };
  }

  authHeaders(ctx: AdapterContext): Record<string, string> {
    const cfg = ctx.provider.config;
    const apiKey = ctx.credentials?.api_key;
    if (!apiKey) throw ApiError.badRequest(
      `Provider "${ctx.provider.id}" has no stored credential. Add an Anthropic API key before making requests.`,
      undefined,
      'credentials_missing',
    );
    const headers: Record<string, string> = {
      'x-api-key': apiKey,
      'anthropic-version': typeof cfg['version'] === 'string' && cfg['version'] ? cfg['version'] : ANTHROPIC_VERSION,
    };
    const extra = cfg['extra_headers'];
    if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
      for (const [k, v] of Object.entries(extra as Record<string, unknown>)) {
        if (typeof v === 'string') headers[k] = v;
      }
    }
    return headers;
  }

  async discover(ctx: AdapterContext): Promise<DiscoveryOutcome> {
    const url = urlPathJoin(baseOf(ctx), modelsPathOf(ctx));
    const res = await performJson(ctx, {
      url,
      method: 'GET',
      headers: { accept: 'application/json', ...this.authHeaders(ctx) },
      timeoutMs: testTimeoutOf(ctx),
    });
    if (res.statusFailed) throw upstreamStatusError(ctx, res.status, res.text);
    const data = (res.json as Record<string, unknown> | null)?.['data'];
    if (!Array.isArray(data)) {
      throw ApiError.upstream(502, 'malformed_response', 'Anthropic model list did not include "data".');
    }
    const models: DiscoveredModel[] = [];
    for (const item of data as Record<string, unknown>[]) {
      if (!item || typeof item.id !== 'string') continue;
      models.push({
        upstreamId: item.id,
        displayName: typeof item.display_name === 'string' && item.display_name ? item.display_name : item.id,
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
    return {
      models,
      note:
        models.length === 0
          ? 'Anthropic returned no model entries.'
          : undefined,
    };
  }

  async testConnection(ctx: AdapterContext): Promise<ConnectionTestResult> {
    const started = Date.now();
    try {
      const url = urlPathJoin(baseOf(ctx), modelsPathOf(ctx));
      const res = await performJson(ctx, {
        url,
        method: 'GET',
        headers: { accept: 'application/json', ...this.authHeaders(ctx) },
        timeoutMs: testTimeoutOf(ctx),
      });
      const latency = Date.now() - started;
      if (res.statusFailed) {
        const apiErr = anthropicError(ctx, res.status, res.json, res.text);
        return { ok: false, message: apiErr.message, latencyMs: latency, upstreamStatus: res.status };
      }
      const count = Array.isArray((res.json as Record<string, unknown> | null)?.['data'])
        ? (res.json as { data: unknown[] }).data.length
        : 0;
      return { ok: true, message: `Anthropic reachable — ${count} model entries.`, latencyMs: latency, upstreamStatus: res.status };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err), latencyMs: Date.now() - started };
    }
  }

  async chat(ctx: AdapterContext, req: UnifiedChatRequest, resolvedModel: string): Promise<ChatOutcome> {
    const url = urlPathJoin(baseOf(ctx), chatPathOf(ctx));
    const body = transformToAnthropic(ctx, req, resolvedModel);
    const res = await performJson(ctx, {
      url,
      method: 'POST',
      headers: { ...this.authHeaders(ctx), 'content-type': 'application/json', accept: 'application/json' },
      body,
      timeoutMs: ctx.provider.timeout_ms,
    });
    if (res.statusFailed) throw anthropicError(ctx, res.status, res.json, res.text);
    const shape = normalizeAnthropicResponse(res.json, resolvedModel);
    return { response: shape, providerMeta: { upstream_model: typeof res.json === 'object' && res.json !== null ? (res.json as Record<string, unknown>)['model'] : undefined } };
  }

  async chatStream(ctx: AdapterContext, req: UnifiedChatRequest, resolvedModel: string): Promise<ChatStreamOutcome> {
    const url = urlPathJoin(baseOf(ctx), chatPathOf(ctx));
    const body = transformToAnthropic(ctx, req, resolvedModel);
    body['stream'] = true;
    const res = await ctx.transport.perform({
      url,
      method: 'POST',
      headers: { ...this.authHeaders(ctx), 'content-type': 'application/json', accept: 'text/event-stream' },
      body: Buffer.from(JSON.stringify(body), 'utf8'),
      timeoutMs: Math.min(ctx.provider.timeout_ms * 2, 600_000),
      wantStream: true,
      signal: AbortSignal.timeout(Math.min(ctx.provider.timeout_ms * 2, 600_000)),
      maxResponseBytes: 64 * 1024 * 1024,
      policy: ctx.transport.policy,
    });
    if (res.status >= 400) {
      const text = res.stream ? await waitForStreamBody(res.stream) : '';
      let json: unknown = null;
      try {
        json = JSON.parse(text) as unknown;
      } catch {
        /* leave null */
      }
      throw anthropicError(ctx, res.status, json, text);
    }
    if (!res.stream) throw ApiError.internal('Upstream stream missing for streaming chat');
    const iterator = createAnthropicSseIterator(res.stream);
    return { events: iterator, providerMeta: { upstream_model: resolvedModel } };
  }

  errorFromUpstream(status: number, bodyText: string | null): ApiError {
    const parsed = tryParseJson(bodyText ?? '');
    const err = anthropicError(
      { provider: { id: 'anthropic' } as AdapterContext['provider'] } as AdapterContext,
      status,
      parsed,
      bodyText ?? '',
    );
    return err;
  }
}

/* ── request transform ── */

export function transformToAnthropic(
  ctx: AdapterContext,
  req: UnifiedChatRequest,
  resolvedModel: string,
): Record<string, unknown> {
  const systemParts: string[] = [];
  const messages: Record<string, unknown>[] = [];

  for (const [msgIndex, msg] of req.messages.entries()) {
    if (msg.role === 'system' || msg.role === 'developer') {
      const text = typeof msg.content === 'string' ? msg.content : '';
      if (text) systemParts.push(text);
      continue;
    }
    if (msg.role === 'tool') {
      if (!msg.tool_call_id) {
        throw ApiError.badRequest(`messages[${msgIndex}] has role "tool" without tool_call_id.`);
      }
      const contentText = typeof msg.content === 'string' ? msg.content : '';
      messages.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: msg.tool_call_id, content: contentText || '(no content)' }],
      });
      continue;
    }
    // user / assistant
    const blocks: Record<string, unknown>[] = [];
    const text = typeof msg.content === 'string' ? msg.content : null;
    if (text) blocks.push({ type: 'text', text });
    else if (Array.isArray(msg.content)) {
      if (msg.role === 'assistant' && msg.content.some((p) => p.type !== 'text')) {
        throw ApiError.upstream(
          400,
          'invalid_request',
          `messages[${msgIndex}]: Anthropic adapter supports only text parts in assistant messages.`,
        );
      }
      for (const part of msg.content) {
        if (part.type === 'text') {
          blocks.push({ type: 'text', text: part.text });
        } else {
          const image = imageBlockFromUrlPart(ctx, `messages[${msgIndex}]`, part.image_url.url);
          if (image) blocks.push(image);
        }
      }
    }
    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
      for (const call of msg.tool_calls) {
        let input: unknown = {};
        try {
          input = JSON.parse(call.function.arguments || '{}') as unknown;
        } catch (err) {
          log.debug('assistant tool_call arguments were not JSON; forwarding as empty input', {
            err: String(err),
          });
        }
        blocks.push({ type: 'tool_use', id: call.id, name: call.function.name, input });
      }
    }
    if (blocks.length === 0) {
      throw ApiError.badRequest(`messages[${msgIndex}]: empty message content.`);
    }
    messages.push({ role: msg.role, content: blocks });
  }

  if (messages.length === 0) {
    throw ApiError.badRequest('After normalization, no Anthropic-compatible messages were produced.');
  }

  const body: Record<string, unknown> = {
    model: resolvedModel,
    messages,
    max_tokens: req.max_tokens ?? DEFAULT_MAX_TOKENS,
  };
  if (systemParts.length > 0) body['system'] = systemParts.join('\n\n');
  if (req.temperature !== undefined) body['temperature'] = req.temperature;
  if (req.top_p !== undefined) body['top_p'] = req.top_p;
  if (req.stop !== undefined) {
    body['stop_sequences'] = Array.isArray(req.stop) ? req.stop : [req.stop];
  }
  if (req.tools !== undefined) {
    body['tools'] = req.tools.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters ?? { type: 'object', properties: {} },
    }));
  }
  if (req.tool_choice !== undefined) {
    if (req.tool_choice === 'none') {
      throw ApiError.upstream(
        400,
        'unsupported_feature',
        'Anthropic does not support tool_choice "none". Omit tools instead.',
      );
    }
    if (req.tool_choice === 'auto') body['tool_choice'] = { type: 'auto' };
    else if (req.tool_choice === 'required') body['tool_choice'] = { type: 'any' };
    else if (typeof req.tool_choice === 'object' && req.tool_choice.function?.name) {
      body['tool_choice'] = { type: 'tool', name: req.tool_choice.function.name };
    }
  }
  return body;
}

function imageBlockFromUrlPart(
  ctx: AdapterContext,
  where: string,
  url: string,
): Record<string, unknown> | null {
  void ctx;
  const match = /^data:([^;,]+);base64,(.+)$/i.exec(url.trim());
  if (match?.[1] && match[2]) {
    const mediaType = match[1].toLowerCase();
    if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(mediaType)) {
      throw ApiError.upstream(
        400,
        'unsupported_feature',
        `${where}: image "${mediaType}" not supported by Anthropic adapter (jpeg/png/gif/webp only).`,
      );
    }
    return { type: 'image', source: { type: 'base64', media_type: mediaType, data: match[2] } };
  }
  if (url.startsWith('http')) {
    throw ApiError.upstream(
      400,
      'unsupported_feature',
      `${where}: Anthropic Messages API requires base64 image data. Convert the image part to a data: URL (base64).`,
    );
  }
  throw ApiError.badRequest(`${where}: invalid image URL (expected a base64 data: URL).`);
}

/* ── response normalization ── */

export function normalizeAnthropicResponse(json: unknown, resolvedModel: string): UnifiedChatResponseShape {
  if (!json || typeof json !== 'object') {
    throw ApiError.upstream(502, 'malformed_response', 'Anthropic response was not JSON.');
  }
  const root = json as Record<string, unknown>;
  if (root['type'] === 'error') {
    const err = (root['error'] ?? {}) as Record<string, unknown>;
    throw ApiError.upstream(502, 'provider_error', typeof err['message'] === 'string' ? err['message'] : 'Anthropic error envelope.');
  }
  const content = Array.isArray(root['content']) ? (root['content'] as Record<string, unknown>[]) : [];
  const textParts: string[] = [];
  const toolCalls: import('./base.js').UnifiedChatResponseChoiceShapeToolCall[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block['type'] === 'text' && typeof block['text'] === 'string') textParts.push(block['text']);
    else if (block['type'] === 'tool_use' && typeof block['name'] === 'string' && typeof block['id'] === 'string') {
      toolCalls.push({
        id: block['id'],
        type: 'function' as const,
        function: {
          name: block['name'],
          arguments: JSON.stringify(block['input'] ?? {}),
        },
      });
    }
  }
  const usage = (root['usage'] ?? {}) as Record<string, unknown>;
  const u: UnifiedUsage = {
    prompt_tokens: intOrUndefined(usage['input_tokens']),
    completion_tokens: intOrUndefined(usage['output_tokens']),
    total_tokens:
      intOrUndefined(usage['input_tokens']) !== undefined && intOrUndefined(usage['output_tokens']) !== undefined
        ? (intOrUndefined(usage['input_tokens']) as number) + (intOrUndefined(usage['output_tokens']) as number)
        : undefined,
  };
  const choice: UnifiedChatResponseChoiceShape = {
    index: 0,
    message: {
      role: 'assistant' as const,
      content: textParts.join('') || null,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      refusal: null,
    },
    finish_reason: mapStopReason(typeof root['stop_reason'] === 'string' ? root['stop_reason'] : null),
    native_finish_reason: typeof root['stop_reason'] === 'string' ? root['stop_reason'] : undefined,
  };
  return {
    id: typeof root['id'] === 'string' ? root['id'] : `msg_${Math.random().toString(36).slice(2, 12)}`,
    model: typeof root['model'] === 'string' ? root['model'] : resolvedModel,
    choices: [choice],
    usage: u,
    native: undefined,
  };
}

function mapStopReason(raw: string | null): string | null {
  if (raw === null) return null;
  switch (raw) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    case 'refusal':
      return 'content_filter';
    default:
      return 'stop';
  }
}

/* ── SSE normalization ── */

export function createAnthropicSseIterator(stream: import('node:http').IncomingMessage): AsyncGenerator<UnifiedStreamEvent> {  const waiters: Array<{ resolve: (r: IteratorResult<UnifiedStreamEvent>) => void; reject: (e: unknown) => void }> = [];
  const queue: UnifiedStreamEvent[] = [];
  let done = false;
  let failure: unknown = null;
  const usageAcc: { input?: number; output?: number } = {};

  const push = (ev: UnifiedStreamEvent) => {
    if (done) return;
    if (waiters.length > 0) {
      waiters.shift()?.resolve({ value: ev, done: false });
      return;
    }
    queue.push(ev);
  };
  const close = () => {
    if (done) return;
    done = true;
    waiters.shift()?.resolve({ value: undefined, done: true });
  };
  const fail = (err: unknown) => {
    if (done) return;
    done = true;
    failure = err;
    waiters.shift()?.reject(err);
  };

  const emitError = (message: string): void => {
    push({ kind: 'error', error: { message } });
    close();
  };

  const emitUsage = (): void => {
    if (usageAcc['input'] === undefined && usageAcc['output'] === undefined) return;
    const input = usageAcc['input'];
    const output = usageAcc['output'];
    push({
      kind: 'usage',
      usage: {
        prompt_tokens: input,
        completion_tokens: output,
        total_tokens: input !== undefined && output !== undefined ? input + output : undefined,
      },
    });
  };

  const handle = (eventName: string | null, raw: string) => {
    if (raw === '[DONE]') {
      close();
      return;
    }
    let json: unknown;
    try {
      json = JSON.parse(raw) as unknown;
    } catch {
      log.debug('anthropic stream: skipping malformed payload', { data: raw.slice(0, 100) });
      return;
    }
    if (!json || typeof json !== 'object') return;
    const evt = json as Record<string, unknown>;
    const type = typeof evt['type'] === 'string' ? evt['type'] : eventName ?? '';

    if (type === 'message_start') {
      const msg = (evt['message'] ?? {}) as Record<string, unknown>;
      push({ kind: 'role', role: 'assistant' });
      const usage = (msg['usage'] ?? {}) as Record<string, unknown>;
      if (typeof usage['input_tokens'] === 'number') usageAcc['input'] = usage['input_tokens'];
      if (typeof usage['output_tokens'] === 'number') usageAcc['output'] = usage['output_tokens'];
      return;
    }
    if (type === 'content_block_start') {
      // tool_use blocks announce themselves here; name/id captured for later deltas
      const block = (evt['content_block'] ?? {}) as Record<string, unknown>;
      const index = typeof evt['index'] === 'number' ? evt['index'] : 0;
      if (block['type'] === 'tool_use' && typeof block['name'] === 'string') {
        push({ kind: 'tool_call_delta', index, call: { id: typeof block['id'] === 'string' ? block['id'] : undefined, name: block['name'] } });
      }
      return;
    }
    if (type === 'content_block_delta') {
      const delta = (evt['delta'] ?? {}) as Record<string, unknown>;
      const index = typeof evt['index'] === 'number' ? evt['index'] : 0;
      if (delta['type'] === 'text_delta' && typeof delta['text'] === 'string') {
        push({ kind: 'text', text: delta['text'] });
      } else if (delta['type'] === 'input_json_delta' && typeof delta['partial_json'] === 'string') {
        push({ kind: 'tool_call_delta', index, call: { args: delta['partial_json'] } });
      }
      return;
    }
    if (type === 'message_delta') {
      const delta = (evt['delta'] ?? {}) as Record<string, unknown>;
      const usage = (evt['usage'] ?? {}) as Record<string, unknown>;
      if (typeof usage['output_tokens'] === 'number') usageAcc['output'] = usage['output_tokens'];
      if (typeof delta['stop_reason'] === 'string') {
        push({
          kind: 'finish',
          finishReason: mapStopReason(delta['stop_reason']) as import('../types.js').UnifiedFinishReason,
          nativeFinishReason: delta['stop_reason'],
        });
      }
      return;
    }
    if (type === 'message_stop') {
      emitUsage();
      close();
      return;
    }
    if (type === 'error') {
      emitError(typeof evt['error'] === 'object' && evt['error'] !== null ? String((evt['error'] as Record<string, unknown>)['message'] ?? 'Anthropic stream error') : 'Anthropic stream error');
      return;
    }
    if (type === 'ping') return;
    // unknown types are ignored, never crash the stream
  };

  const run = new Promise<void>((resolve) => {
    stream.setEncoding('utf8');
    let buffer = '';
    let eventName: string | null = null;
    const dataLines: string[] = [];
    const dispatch = () => {
      if (dataLines.length === 0) {
        eventName = null;
        return;
      }
      const data = dataLines.join('\n');
      dataLines.length = 0;
      const evName = eventName;
      eventName = null;
      handle(evName, data);
    };
    const processLine = (raw: string) => {
      if (raw.startsWith(':')) return;
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
    });
    stream.on('end', () => {
      if (buffer.length > 0) {
        processLine(buffer.replace(/\r$/, ''));
        buffer = '';
      }
      dispatch();
      close();
      resolve();
    });
    stream.on('error', (err) => {
      fail(err);
      resolve();
    });
    stream.on('close', () => {
      close();
      resolve();
    });
  });

  const generator = (async function* gen(): AsyncGenerator<UnifiedStreamEvent> {
    for (;;) {
      if (failure !== null) throw failure;
      if (queue.length > 0) {
        const q = queue.shift();
        if (q !== undefined) yield q;
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

  // Attach synthetic usage flush at message_stop handled inline; keep generator semantics.
  void run;
  return generator;
}

/* ── helpers ── */

function baseOf(ctx: AdapterContext): string {
  const base = ctx.provider.base_url;
  if (!base) throw ApiError.badRequest(`Provider "${ctx.provider.id}" has no base_url configured.`);
  return base.replace(/\/+$/, '');
}

function chatPathOf(ctx: AdapterContext): string {
  const v = ctx.provider.config['chat_path'];
  return typeof v === 'string' && v ? v : '/v1/messages';
}

function modelsPathOf(ctx: AdapterContext): string {
  const v = ctx.provider.config['models_path'];
  return typeof v === 'string' && v ? v : '/v1/models';
}

function testTimeoutOf(ctx: AdapterContext): number {
  return Math.min(ctx.provider.timeout_ms || 30_000, 15_000);
}

function intOrUndefined(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
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

function anthropicError(ctx: AdapterContext, status: number, json: unknown, text: string): ApiError {
  const errObj: Record<string, unknown> =
    json && typeof json === 'object' && (json as Record<string, unknown>)['type'] === 'error'
      ? (((json as Record<string, unknown>)['error'] as Record<string, unknown> | undefined)) ?? {}
      : (() => {
          const e = extractAnthropicMessage(text);
          return e ? { message: e } : {};
        })();
  const message =
    typeof errObj['message'] === 'string' && errObj['message']
      ? `Anthropic error: ${errObj['message']}`
      : `Anthropic returned HTTP ${status}.`;
  const anthropicType = typeof errObj['type'] === 'string' ? errObj['type'] : null;
  const embed: Record<string, unknown> = { provider: ctx.provider.id, upstream_status: status };
  if (anthropicType) embed['anthropic_error_type'] = anthropicType;
  const code =
    status === 401 || status === 403
      ? 'provider_auth_failed'
      : status === 429
        ? 'provider_unavailable'
        : status === 404
          ? 'invalid_model'
          : status >= 500
            ? 'provider_error'
            : 'provider_error';
  return ApiError.upstream(status, code, message, {
    retriable: status >= 500 || status === 429,
    details: embed,
  });
}

function extractAnthropicMessage(text: string): string | null {
  const parsed = tryParseJson(text);
  if (parsed && typeof parsed === 'object') {
    const err = (parsed as Record<string, unknown>)['error'];
    if (err && typeof err === 'object' && typeof ((err as Record<string, unknown>)['message']) === 'string') {
      return (err as Record<string, unknown>)['message'] as string;
    }
  }
  if (text.length > 0 && text.length <= 200) return text;
  return null;
}
