import { ApiError } from '../errors.js';
import { logger } from '../logger.js';
import type { Db } from '../db/database.js';
import { ProviderRepo, ModelRepo, ProviderEventRepo, AliasRepo } from '../db/repos.js';
import { getAdapter, listAdapters } from '../adapters/registry.js';
import type { AdapterContext } from '../adapters/base.js';
import type { makeTransportHooks } from '../adapters/transport-helpers.js';
import { parseTargetUrl, type UrlPolicy } from '../transport.js';
import type {
  AuthType,
  Credentials,
  DiscoverySummary,
  ProviderRecord,
  ProviderUpsertInput,
} from '../types.js';
import { randomId } from '../crypto.js';

const log = logger('providers');

/**
 * URL policy derived from provider config flags:
 * - Plain http to the loopback interface is always permitted (local model servers).
 * - http/https to private/LAN addresses requires an explicit per-provider opt-in
 *   (`allow_insecure_http: true` in provider config), per docs/security.md.
 */
export function providerUrlPolicy(cfg: Record<string, unknown>): UrlPolicy {
  const flag = cfg['allow_insecure_http'] === true || cfg['allow_insecure_http'] === 'true';
  return {
    allowInsecureHttp: true,
    allowInsecurePrivateHttp: flag,
  };
}

export class ProviderService {
  private discoveryInFlight = new Map<string, Promise<DiscoverySummary>>();

  constructor(
    private readonly db: Db,
    private readonly providers: ProviderRepo,
    private readonly models: ModelRepo,
    private readonly events: ProviderEventRepo,
    private readonly aliasesRepo: AliasRepo,
    private readonly makeHooks: (policy: UrlPolicy) => ReturnType<typeof makeTransportHooks>,
  ) {}

  list(): ProviderRecord[] {
    return this.providers.list().map((p) => ({ ...p }));
  }

  get(id: string): ProviderRecord {
    const p = this.providers.get(id);
    if (!p) throw ApiError.notFound(`Provider "${id}" not found.`);
    return p;
  }

  /** Public projection for the dashboard — never includes credentials. */
  toApi(p: ProviderRecord): Record<string, unknown> {
    return {
      id: p.id,
      name: p.name,
      adapter: p.adapter,
      enabled: p.enabled,
      base_url: p.base_url,
      auth_type: p.auth_type,
      auth_header: p.auth_header,
      has_credentials: p.credentials_enc !== null,
      config: p.config,
      timeout_ms: p.timeout_ms,
      retry_max: p.retry_max,
      test_status: p.test_status,
      test_message: p.test_message,
      last_test_at: p.last_test_at,
      discovery_status: p.discovery_status,
      last_discovery: p.last_discovery,
      model_count: this.models.countForProvider(p.id),
      created_at: p.created_at,
      updated_at: p.updated_at,
    };
  }

  create(input: ProviderUpsertInput): ProviderRecord {
    const adapter = getAdapter(input.adapter);
    if (!adapter) {
      throw ApiError.badRequest(`Unknown adapter "${input.adapter}".`, { adapters: listAdapters().map((a) => a.id) }, 'invalid_request');
    }
    if (input.id) {
      if (this.providers.get(input.id)) throw ApiError.conflict(`Provider id "${input.id}" already exists.`, undefined, 'not_found');
    }
    const id = input.id ?? slugid(input.name);
    if (this.providers.get(id)) throw ApiError.conflict(`Provider id "${id}" already exists.`, undefined, 'not_found');

    // Merge credentials: extra headers may be provided without an api key
    const credentials = readCredentialsInput(input, null, input.auth_type);
    const config = adapter.validateConfig(input.config ?? {}, input.base_url ?? null);
    if (!config.ok) throw ApiError.badRequest(config.error, undefined, 'invalid_request');
    if (input.auth_type === 'custom_header' && !input.auth_header) {
      throw ApiError.badRequest('auth_type "custom_header" requires auth_header name.');
    }
    if ((input.auth_type === 'bearer' || input.auth_type === 'x_api_key') && !credentials?.api_key) {
      // Allowed to save without a key (user may add later), but surface warning in test result.
      log.warn('provider saved without credential', { provider: id, auth_type: input.auth_type });
    }
    /* Fail fast: reject base URLs that no request could ever legally use —
       including cloud metadata hosts and private literals without the LAN opt-in. */
    if (input.base_url) {
      parseTargetUrl(input.base_url, providerUrlPolicy(config.config)); // throws ApiError on violation
    }
    const created = this.providers.create({
      id,
      name: input.name,
      adapter: input.adapter,
      enabled: input.enabled,
      base_url: input.base_url ?? null,
      auth_type: input.auth_type,
      auth_header: input.auth_header ?? null,
      credentials,
      config: config.config,
      timeout_ms: input.timeout_ms ?? 120_000,
      retry_max: input.retry_max ?? 1,
    });
    this.events.add({ provider_id: id, ts: Date.now(), kind: 'credentials', status: 'ok', message: 'Provider created.', latency_ms: null });
    return created;
  }

  update(id: string, patch: Partial<ProviderUpsertInput>): ProviderRecord {
    const current = this.get(id);
    const adapter = getAdapter(patch.adapter ?? current.adapter);
    if (!adapter) throw ApiError.badRequest(`Unknown adapter "${String(patch.adapter)}".`);
    const mergedConfig = { ...current.config, ...(patch.config ?? {}) };
    const mergedBaseUrl = patch.base_url !== undefined ? patch.base_url : current.base_url;
    const configValidated = adapter.validateConfig(mergedConfig, mergedBaseUrl ?? null);
    if (!configValidated.ok) throw ApiError.badRequest(configValidated.error, undefined, 'invalid_request');

    let credentialsPatch: { credentials?: Credentials; clearCredentials?: boolean } = {};
    if (patch.api_key !== undefined || patch.extra_headers !== undefined) {
      const existing = this.providers.credentials(current);
      const base: Credentials = existing ? { ...existing } : {};
      if (patch.api_key !== undefined) {
        if (patch.api_key === '') {
          base.api_key = undefined; // explicit clear
        } else {
          base.api_key = patch.api_key;
        }
      }
      if (patch.extra_headers !== undefined) {
        base.extra_headers = patch.extra_headers;
      }
      credentialsPatch =
        Object.keys(base).length > 0
          ? { credentials: cleanCredentials(base) }
          : { clearCredentials: true };
      if (base.api_key !== existing?.api_key || patch.extra_headers !== undefined) {
        this.events.add({ provider_id: id, ts: Date.now(), kind: 'credentials', status: 'ok', message: 'Credentials updated.', latency_ms: null });
      }
    }
    const authType: AuthType = patch.auth_type ?? current.auth_type;
    if (authType === 'custom_header' && !(patch.auth_header ?? current.auth_header)) {
      throw ApiError.badRequest('auth_type "custom_header" requires auth_header name.');
    }

    /* Fail fast on URL changes too; the merged config carries the LAN opt-in. */
    if (mergedBaseUrl) {
      parseTargetUrl(mergedBaseUrl, providerUrlPolicy(configValidated.config)); // throws ApiError on violation
    }

    this.providers.update(id, {
      name: patch.name,
      enabled: patch.enabled,
      base_url: patch.base_url,
      auth_type: authType,
      auth_header: patch.auth_header,
      config: configValidated.config,
      timeout_ms: patch.timeout_ms,
      retry_max: patch.retry_max,
      ...credentialsPatch,
    });
    if (patch.enabled !== undefined && patch.enabled !== current.enabled) {
      this.events.add({
        provider_id: id,
        ts: Date.now(),
        kind: patch.enabled ? 'enable' : 'disable',
        status: 'ok',
        message: patch.enabled ? 'Provider enabled.' : 'Provider disabled.',
        latency_ms: null,
      });
    }
    this.events.add({ provider_id: id, ts: Date.now(), kind: 'credentials', status: 'ok', message: 'Configuration updated.', latency_ms: null });
    return this.get(id);
  }

  /** Removal guard: aliases referencing the provider block deletion unless forced. */
  remove(id: string, force: boolean): { removed: boolean; blockedByAliases?: string[] } {
    const aliases = this.aliasesRepo.list();
    const blockers = [
      ...new Set(
        aliases
          .filter((a) => a.provider_id === id || (a.fallbacks ?? []).some((f) => f.provider_id === id))
          .map((a) => a.alias),
      ),
    ];
    if (blockers.length > 0 && !force) {
      return { removed: false, blockedByAliases: blockers };
    }
    this.providers.delete(id);
    return { removed: true };
  }

  hasCredentials(p: ProviderRecord): boolean {
    return p.credentials_enc !== null;
  }

  /* ───────── connection test ───────── */

  async testConnection(id: string): Promise<{ ok: boolean; message: string; latencyMs: number | null }> {
    const provider = this.get(id);
    const adapter = getAdapter(provider.adapter);
    if (!adapter) throw ApiError.internal(`Unknown adapter "${provider.adapter}".`);
    const cfg = providerUrlPolicy(provider.config);
    const ctx: AdapterContext = {
      provider,
      credentials: this.providers.credentials(provider),
      transport: this.makeHooks(cfg),
    };
    let result;
    try {
      result = await adapter.testConnection(ctx);
    } catch (err) {
      result = { ok: false, message: err instanceof Error ? err.message : String(err), latencyMs: null };
    }
    this.providers.update(id, {
      test_status: result.ok ? 'ok' : 'failed',
      test_message: result.message,
      last_test_at: Date.now(),
    });
    this.events.add({
      provider_id: id,
      ts: Date.now(),
      kind: 'connection_test',
      status: result.ok ? 'ok' : 'failed',
      message: result.message,
      latency_ms: result.latencyMs,
    });
    log.info('connection test finished', { provider: id, ok: result.ok, latency: result.latencyMs });
    return { ok: result.ok, message: result.message, latencyMs: result.latencyMs };
  }

  /* ───────── model discovery ───────── */

  discoveryStatusOf(id: string): { status: ProviderRecord['discovery_status']; summary: DiscoverySummary | null } {
    const p = this.get(id);
    return { status: p.discovery_status, summary: p.last_discovery };
  }

  async discoverModels(id: string): Promise<DiscoverySummary> {
    // Single flight per provider
    const existing = this.discoveryInFlight.get(id);
    if (existing) return existing;
    const promise = this.runDiscovery(id).finally(() => {
      this.discoveryInFlight.delete(id);
    });
    this.discoveryInFlight.set(id, promise);
    return promise;
  }

  private async runDiscovery(id: string): Promise<DiscoverySummary> {
    const started = Date.now();
    let provider: ProviderRecord;
    try {
      provider = this.get(id);
    } catch {
      throw ApiError.notFound(`Provider "${id}" not found.`);
    }
    const adapter = getAdapter(provider.adapter);
    if (!adapter) throw ApiError.internal(`Unknown adapter "${provider.adapter}".`);

    this.providers.update(id, { discovery_status: 'connecting' });

    try {
      const cfg = providerUrlPolicy(provider.config);
      const ctx: AdapterContext = {
        provider,
        credentials: this.providers.credentials(provider),
        transport: this.makeHooks(cfg),
      };
      this.providers.update(id, { discovery_status: 'discovering' });
      const outcome = await adapter.discover(ctx);
      const now = Date.now();
      let created = 0;
      let updated = 0;
      this.db.transaction(() => {
        for (const model of outcome.models) {
          const res = this.models.upsertDiscovered(id, model, now);
          if (res.created) created += 1;
          else if (res.updated) updated += 1;
        }
      });
      const summary: DiscoverySummary = {
        ts: now,
        found: outcome.models.length,
        added: created,
        updated,
        partial: outcome.partial ?? false,
        note: outcome.note,
        duration_ms: now - started,
      };
      this.providers.update(id, {
        discovery_status: outcome.partial ? 'partial' : 'completed',
        last_discovery: summary,
      });
      this.events.add({
        provider_id: id,
        ts: now,
        kind: 'discovery',
        status: 'ok',
        message: `Discovered ${outcome.models.length} models (${created} new, ${updated} updated).`,
        latency_ms: summary.duration_ms,
      });
      log.info('discovery completed', { provider: id, found: outcome.models.length, created, updated });
      return summary;
    } catch (err) {
      const now = Date.now();
      const errApi = err instanceof ApiError ? err : undefined;
      const summary: DiscoverySummary = {
        ts: now,
        found: 0,
        added: 0,
        updated: 0,
        error: errApi?.message ?? (err instanceof Error ? err.message : String(err)),
        duration_ms: now - started,
      };
      this.providers.update(id, { discovery_status: 'failed', last_discovery: summary });
      this.events.add({
        provider_id: id,
        ts: now,
        kind: 'discovery',
        status: 'failed',
        message: summary.error ?? 'Discovery failed.',
        latency_ms: summary.duration_ms,
      });
      if (errApi?.code === 'provider_auth_failed') {
        this.events.add({ provider_id: id, ts: now, kind: 'auth_issue', status: 'failed', message: summary.error ?? 'Authentication failed during discovery.', latency_ms: null });
      }
      log.warn('discovery failed', { provider: id, error: summary.error });
      throw errApi ?? ApiError.internal();
    }
  }

  /* ───────── manual models ───────── */

  addManualModel(id: string, input: {
    upstream_id: string;
    display_name?: string;
    context_length?: number | null;
    input_modalities?: string[] | null;
    output_modalities?: string[] | null;
    streaming?: boolean | null;
    tools?: boolean | null;
    pricing?: { prompt_per_token: string; completion_per_token: string } | null;
  }): void {
    this.get(id);
    this.models.upsertManual(
      id,
      {
        upstreamId: input.upstream_id,
        displayName: input.display_name,
        contextLength: input.context_length,
        inputModalities: input.input_modalities,
        outputModalities: input.output_modalities,
        streaming: input.streaming,
        tools: input.tools,
        pricing: input.pricing,
      },
      Date.now(),
    );
    const p = this.providers.get(id);
    if (p && p.discovery_status === 'untested') {
      this.providers.update(id, { discovery_status: 'manual' });
    }
  }
}

function slugid(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base || randomId('provider', 4).replace('provider_', 'p_');
}

export function readCredentialsInput(
  input: ProviderUpsertInput,
  existing: Credentials | null,
  authType: AuthType,
): Credentials | null {
  const credentials: Credentials = existing ? { ...existing } : {};
  if (input.api_key !== undefined) {
    if (input.api_key === '') credentials.api_key = undefined;
    else credentials.api_key = input.api_key;
  }
  if (input.extra_headers !== undefined) {
    credentials.extra_headers = input.extra_headers;
  }
  void authType;
  const cleaned = cleanCredentials(credentials);
  return Object.keys(cleaned).length > 0 ? cleaned : null;
}

export function cleanCredentials(c: Credentials): Credentials {
  const out: Credentials = {};
  if (c.api_key) out.api_key = c.api_key;
  if (c.extra_headers && Object.keys(c.extra_headers).length > 0) out.extra_headers = c.extra_headers;
  return out;
}
