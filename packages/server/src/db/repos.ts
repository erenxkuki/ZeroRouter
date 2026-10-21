import type { Db } from './database.js';
import type {
  AliasRecord,
  ApiKeyRecord,
  Credentials,
  DiscoverySummary,
  ProviderRecord,
  ProviderModelRecord,
  ResolvedTarget,
} from '../types.js';
import type { AuthType } from '../types.js';
import { decryptCredentials, encryptCredentials, hashSecret, newGatewayKey, randomId, verifySecret } from '../crypto.js';
import { logger } from '../logger.js';

const log = logger('repos');

/* ─────────────────────────── providers ─────────────────────────── */

interface ProviderRow {
  id: string;
  name: string;
  adapter: string;
  enabled: number;
  base_url: string | null;
  auth_type: string;
  auth_header: string | null;
  credentials_enc: string | null;
  config: string;
  timeout_ms: number;
  retry_max: number;
  test_status: string;
  test_message: string | null;
  last_test_at: number | null;
  discovery_status: string;
  last_discovery: string | null;
  created_at: number;
  updated_at: number;
}

function rowToProvider(row: ProviderRow): ProviderRecord {
  let config: Record<string, unknown> = {};
  try {
    config = row.config ? (JSON.parse(row.config) as Record<string, unknown>) : {};
  } catch {
    config = {};
  }
  let lastDiscovery: DiscoverySummary | null = null;
  if (row.last_discovery) {
    try {
      lastDiscovery = JSON.parse(row.last_discovery) as DiscoverySummary;
    } catch {
      lastDiscovery = null;
    }
  }
  return {
    id: row.id,
    name: row.name,
    adapter: row.adapter,
    enabled: row.enabled === 1,
    base_url: row.base_url,
    auth_type: row.auth_type as AuthType,
    auth_header: row.auth_header,
    credentials_enc: row.credentials_enc,
    config,
    timeout_ms: row.timeout_ms,
    retry_max: row.retry_max,
    test_status: row.test_status as ProviderRecord['test_status'],
    test_message: row.test_message,
    last_test_at: row.last_test_at,
    discovery_status: row.discovery_status as ProviderRecord['discovery_status'],
    last_discovery: lastDiscovery,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export class ProviderRepo {
  constructor(private readonly db: Db, private readonly masterKey: Buffer) {}

  get(id: string): ProviderRecord | null {
    const row = this.db.prepare('SELECT * FROM providers WHERE id = ?').get(id) as ProviderRow | undefined;
    return row ? rowToProvider(row) : null;
  }

  list(): ProviderRecord[] {
    const rows = this.db.prepare('SELECT * FROM providers ORDER BY created_at ASC').all() as unknown as ProviderRow[];
    return rows.map(rowToProvider);
  }

  create(input: {
    id: string;
    name: string;
    adapter: string;
    enabled: boolean;
    base_url: string | null;
    auth_type: AuthType;
    auth_header: string | null;
    credentials: Credentials | null;
    config: Record<string, unknown>;
    timeout_ms: number;
    retry_max: number;
  }): ProviderRecord {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO providers (id, name, adapter, enabled, base_url, auth_type, auth_header, credentials_enc, config, timeout_ms, retry_max, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.name,
        input.adapter,
        input.enabled ? 1 : 0,
        input.base_url,
        input.auth_type,
        input.auth_header,
        input.credentials ? encryptCredentials(input.credentials, this.masterKey) : null,
        JSON.stringify(input.config),
        input.timeout_ms,
        input.retry_max,
        now,
        now,
      );
    return this.get(input.id)!;
  }

  update(id: string, patch: Partial<{
    name: string;
    enabled: boolean;
    base_url: string | null;
    auth_type: AuthType;
    auth_header: string | null;
    credentials: Credentials | null; // replaces credential set
    clearCredentials: boolean;
    config: Record<string, unknown>;
    timeout_ms: number;
    retry_max: number;
    test_status: ProviderRecord['test_status'];
    test_message: string | null;
    last_test_at: number | null;
    discovery_status: ProviderRecord['discovery_status'];
    last_discovery: DiscoverySummary | null;
  }>): void {
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    const set = (col: string, val: string | number | null) => {
      sets.push(`${col} = ?`);
      values.push(val);
    };
    if (patch.name !== undefined) set('name', patch.name);
    if (patch.enabled !== undefined) set('enabled', patch.enabled ? 1 : 0);
    if (patch.base_url !== undefined) set('base_url', patch.base_url);
    if (patch.auth_type !== undefined) set('auth_type', patch.auth_type);
    if (patch.auth_header !== undefined) set('auth_header', patch.auth_header);
    if (patch.credentials !== undefined) {
      set('credentials_enc', patch.credentials ? encryptCredentials(patch.credentials, this.masterKey) : null);
    }
    if (patch.clearCredentials === true) set('credentials_enc', null);
    if (patch.config !== undefined) set('config', JSON.stringify(patch.config));
    if (patch.timeout_ms !== undefined) set('timeout_ms', patch.timeout_ms);
    if (patch.retry_max !== undefined) set('retry_max', patch.retry_max);
    if (patch.test_status !== undefined) set('test_status', patch.test_status);
    if (patch.test_message !== undefined) set('test_message', patch.test_message);
    if (patch.last_test_at !== undefined) set('last_test_at', patch.last_test_at);
    if (patch.discovery_status !== undefined) set('discovery_status', patch.discovery_status);
    if (patch.last_discovery !== undefined) {
      set('last_discovery', patch.last_discovery ? JSON.stringify(patch.last_discovery) : null);
    }
    sets.push('updated_at = ?');
    values.push(Date.now());
    values.push(id);
    if (sets.length === 1) return; // only updated_at change → skip
    this.db
      .prepare(`UPDATE providers SET ${sets.join(', ')} WHERE id = ?`)
      .run(...values);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM providers WHERE id = ?').run(id);
  }

  credentials(provider: ProviderRecord): Credentials | null {
    if (!provider.credentials_enc) return null;
    try {
      const plain = decryptCredentials(provider.credentials_enc, this.masterKey);
      if (plain && typeof plain === 'object') return plain as Credentials;
      return null;
    } catch (err) {
      log.error('failed to decrypt provider credentials', { provider: provider.id, err: String(err) });
      return null;
    }
  }
}

/* ─────────────────────────── models ─────────────────────────── */

interface ModelRow {
  provider_id: string;
  upstream_id: string;
  display_name: string;
  user_meta: string | null;
  context_length: number | null;
  input_modalities: string | null;
  output_modalities: string | null;
  supported_parameters: string | null;
  streaming: number | null;
  tools: number | null;
  reasoning: number | null;
  pricing: string | null;
  status: string;
  source: string;
  meta: string | null;
  last_seen_at: number | null;
  created_at: number;
  updated_at: number;
}

function parseJsonArray(v: string | null): string[] | null {
  if (!v) return null;
  try {
    const arr = JSON.parse(v) as unknown;
    return Array.isArray(arr) ? (arr as string[]) : null;
  } catch {
    return null;
  }
}

export function rowToModel(row: ModelRow): ProviderModelRecord {
  let pricing: ProviderModelRecord['pricing'] = null;
  if (row.pricing) {
    try {
      const p = JSON.parse(row.pricing) as { prompt_per_token?: unknown; completion_per_token?: unknown };
      if (typeof p.prompt_per_token === 'string' && typeof p.completion_per_token === 'string') {
        pricing = { prompt_per_token: p.prompt_per_token, completion_per_token: p.completion_per_token };
      }
    } catch {
      pricing = null;
    }
  }
  return {
    provider_id: row.provider_id,
    upstream_id: row.upstream_id,
    display_name: row.display_name,
    user_meta: row.user_meta,
    context_length: row.context_length,
    input_modalities: parseJsonArray(row.input_modalities),
    output_modalities: parseJsonArray(row.output_modalities),
    supported_parameters: parseJsonArray(row.supported_parameters),
    streaming: row.streaming === null || row.streaming === undefined ? null : row.streaming === 1,
    tools: row.tools === null || row.tools === undefined ? null : row.tools === 1,
    reasoning: row.reasoning === null || row.reasoning === undefined ? null : row.reasoning === 1,
    pricing,
    status: row.status as ProviderModelRecord['status'],
    source: row.source as ProviderModelRecord['source'],
    meta: row.meta,
    last_seen_at: row.last_seen_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export class ModelRepo {
  constructor(private readonly db: Db) {}

  forProvider(providerId: string): ProviderModelRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM models WHERE provider_id = ? ORDER BY upstream_id ASC')
      .all(providerId) as unknown as ModelRow[];
    return rows.map(rowToModel);
  }

  listAll(): ProviderModelRecord[] {
    const rows = this.db.prepare('SELECT * FROM models ORDER BY provider_id ASC, upstream_id ASC').all() as unknown as ModelRow[];
    return rows.map(rowToModel);
  }

  get(providerId: string, upstreamId: string): ProviderModelRecord | null {
    const row = this.db
      .prepare('SELECT * FROM models WHERE provider_id = ? AND upstream_id = ?')
      .get(providerId, upstreamId) as ModelRow | undefined;
    return row ? rowToModel(row) : null;
  }

  /** Upsert from discovery; preserves user metadata + enabled choice. */
  upsertDiscovered(providerId: string, item: {
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
    raw?: Record<string, unknown>;
  }, now: number): { created: boolean; updated: boolean } {
    const existing = this.get(providerId, item.upstreamId);
    if (existing) {
      // Preserve user renames (user_meta.display_name_override) but refresh provider data.
      let display = item.displayName || existing.display_name;
      try {
        const userMeta = existing.user_meta ? (JSON.parse(existing.user_meta) as Record<string, unknown>) : null;
        if (userMeta && typeof userMeta['display_name_override'] === 'string' && userMeta['display_name_override']) {
          display = userMeta['display_name_override'];
        }
      } catch {
        /* ignore corrupt user meta */
      }
      this.db
        .prepare(
          `UPDATE models SET display_name = ?, context_length = ?, input_modalities = ?, output_modalities = ?,
           supported_parameters = ?, streaming = ?, tools = ?, reasoning = ?, pricing = ?, meta = ?, last_seen_at = ?, updated_at = ?
           WHERE provider_id = ? AND upstream_id = ?`,
        )
        .run(
          display,
          item.contextLength ?? existing.context_length,
          item.inputModalities ? JSON.stringify(item.inputModalities) : null,
          item.outputModalities ? JSON.stringify(item.outputModalities) : null,
          item.supportedParameters ? JSON.stringify(item.supportedParameters) : null,
          item.streaming === null || item.streaming === undefined ? null : item.streaming ? 1 : 0,
          item.tools === null || item.tools === undefined ? null : item.tools ? 1 : 0,
          item.reasoning === null || item.reasoning === undefined ? null : item.reasoning ? 1 : 0,
          item.pricing ? JSON.stringify(item.pricing) : null,
          item.raw ? JSON.stringify(item.raw).slice(0, 4_000) : existing.meta,
          now,
          now,
          providerId,
          item.upstreamId,
        );
      return { created: false, updated: true };
    }
    this.db
      .prepare(
        `INSERT INTO models (provider_id, upstream_id, display_name, user_meta, context_length, input_modalities,
         output_modalities, supported_parameters, streaming, tools, reasoning, pricing, status, source, meta,
         last_seen_at, created_at, updated_at)
         VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 'untested', 'discovered', ?, ?, ?, ?)`,
      )
      .run(
        providerId,
        item.upstreamId,
        item.displayName || item.upstreamId,
        item.contextLength ?? null,
        item.inputModalities ? JSON.stringify(item.inputModalities) : null,
        item.outputModalities ? JSON.stringify(item.outputModalities) : null,
        item.supportedParameters ? JSON.stringify(item.supportedParameters) : null,
        item.streaming === null || item.streaming === undefined ? null : item.streaming ? 1 : 0,
        item.tools === null || item.tools === undefined ? null : item.tools ? 1 : 0,
        item.reasoning === null || item.reasoning === undefined ? null : item.reasoning ? 1 : 0,
        item.pricing ? JSON.stringify(item.pricing) : null,
        item.raw ? JSON.stringify(item.raw).slice(0, 4_000) : null,
        now,
        now,
        now,
      );
    return { created: true, updated: false };
  }

  upsertManual(providerId: string, item: {
    upstreamId: string;
    displayName?: string;
    contextLength?: number | null;
    inputModalities?: string[] | null;
    outputModalities?: string[] | null;
    streaming?: boolean | null;
    tools?: boolean | null;
    pricing?: { prompt_per_token: string; completion_per_token: string } | null;
  }, now: number): ProviderModelRecord {
    const existing = this.get(providerId, item.upstreamId);
    if (existing) {
      this.db
        .prepare(
          `UPDATE models SET display_name = ?, context_length = ?, input_modalities = ?, output_modalities = ?,
           streaming = ?, tools = ?, pricing = ?, updated_at = ? WHERE provider_id = ? AND upstream_id = ?`,
        )
        .run(
          item.displayName ?? existing.display_name,
          item.contextLength ?? existing.context_length,
          item.inputModalities ? JSON.stringify(item.inputModalities) : null,
          item.outputModalities ? JSON.stringify(item.outputModalities) : null,
          item.streaming === null || item.streaming === undefined ? null : item.streaming ? 1 : 0,
          item.tools === null || item.tools === undefined ? null : item.tools ? 1 : 0,
          item.pricing ? JSON.stringify(item.pricing) : null,
          now,
          providerId,
          item.upstreamId,
        );
      return this.get(providerId, item.upstreamId)!;
    }
    this.db
      .prepare(
        `INSERT INTO models (provider_id, upstream_id, display_name, context_length, input_modalities, output_modalities,
         streaming, tools, pricing, status, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'untested', 'manual', ?, ?)`,
      )
      .run(
        providerId,
        item.upstreamId,
        item.displayName ?? item.upstreamId,
        item.contextLength ?? null,
        item.inputModalities ? JSON.stringify(item.inputModalities) : null,
        item.outputModalities ? JSON.stringify(item.outputModalities) : null,
        item.streaming === null || item.streaming === undefined ? null : item.streaming ? 1 : 0,
        item.tools === null || item.tools === undefined ? null : item.tools ? 1 : 0,
        item.pricing ? JSON.stringify(item.pricing) : null,
        now,
        now,
      );
    return this.get(providerId, item.upstreamId)!;
  }

  rename(providerId: string, upstreamId: string, displayName: string): void {
    const now = Date.now();
    const existing = this.get(providerId, upstreamId);
    if (!existing) return;
    let userMeta: Record<string, unknown> = {};
    try {
      userMeta = existing.user_meta ? (JSON.parse(existing.user_meta) as Record<string, unknown>) : {};
    } catch {
      userMeta = {};
    }
    userMeta['display_name_override'] = displayName;
    this.db
      .prepare('UPDATE models SET display_name = ?, user_meta = ?, updated_at = ? WHERE provider_id = ? AND upstream_id = ?')
      .run(displayName, JSON.stringify(userMeta), now, providerId, upstreamId);
  }

  delete(providerId: string, upstreamId: string): void {
    this.db.prepare('DELETE FROM models WHERE provider_id = ? AND upstream_id = ?').run(providerId, upstreamId);
  }

  setStatus(providerId: string, upstreamId: string, status: ProviderModelRecord['status']): void {
    this.db
      .prepare('UPDATE models SET status = ?, updated_at = ? WHERE provider_id = ? AND upstream_id = ?')
      .run(status, Date.now(), providerId, upstreamId);
  }

  countForProvider(providerId: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM models WHERE provider_id = ?').get(providerId) as { n: number };
    return row.n;
  }

  countAll(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM models').get() as { n: number };
    return row.n;
  }
}

/* ─────────────────────────── aliases ─────────────────────────── */

interface AliasRow {
  alias: string;
  provider_id: string;
  model: string;
  enabled: number;
  params_json: string | null;
  fallbacks_json: string | null;
  notes: string | null;
  created_at: number;
  updated_at: number;
}

function rowToAlias(row: AliasRow): AliasRecord {
  let params: Record<string, unknown> | null = null;
  if (row.params_json) {
    try {
      params = JSON.parse(row.params_json) as Record<string, unknown>;
    } catch {
      params = null;
    }
  }
  let fallbacks: { provider_id: string; model: string }[] | null = null;
  if (row.fallbacks_json) {
    try {
      const parsed = JSON.parse(row.fallbacks_json) as unknown;
      if (Array.isArray(parsed)) {
        fallbacks = (parsed as Record<string, unknown>[])
          .filter((f) => f && typeof f.provider_id === 'string' && typeof f.model === 'string')
          .map((f) => ({ provider_id: f.provider_id as string, model: f.model as string }));
      }
    } catch {
      fallbacks = null;
    }
  }
  return {
    alias: row.alias,
    provider_id: row.provider_id,
    model: row.model,
    enabled: row.enabled === 1,
    params,
    fallbacks,
    notes: row.notes,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export class AliasRepo {
  constructor(private readonly db: Db) {}

  get(alias: string): AliasRecord | null {
    const row = this.db.prepare('SELECT * FROM aliases WHERE alias = ?').get(alias) as AliasRow | undefined;
    return row ? rowToAlias(row) : null;
  }

  list(): AliasRecord[] {
    const rows = this.db.prepare('SELECT * FROM aliases ORDER BY alias ASC').all() as unknown as AliasRow[];
    return rows.map(rowToAlias);
  }

  upsert(input: AliasRecord): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO aliases (alias, provider_id, model, enabled, params_json, fallbacks_json, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(alias) DO UPDATE SET provider_id = excluded.provider_id, model = excluded.model,
           enabled = excluded.enabled, params_json = excluded.params_json, fallbacks_json = excluded.fallbacks_json,
           notes = excluded.notes, updated_at = excluded.updated_at`,
      )
      .run(
        input.alias,
        input.provider_id,
        input.model,
        input.enabled ? 1 : 0,
        input.params ? JSON.stringify(input.params) : null,
        input.fallbacks ? JSON.stringify(input.fallbacks) : null,
        input.notes,
        input.created_at,
        now,
      );
  }

  delete(alias: string): void {
    this.db.prepare('DELETE FROM aliases WHERE alias = ?').run(alias);
  }
}

/* ─────────────────────────── API keys ─────────────────────────── */

export class ApiKeyRepo {
  constructor(private readonly db: Db) {}

  async create(label: string, expiresInDays: number | null): Promise<{ record: ApiKeyRecord; plaintext: string }> {
    const { plaintext, prefix } = newGatewayKey();
    const now = Date.now();
    const id = randomId('key');
    const expires_at = expiresInDays ? now + expiresInDays * 86_400_000 : null;
    const secretHash = await hashSecret(plaintext);
    this.db
      .prepare('INSERT INTO api_keys (id, label, key_prefix, secret_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, label, prefix, secretHash, expires_at, now);
    return {
      record: {
        id,
        label,
        key_prefix: prefix,
        expires_at,
        created_at: now,
        revoked_at: null,
        last_used_at: null,
      },
      plaintext,
    };
  }

  list(): ApiKeyRecord[] {
    const rows = this.db.prepare('SELECT * FROM api_keys ORDER BY created_at DESC').all() as Array<{
      id: string;
      label: string;
      key_prefix: string;
      expires_at: number | null;
      created_at: number;
      revoked_at: number | null;
      last_used_at: number | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      label: r.label,
      key_prefix: r.key_prefix,
      expires_at: r.expires_at,
      created_at: r.created_at,
      revoked_at: r.revoked_at,
      last_used_at: r.last_used_at,
    }));
  }

  findByPrefix(prefix: string): { id: string; secret_hash: string } | null {
    const row = this.db
      .prepare('SELECT id, secret_hash FROM api_keys WHERE key_prefix = ? AND revoked_at IS NULL')
      .get(prefix) as { id: string; secret_hash: string } | undefined;
    return row ?? null;
  }

  touch(id: string): void {
    this.db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(Date.now(), id);
  }

  revoke(id: string): boolean {
    const res = this.db.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(Date.now(), id);
    return res.changes > 0;
  }

  delete(id: string): boolean {
    const res = this.db.prepare('DELETE FROM api_keys WHERE id = ?').run(id);
    return res.changes > 0;
  }
}

export interface AuthenticatedKey {
  id: string;
  label: string;
}

export class KeyAuth {
  constructor(private readonly repo: ApiKeyRepo) {}

  /** Verifies a plaintext gateway key. Returns null when invalid/revoked/expired. */
  async authenticate(plaintext: string): Promise<AuthenticatedKey | null> {
    if (!plaintext.startsWith('zr_') || plaintext.length < 12) return null;
    const prefix = plaintext.slice(0, 12);
    const row = this.repo.findByPrefix(prefix);
    if (!row) return null;
    const ok = await verifySecret(plaintext, row.secret_hash);
    if (!ok) return null;
    return this.stamp(row.id);
  }

  private stamp(id: string): AuthenticatedKey | null {
    // Guard against revoked/expired state after async verification
    const record = this.repo.list().find((k) => k.id === id);
    if (!record || record.revoked_at) return null;
    if (record.expires_at && record.expires_at < Date.now()) return null;
    this.repo.touch(id);
    return { id: record.id, label: record.label };
  }
}

/* ─────────────────────────── routing ─────────────────────────── */

export class RoutingRepo {
  constructor(
    private readonly db: Db,
    private readonly providers: ProviderRepo,
    private readonly models: ModelRepo,
    private readonly aliases: AliasRepo,
  ) {}

  /** Deterministic routing (documented in docs/api.md). */
  resolve(modelRaw: string): ResolvedTarget | AliasRecord | { ambiguous: string[] } | null {
    const model = modelRaw.trim();
    if (!model) return null;

    // 1) alias
    const alias = this.aliases.get(model);
    if (alias) return alias;

    // 2) provider/model
    const slash = model.indexOf('/');
    if (slash > 0) {
      const providerId = model.slice(0, slash);
      const modelId = model.slice(slash + 1);
      const provider = this.providers.get(providerId);
      if (!provider) return { ambiguous: [] }; // invalid provider → not found
      const rec = this.models.get(providerId, modelId);
      if (!rec) return { ambiguous: [] };
      return { providerId, modelId, fallbacks: undefined, aliasParams: null };
    }

    // 3) bare model id — only unique matches route; ambiguity → explicit error
    const rows = this.db
      .prepare('SELECT m.provider_id, m.upstream_id, p.enabled FROM models m JOIN providers p ON p.id = m.provider_id WHERE m.upstream_id = ?')
      .all(model) as Array<{ provider_id: string; upstream_id: string; enabled: number }>;
    const enabledRows = rows.filter((r) => r.enabled === 1);
    if (enabledRows.length === 1) {
      return { providerId: enabledRows[0]!.provider_id, modelId: enabledRows[0]!.upstream_id, aliasParams: null, fallbacks: undefined };
    }
    if (enabledRows.length > 1) {
      return {
        ambiguous: [...new Set(enabledRows.map((r) => `${r.provider_id}/${r.upstream_id}`))],
      };
    }
    return null;
  }
}

/* ─────────────────────────── provider events ─────────────────────────── */

export interface ProviderEvent {
  id?: number;
  provider_id: string;
  ts: number;
  kind: 'connection_test' | 'discovery' | 'enable' | 'disable' | 'credentials' | 'auth_issue';
  status: 'ok' | 'failed' | null;
  message: string | null;
  latency_ms: number | null;
}

export class ProviderEventRepo {
  constructor(private readonly db: Db) {}

  add(evt: Omit<ProviderEvent, 'id'>): void {
    this.db
      .prepare('INSERT INTO provider_events (provider_id, ts, kind, status, message, latency_ms) VALUES (?, ?, ?, ?, ?, ?)')
      .run(evt.provider_id, evt.ts, evt.kind, evt.status, evt.message, evt.latency_ms);
  }

  forProvider(providerId: string, limit = 25): ProviderEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM provider_events WHERE provider_id = ? ORDER BY ts DESC LIMIT ?')
      .all(providerId, limit) as Array<{
      id: number;
      provider_id: string;
      ts: number;
      kind: string;
      status: string | null;
      message: string | null;
      latency_ms: number | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      provider_id: r.provider_id,
      ts: r.ts,
      kind: r.kind as ProviderEvent['kind'],
      status: (r.status as ProviderEvent['status']) ?? null,
      message: r.message,
      latency_ms: r.latency_ms,
    }));
  }

  /** Newest events across all providers (dashboard activity feed). */
  recent(limit = 50): ProviderEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM provider_events ORDER BY ts DESC LIMIT ?')
      .all(Math.min(Math.max(limit, 1), 200)) as Array<{
      id: number;
      provider_id: string;
      ts: number;
      kind: string;
      status: string | null;
      message: string | null;
      latency_ms: number | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      provider_id: r.provider_id,
      ts: r.ts,
      kind: r.kind as ProviderEvent['kind'],
      status: (r.status as ProviderEvent['status']) ?? null,
      message: r.message,
      latency_ms: r.latency_ms,
    }));
  }
}

/* ─────────────────────────── settings ─────────────────────────── */

export class SettingsRepo {
  constructor(private readonly db: Db) {}

  get<T>(key: string): T | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string | null } | undefined;
    if (!row || row.value === null) return null;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return null;
    }
  }

  set(key: string, value: unknown): void {
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value));
  }
}

/* ─────────────────────────── dashboard sessions ─────────────────────────── */

export class SessionRepo {
  constructor(private readonly db: Db) {}

  create(ttlMs: number): { id: string; expiresAt: number } {
    const id = randomId('sess', 24);
    const now = Date.now();
    const expiresAt = now + ttlMs;
    this.db.prepare('INSERT INTO sessions (id, created_at, expires_at) VALUES (?, ?, ?)').run(id, now, expiresAt);
    return { id, expiresAt };
  }

  valid(id: string): boolean {
    if (!id.startsWith('sess_')) return false;
    const row = this.db.prepare('SELECT expires_at FROM sessions WHERE id = ?').get(id) as
      | { expires_at: number }
      | undefined;
    if (!row) return false;
    return row.expires_at > Date.now();
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }

  /** Revokes every dashboard session (used on owner-credential rotation). */
  deleteAll(): number {
    const res = this.db.prepare('DELETE FROM sessions').run();
    return Number(res.changes);
  }

  prune(): void {
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  }
}

/* ─────────────────────────── owner credential ─────────────────────────── */

export interface OwnerCredentialRow {
  username: string;
  passwordHash: string;
  updatedAt: number;
}

/**
 * Single-row owner credential table. Provisioned only via the owner CLI
 * (`npm -w packages/server run owner`); no HTTP endpoint can create or change
 * it. The password is stored as a scrypt hash (`v1$…`), never in plaintext.
 */
export class OwnerCredentialRepo {
  constructor(private readonly db: Db) {}

  get(): OwnerCredentialRow | null {
    const row = this.db
      .prepare('SELECT username, password_hash, updated_at FROM owner_credential WHERE id = 1')
      .get() as { username: string; password_hash: string; updated_at: number } | undefined;
    if (!row) return null;
    return { username: row.username, passwordHash: row.password_hash, updatedAt: row.updated_at };
  }

  exists(): boolean {
    return this.get() !== null;
  }

  insert(username: string, passwordHash: string): void {
    const now = Date.now();
    this.db
      .prepare(
        'INSERT INTO owner_credential (id, username, password_hash, created_at, updated_at) VALUES (1, ?, ?, ?, ?)',
      )
      .run(username, passwordHash, now, now);
  }

  update(username: string, passwordHash: string): void {
    this.db
      .prepare('UPDATE owner_credential SET username = ?, password_hash = ?, updated_at = ? WHERE id = 1')
      .run(username, passwordHash, Date.now());
  }
}

/* ─────────────────────────── login throttle ─────────────────────────── */

export interface LoginThrottleRow {
  keyHash: string;
  attemptWindowStart: number;
  attemptCount: number;
  failureWindowStart: number;
  failureCount: number;
  cooldownUntil: number;
}

/** Persistence for dashboard-login abuse counters (keyed by hashed client IP). */
export class LoginThrottleRepo {
  constructor(private readonly db: Db) {}

  get(keyHash: string): LoginThrottleRow | null {
    const row = this.db
      .prepare(
        'SELECT key_hash, attempt_window_start, attempt_count, failure_window_start, failure_count, cooldown_until FROM login_throttle WHERE key_hash = ?',
      )
      .get(keyHash) as
      | {
          key_hash: string;
          attempt_window_start: number;
          attempt_count: number;
          failure_window_start: number;
          failure_count: number;
          cooldown_until: number;
        }
      | undefined;
    if (!row) return null;
    return {
      keyHash: row.key_hash,
      attemptWindowStart: row.attempt_window_start,
      attemptCount: row.attempt_count,
      failureWindowStart: row.failure_window_start,
      failureCount: row.failure_count,
      cooldownUntil: row.cooldown_until,
    };
  }

  upsert(row: LoginThrottleRow): void {
    this.db
      .prepare(
        `INSERT INTO login_throttle
           (key_hash, attempt_window_start, attempt_count, failure_window_start, failure_count, cooldown_until)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(key_hash) DO UPDATE SET
           attempt_window_start = excluded.attempt_window_start,
           attempt_count = excluded.attempt_count,
           failure_window_start = excluded.failure_window_start,
           failure_count = excluded.failure_count,
           cooldown_until = excluded.cooldown_until`,
      )
      .run(
        row.keyHash,
        row.attemptWindowStart,
        row.attemptCount,
        row.failureWindowStart,
        row.failureCount,
        row.cooldownUntil,
      );
  }

  clear(keyHash: string): void {
    this.db.prepare('DELETE FROM login_throttle WHERE key_hash = ?').run(keyHash);
  }

  clearAll(): void {
    this.db.prepare('DELETE FROM login_throttle').run();
  }

  /** Drops stale rows (no failures, cooldown elapsed) so the table stays tiny. */
  prune(now: number, maxAgeMs: number): void {
    this.db.prepare('DELETE FROM login_throttle WHERE cooldown_until < ? AND attempt_window_start < ?').run(now - maxAgeMs, now - maxAgeMs);
  }
}
