/**
 * ZeroRouter dashboard API client.
 * Same-origin /admin fetches; mutating calls always carry the CSRF header.
 * Gateway key plaintexts are used only inside the reveal-once flow and never
 * stored beyond component state.
 */

const CSRF = { 'x-requested-with': 'zerorouter' };

export class ApiClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

async function handle(res: Response, path = ''): Promise<unknown> {
  let body: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (res.status === 401 && !path.endsWith('/session/login')) {
    // Session expired or was revoked mid-flight → tell the App shell so it
    // re-reads the session and locks the console. Deliberately before the
    // throw below, and skipped for login attempts (a wrong password is an
    // inline form error, not a dead session).
    window.dispatchEvent(new CustomEvent('zr:unauthorized'));
  }
  if (!res.ok) {
    const envelope = (body ?? {}) as { error?: { message?: string; code?: string; details?: unknown } };
    throw new ApiClientError(
      res.status,
      envelope.error?.code ?? 'http_error',
      envelope.error?.message ?? `Request failed (${res.status}).`,
      envelope.error?.details,
    );
  }
  return body;
}

export async function apiGet<T>(path: string): Promise<T> {
  return (await handle(await fetch(path, { headers: { accept: 'application/json' } }), path)) as T;
}

export async function apiSend<T>(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...CSRF },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return (await handle(res, path)) as T;
}

/* ─── shared shapes (mirrors packages/server types.ts) ─── */

export interface Health {
  ok: boolean;
  service: string;
  version: number;
  ts: number;
}

export interface SessionInfo {
  password_required: boolean;
  /** True only in `database` auth mode (provisioned owner credential). */
  username_required: boolean;
  authenticated: boolean;
  mode: 'loopback_only' | 'environment' | 'database';
  secure_context: boolean;
}

export interface AdapterSummary {
  id: string;
  label: string;
  description: string;
  capabilities: {
    discovery: boolean;
    streaming: boolean;
    tools: 'full' | boolean | string;
    multimodalTextImage: boolean;
  };
}

export interface ProviderApi {
  id: string;
  name: string;
  adapter: string;
  enabled: boolean;
  base_url: string | null;
  auth_type: string;
  auth_header: string | null;
  has_credentials: boolean;
  config: Record<string, unknown>;
  timeout_ms: number;
  retry_max: number;
  test_status: 'untested' | 'ok' | 'failed';
  test_message: string | null;
  last_test_at: number | null;
  discovery_status: string;
  last_discovery: {
    ts: number;
    found: number;
    added: number;
    updated: number;
    removed?: number;
    partial?: boolean;
    note?: string;
    error?: string;
    duration_ms: number;
  } | null;
  model_count: number;
  created_at: number;
  updated_at: number;
}

export interface ProviderModel {
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
  status: string;
  source: string;
  meta: string | null;
  last_seen_at: number | null;
  created_at: number;
  updated_at: number;
  supports_streaming?: boolean | null;
  provider_enabled?: boolean;
  provider_adapter?: string | null;
  provider_name?: string | null;
}

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

export interface GatewayKey {
  id: string;
  label: string;
  key_prefix: string;
  expires_at: number | null;
  created_at: number;
  revoked_at: number | null;
  last_used_at: number | null;
}

export interface LogRow {
  id: string;
  ts: number;
  source: string;
  client_key_id: string | null;
  provider_id: string | null;
  provider_name: string | null;
  model: string | null;
  alias: string | null;
  stream: boolean;
  status: number;
  duration_ms: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  error_code: string | null;
  error_message: string | null;
  has_body: boolean;
}

export interface LogEntry extends LogRow {
  body_json: string | null;
}

export interface ProviderEvent {
  id?: number;
  provider_id: string;
  ts: number;
  kind: string;
  status: 'ok' | 'failed' | null;
  message: string | null;
  latency_ms: number | null;
}

export interface Stats {
  providers_configured: number;
  providers_enabled: number;
  models_total: number;
  requests_24h: number;
  requests_7d: number;
  success_rate_24h: number | null;
  avg_latency_ms_24h: number | null;
  p95_latency_ms_24h: number | null;
  streaming_share_24h: number | null;
  recent_errors: { ts: number; provider_id: string | null; error_code: string | null; error_message: string | null; status: number }[];
  tokens_24h: { prompt: number; completion: number } | null;
}

export interface ActivityBucket {
  bucket: number;
  total: number;
  errors: number;
}

export interface Settings {
  debug_log_request_bodies: boolean;
  log_retention_days: number;
  max_inflight_requests: number;
  rate_limit_per_minute: number;
  rate_limit_burst: number;
  stream_max_events: number;
}

export interface Diagnostics {
  server: {
    env: string;
    host: string;
    port: number;
    allow_remote: boolean;
    dashboard_password: boolean;
    data_dir: string;
    dev_cors_origin: string | null;
  };
  counts: {
    providers: number;
    providers_enabled: number;
    models: number;
    aliases: number;
    gateway_keys: number;
    gateway_keys_active: number;
  };
  settings: Settings;
  adapters: { id: string; capabilities: AdapterSummary['capabilities'] }[];
  limits: Record<string, string>;
}

export interface OverviewResponse {
  stats: Stats;
  activity: ActivityBucket[];
  events: ProviderEvent[];
  providers: ProviderApi[];
}

/* ─── endpoints ─── */

export const api = {
  session: () => apiGet<SessionInfo>('/admin/session'),
  health: () => apiGet<Health>('/healthz'),
  login: (payload: { password: string; username?: string }) =>
    apiSend<{ ok: true; expires_at: number }>('POST', '/admin/session/login', payload),
  logout: () => apiSend<{ ok: true }>('POST', '/admin/session/logout'),

  overview: () => apiGet<OverviewResponse>('/admin/overview'),

  providers: () => apiGet<{ providers: ProviderApi[]; adapters: AdapterSummary[] }>('/admin/providers'),
  provider: (id: string) =>
    apiGet<{
      provider: ProviderApi;
      adapter_capabilities: AdapterSummary['capabilities'] | null;
      events: ProviderEvent[];
      resolved_url_policy: { allowInsecureHttp?: boolean; allowInsecurePrivateHttp?: boolean };
    }>(`/admin/providers/${encodeURIComponent(id)}`),
  createProvider: (
    input: Record<string, unknown>,
  ) => apiSend<{ provider: ProviderApi }>('POST', '/admin/providers', input),
  updateProvider: (id: string, patch: Record<string, unknown>) =>
    apiSend<{ provider: ProviderApi }>('PUT', `/admin/providers/${encodeURIComponent(id)}`, patch),
  deleteProvider: (id: string, force = false) =>
    apiSend<{ ok: boolean; forced: boolean }>('DELETE', `/admin/providers/${encodeURIComponent(id)}${force ? '?force=1' : ''}`),
  testProvider: (id: string) =>
    apiSend<{ ok: boolean; message: string; latency_ms: number | null }>(
      'POST',
      `/admin/providers/${encodeURIComponent(id)}/test`,
      {},
    ),
  discoverProvider: (id: string) =>
    apiSend<{
      discovery: ProviderApi['last_discovery'];
    }>('POST', `/admin/providers/${encodeURIComponent(id)}/discover`, {}),
  providerEvents: (id: string) =>
    apiGet<{ events: ProviderEvent[] }>(`/admin/providers/${encodeURIComponent(id)}/events`),
  providerModels: (id: string) =>
    apiGet<{ models: ProviderModel[] }>(`/admin/providers/${encodeURIComponent(id)}/models`),

  addManualModel: (id: string, input: Record<string, unknown>) =>
    apiSend<{ ok: true }>('POST', `/admin/providers/${encodeURIComponent(id)}/models`, input),
  renameModel: (id: string, upstreamId: string, display_name: string) =>
    apiSend<{ ok: true }>('PATCH', `/admin/providers/${encodeURIComponent(id)}/models/${encodeURIComponent(upstreamId)}`, { display_name }),
  deleteModel: (id: string, upstreamId: string) =>
    apiSend<{ ok: true }>('DELETE', `/admin/providers/${encodeURIComponent(id)}/models/${encodeURIComponent(upstreamId)}`),

  models: (q: string, providerId: string | null, sort: string, page: number, perPage: number) => {
    const u = new URLSearchParams({ q, sort, page: String(page), per_page: String(perPage) });
    if (providerId) u.set('provider_id', providerId);
    return apiGet<{ total: number; page: number; per_page: number; models: ProviderModel[] }>(`/admin/models?${u.toString()}`);
  },

  aliases: () => apiGet<{ aliases: AliasRecord[] }>('/admin/aliases'),
  upsertAlias: (alias: string, body: Record<string, unknown>) =>
    apiSend<{ alias: AliasRecord }>('PUT', `/admin/aliases/${encodeURIComponent(alias)}`, body),
  deleteAlias: (alias: string) => apiSend<{ ok: true }>('DELETE', `/admin/aliases/${encodeURIComponent(alias)}`),

  keys: () => apiGet<{ keys: GatewayKey[] }>('/admin/keys'),
  createKey: (label: string, expiresInDays: number | null) =>
    apiSend<{ key: GatewayKey; plaintext: string; note: string }>('POST', '/admin/keys', {
      label,
      expires_in_days: expiresInDays,
    }),
  revokeKey: (id: string) => apiSend<{ ok: true }>('POST', `/admin/keys/${encodeURIComponent(id)}/revoke`, {}),
  deleteKey: (id: string) => apiSend<{ ok: true }>('DELETE', `/admin/keys/${encodeURIComponent(id)}`),

  logs: (params: { providerId?: string | null; status?: 'ok' | 'error' | null; limit?: number; offset?: number }) => {
    const u = new URLSearchParams();
    if (params.providerId) u.set('provider_id', params.providerId);
    if (params.status) u.set('status', params.status);
    if (params.limit !== undefined) u.set('limit', String(params.limit));
    if (params.offset !== undefined) u.set('offset', String(params.offset));
    return apiGet<{ total: number; rows: LogRow[] }>(`/admin/logs?${u.toString()}`);
  },
  logEntry: (id: string) => apiGet<{ entry: LogEntry }>(`/admin/logs/${encodeURIComponent(id)}`),
  clearLogs: () => apiSend<{ ok: true }>('DELETE', '/admin/logs'),

  events: (limit = 50) => apiGet<{ events: ProviderEvent[] }>(`/admin/events?limit=${limit}`),
  adapters: () => apiGet<{ adapters: AdapterSummary[] }>('/admin/adapters'),
  customAdapter: (modulePath: string) =>
    apiSend<{ ok: true; adapter: { id: string; label: string; capabilities: AdapterSummary['capabilities'] } }>('POST', '/admin/adapters/custom', { module_path: modulePath }),

  settings: () =>
    apiGet<{ settings: Settings; dashboard_password: string; notes: Record<string, string> }>('/admin/settings'),
  patchSettings: (patch: Partial<Settings>) => apiSend<{ settings: Settings }>('PUT', '/admin/settings', patch),

  diagnostics: () => apiGet<Diagnostics>('/admin/diagnostics'),
};

/** Formats an epoch-ms ts as a stable local time string for tables. */
export function fmtTime(ts: number | null | undefined): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function fmtDateTime(ts: number | null | undefined): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', day: '2-digit', month: '2-digit' });
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
