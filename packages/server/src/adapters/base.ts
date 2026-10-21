import type {
  ChatMessage,
  ChatTool,
  ToolChoice,
  UnifiedChatRequest,
  UnifiedStreamEvent,
  UnifiedUsage,
} from '../types.js';
import type { TransportRequest, UrlPolicy } from '../transport.js';
import type { Credentials, ProviderRecord, ProviderModelRecord } from '../types.js';
import { ApiError } from '../errors.js';

/* ────────────────────────────────────────────────────────────────────────────
 * Adapter contract
 *
 * An adapter turns ZeroRouter's unified chat request into provider traffic and
 * normalizes everything the provider sends back — chat completions, SSE streams,
 * model discovery, connection tests, and errors. See docs/adapters.md.
 * ──────────────────────────────────────────────────────────────────────────── */

export interface AdapterCapabilities {
  /** Supports GET/-style model discovery. */
  discovery: boolean;
  /** Streams token deltas via SSE. */
  streaming: boolean;
  /** Capability that can be checked from the registry metadata: null = unknown. */
  tools: 'full' | 'none' | boolean;
  multimodalTextImage: boolean | null;
}

export interface DiscoveredModel {
  upstreamId: string;
  displayName: string;
  contextLength?: number | null;
  inputModalities?: string[] | null;
  outputModalities?: string[] | null;
  supportedParameters?: string[] | null;
  streaming?: boolean | null;
  tools?: boolean | null;
  reasoning?: boolean | null;
  pricing?: { prompt_per_token: string; completion_per_token: string } | null;
  /** Provider's own raw metadata (only non-sensitive fields, size-capped). */
  raw?: Record<string, unknown>;
}

export interface DiscoveryOutcome {
  models: DiscoveredModel[];
  partial?: boolean;
  note?: string;
}

export interface ConnectionTestResult {
  ok: boolean;
  message: string;
  latencyMs: number | null;
  upstreamStatus?: number | null;
  detail?: Record<string, unknown>;
}

export interface ChatOutcome {
  /** Upstream raw JSON parsed into a unified chat completion. */
  response: UnifiedChatResponseShape;
  /** Provider chunked raw metadata (safe fields only). */
  providerMeta?: Record<string, unknown>;
}

export interface ChatStreamOutcome {
  /** Async iterator of normalized stream events. Ends when provider ends. */
  events: AsyncIterable<UnifiedStreamEvent>;
  providerMeta?: Record<string, unknown>;
}

export interface UnifiedChatResponseShape {
  id: string;
  model: string;
  choices: UnifiedChatResponseChoiceShape[];
  usage?: UnifiedUsage | null;
  native?: Record<string, unknown>;
}

export interface UnifiedChatResponseChoiceShape {
  index: number;
  message: {
    role: 'assistant';
    content: string | null;
    tool_calls?: UnifiedChatResponseChoiceShapeToolCall[];
    refusal?: string | null;
  };
  finish_reason: string | null;
  native_finish_reason?: string | null;
}

export interface UnifiedChatResponseChoiceShapeToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** Provider-specific knob validation; returns the cleaned config record. */
export type ConfigValidation =
  | { ok: true; config: Record<string, unknown> }
  | { ok: false; error: string };

export interface TransportHooks {
  /** Executes an HTTP request using the shared, guarded transport. */
  perform(req: TransportRequest): Promise<{
    status: number;
    headers: Record<string, unknown>;
    body?: Buffer;
    stream?: import('node:http').IncomingMessage;
    contentType?: string;
  }>;
  policy: UrlPolicy;
}

export interface AdapterContext {
  provider: ProviderRecord;
  credentials: Credentials | null;
  transport: TransportHooks;
}

export interface Adapter {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly capabilities: AdapterCapabilities;

  validateConfig(config: unknown, baseUrl: string | null): ConfigValidation;

  discover(ctx: AdapterContext): Promise<DiscoveryOutcome>;

  testConnection(ctx: AdapterContext): Promise<ConnectionTestResult>;

  /** Non-streaming normalized call. Throws ApiError on failure. */
  chat(
    ctx: AdapterContext,
    req: UnifiedChatRequest,
    resolvedModel: string,
  ): Promise<ChatOutcome>;

  /** Streaming normalized call (only valid when capabilities.streaming). */
  chatStream(
    ctx: AdapterContext,
    req: UnifiedChatRequest,
    resolvedModel: string,
  ): Promise<ChatStreamOutcome>;

  errorFromUpstream(status: number, bodyText: string | null, contentType?: string | null): ApiError;
}

/* ─── shared helpers ─── */

export function jsonParseLenient(text: string): { json: unknown; parseError?: string } {
  try {
    return { json: JSON.parse(text) as unknown };
  } catch (err) {
    return { json: null, parseError: err instanceof Error ? err.message : String(err) };
  }
}

export function collectMessagesText(messages: ChatMessage[]): string {
  return messages
    .map((m) => (typeof m.content === 'string' ? m.content : ''))
    .filter(Boolean)
    .join('\n');
}

export function messageTextOf(part: ChatMessage['content']): string {
  if (typeof part === 'string') return part;
  if (Array.isArray(part)) {
    return part
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('');
  }
  return '';
}

export function authHeadersFor(
  provider: ProviderRecord,
  credentials: Credentials | null,
  adapterDefaults: { authTypeDefault: string; headerDefault?: string },
): Record<string, string> {
  const headers: Record<string, string> = {};
  const headersToApply: Record<string, string> = {
    ...(credentials?.extra_headers ?? {}),
    ...toStrRecord(provider.config['extra_headers']),
  };
  if (provider.auth_type === 'none') {
    Object.assign(headers, headersToApply);
    return headers;
  }
  const apiKey = credentials?.api_key ?? toStr(provider.config['api_key']);
  if (!apiKey) {
    // Never throw silently – surface to caller via credentialsMissing helper
    Object.assign(headers, headersToApply);
    return headers;
  }
  switch (provider.auth_type) {
    case 'bearer':
      headers['authorization'] = `Bearer ${apiKey}`;
      break;
    case 'x_api_key': {
      const headerName = provider.auth_header ?? adapterDefaults.headerDefault ?? 'x-api-key';
      headers[headerName] = apiKey;
      break;
    }
    case 'custom_header': {
      const headerName = provider.auth_header ?? adapterDefaults.headerDefault;
      if (!headerName) {
        Object.assign(headers, headersToApply);
        return headers;
      }
      headers[headerName] = apiKey;
      break;
    }
    default:
      break;
  }
  Object.assign(headers, headersToApply);
  return headers;
}

export function missingCredentialsError(providerId: string): ApiError {
  return ApiError.badRequest(
    `Provider "${providerId}" has no stored credential. Add the provider's API key in the console (Providers → Credentials) before making requests.`,
    undefined,
    'credentials_missing',
  );
}

export function toStr(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

export function toStrRecord(v: unknown): Record<string, string> {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val === 'string') out[k] = val;
    }
    return out;
  }
  return {};
}
