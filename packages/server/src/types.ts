import { z } from 'zod';

/* ────────────────────────────────────────────────────────────────────────────
 * Unified chat request/response — the gateway's canonical representation.
 * Documented in docs/api.md. Asymmetric note: common OpenAI Chat Completions JSON is accepted.
 * ──────────────────────────────────────────────────────────────────────────── */

export const ContentPartSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('text'),
    text: z.string().max(400_000),
  }),
  z.object({
    type: z.literal('image_url'),
    image_url: z.object({
      url: z.string().max(400_000),
      detail: z.enum(['auto', 'low', 'high']).optional(),
    }),
  }),
]);
export type ContentPart = z.infer<typeof ContentPartSchema>;

export const ToolCallSchema = z.object({
  id: z.string().max(80),
  type: z.literal('function').default('function'),
  function: z.object({
    name: z.string().max(200),
    arguments: z.string().max(400_000),
  }),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

export const MessageSchema = z.object({
  role: z.enum(['system', 'developer', 'user', 'assistant', 'tool']),
  content: z
    .union([z.string().max(800_000), z.array(ContentPartSchema).max(64), z.null()])
    .optional(),
  name: z.string().max(80).optional(),
  tool_calls: z.array(ToolCallSchema).max(64).optional(),
  tool_call_id: z.string().max(80).optional(),
});
export type ChatMessage = z.infer<typeof MessageSchema>;

export const ToolSchema = z.object({
  type: z.literal('function'),
  function: z.object({
    name: z.string().max(200),
    description: z.string().max(4_000).optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
  }),
});
export type ChatTool = z.infer<typeof ToolSchema>;

export const ToolChoiceSchema = z.union([
  z.enum(['auto', 'none', 'required']),
  z.object({
    type: z.literal('function'),
    function: z.object({ name: z.string().max(200) }),
  }),
]);
export type ToolChoice = z.infer<typeof ToolChoiceSchema>;

export const UnifiedChatRequestSchema = z.object({
  model: z.string().min(1).max(200),
  messages: z.array(MessageSchema).min(1).max(256),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  max_tokens: z.number().int().min(1).max(262_144).optional(),
  stop: z
    .union([z.string().max(64), z.array(z.string().max(64)).max(4)])
    .optional(),
  stream: z.boolean().optional(),
  tools: z.array(ToolSchema).max(64).optional(),
  tool_choice: ToolChoiceSchema.optional(),
  user: z.string().max(120).optional(),
});
export type UnifiedChatRequest = z.infer<typeof UnifiedChatRequestSchema>;

export type UnifiedFinishReason =
  | 'stop'
  | 'length'
  | 'tool_calls'
  | 'content_filter'
  | 'function_call'
  | 'error'
  | null;

export interface UnifiedUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: Record<string, unknown>;
  completion_tokens_details?: Record<string, unknown>;
}

export interface UnifiedChoice {
  index: number;
  message: {
    role: 'assistant';
    content: string | null;
    tool_calls?: ToolCall[];
    refusal?: string | null;
  };
  finish_reason: UnifiedFinishReason;
  native_finish_reason?: string | null;
}

export interface UnifiedChatResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  provider: string;
  choices: UnifiedChoice[];
  usage: UnifiedUsage | null;
  request_id: string;
  provider_meta?: Record<string, unknown>;
}

export type UnifiedStreamEvent =
  | { kind: 'role'; role: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool_call_delta'; index: number; call: { id?: string; name?: string; args?: string } }
  | { kind: 'finish'; finishReason: UnifiedFinishReason; nativeFinishReason?: string | null }
  | { kind: 'usage'; usage: UnifiedUsage }
  | { kind: 'error'; error: { code?: number | string; message: string; type?: string } };

/* ────────────────────────────────────────────────────────────────────────────
 * Providers / credentials
 * ──────────────────────────────────────────────────────────────────────────── */

export const AuthTypeSchema = z.enum(['bearer', 'x_api_key', 'custom_header', 'none']);
export type AuthType = z.infer<typeof AuthTypeSchema>;

export const PROVIDER_SLUG_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/;

export const ProviderUpsertSchema = z.object({
  id: z.string().regex(PROVIDER_SLUG_RE).optional(),
  name: z.string().min(1).max(120),
  adapter: z.string().min(1).max(64),
  enabled: z.boolean().default(true),
  base_url: z.string().max(512).optional(),
  auth_type: AuthTypeSchema.default('bearer'),
  auth_header: z.string().regex(/^[A-Za-z0-9-]{1,64}$/).max(64).optional(),
  /** Plaintext credential accepted on write. Never returned by any API response. */
  api_key: z.string().max(4_096).optional(),
  extra_headers: z.record(z.string(), z.string()).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  timeout_ms: z
    .number()
    .int()
    .min(1_000)
    .max(600_000)
    .optional(),
  retry_max: z.number().int().min(0).max(3).optional(),
});
export type ProviderUpsertInput = z.infer<typeof ProviderUpsertSchema>;

export interface ProviderRecord {
  id: string;
  name: string;
  adapter: string;
  enabled: boolean;
  base_url: string | null;
  auth_type: AuthType;
  auth_header: string | null;
  credentials_enc: string | null;
  config: Record<string, unknown>;
  timeout_ms: number;
  retry_max: number;
  test_status: 'untested' | 'ok' | 'failed';
  test_message: string | null;
  last_test_at: number | null;
  discovery_status:
    | 'untested'
    | 'connecting'
    | 'discovering'
    | 'completed'
    | 'partial'
    | 'failed'
    | 'manual';
  last_discovery: DiscoverySummary | null;
  created_at: number;
  updated_at: number;
}

export interface DiscoverySummary {
  ts: number;
  found: number;
  added: number;
  updated: number;
  removed?: number;
  partial?: boolean;
  /** Human-readable note from the adapter (e.g. partial-list reason). */
  note?: string;
  error?: string;
  duration_ms: number;
}

export interface Credentials {
  api_key?: string;
  extra_headers?: Record<string, string>;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Model registry
 * ──────────────────────────────────────────────────────────────────────────── */

export type Modality = 'text' | 'image' | 'audio' | 'video';

export interface ProviderModelRecord {
  provider_id: string;
  upstream_id: string;
  display_name: string;
  user_meta: string | null;
  context_length: number | null;
  input_modalities: string[] | null;
  output_modalities: string[] | null;
  supported_parameters: string[] | null;
  streaming: boolean | null;
  tools: boolean | null;
  reasoning: boolean | null;
  pricing: { prompt_per_token: string; completion_per_token: string } | null;
  status: 'verified' | 'untested' | 'error' | 'unknown';
  source: 'discovered' | 'manual';
  meta: string | null;
  last_seen_at: number | null;
  created_at: number;
  updated_at: number;
}

export const ManualModelUpsertSchema = z.object({
  upstream_id: z.string().min(1).max(200),
  display_name: z.string().min(1).max(160).optional(),
  context_length: z.number().int().min(1).max(100_000_000).optional(),
  input_modalities: z.array(z.enum(['text', 'image', 'audio', 'video'])).optional(),
  output_modalities: z.array(z.enum(['text', 'image', 'audio', 'video'])).optional(),
  streaming: z.boolean().optional(),
  tools: z.boolean().optional(),
  pricing: z
    .object({
      prompt_per_token: z.string().max(40),
      completion_per_token: z.string().max(40),
    })
    .optional(),
});
export type ManualModelUpsertInput = z.infer<typeof ManualModelUpsertSchema>;

/* ────────────────────────────────────────────────────────────────────────────
 * Aliases
 * ──────────────────────────────────────────────────────────────────────────── */

export const ALIAS_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,63}$/;

export const AliasUpsertSchema = z.object({
  alias: z.string().regex(ALIAS_RE),
  provider_id: z.string().min(1).max(64),
  model: z.string().min(1).max(200),
  enabled: z.boolean().default(true),
  params: z
    .object({
      temperature: z.number().min(0).max(2).optional(),
      top_p: z.number().min(0).max(1).optional(),
      max_tokens: z.number().int().min(1).max(262_144).optional(),
      stop: z.union([z.string().max(64), z.array(z.string().max(64)).max(4)]).optional(),
    })
    .partial()
    .nullish(),
  fallbacks: z
    .array(z.object({ provider_id: z.string().min(1).max(64), model: z.string().min(1).max(200) }))
    .max(4)
    .nullish(),
  notes: z.string().max(500).nullish(),
});
export type AliasUpsertInput = z.infer<typeof AliasUpsertSchema>;

export interface AliasRecord {
  alias: string;
  provider_id: string;
  model: string;
  enabled: boolean;
  params: Record<string, unknown> | null;
  fallbacks: { provider_id: string; model: string }[] | null;
  notes: string | null;
  created_at: number;
  updated_at: number;
}

export interface ResolvedTarget {
  providerId: string;
  modelId: string;
  alias?: string;
  aliasParams?: Record<string, unknown> | null;
  fallbacks?: { provider_id: string; model: string }[];
}

/* ────────────────────────────────────────────────────────────────────────────
 * Gateway API keys
 * ──────────────────────────────────────────────────────────────────────────── */

export const ApiKeyCreateSchema = z.object({
  label: z.string().min(1).max(80),
  expires_in_days: z.number().int().min(1).max(730).nullish(),
});
export type ApiKeyCreateInput = z.infer<typeof ApiKeyCreateSchema>;

export interface ApiKeyRecord {
  id: string;
  label: string;
  key_prefix: string;
  expires_at: number | null;
  created_at: number;
  revoked_at: number | null;
  last_used_at: number | null;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Settings
 * ──────────────────────────────────────────────────────────────────────────── */

export const SettingsPatchSchema = z
  .object({
    debug_log_request_bodies: z.boolean().optional(),
    log_retention_days: z.number().int().min(1).max(365).optional(),
    max_inflight_requests: z.number().int().min(1).max(256).optional(),
    rate_limit_per_minute: z.number().int().min(1).max(10_000).optional(),
    rate_limit_burst: z.number().int().min(1).max(1_000).optional(),
    stream_max_events: z.number().int().min(100).max(1_000_000).optional(),
  })
  .strict();
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;
