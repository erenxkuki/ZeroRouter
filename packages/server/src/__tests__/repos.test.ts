import { describe, expect, it } from 'vitest';
import { Db } from '../db/database.js';
import {
  AliasRepo,
  ApiKeyRepo,
  KeyAuth,
  ModelRepo,
  ProviderEventRepo,
  ProviderRepo,
  RoutingRepo,
  SessionRepo,
} from '../db/repos.js';
import { RequestLogs } from '../services/requestLogs.js';
import { randomBytes } from 'node:crypto';

function freshDb(): Db {
  const db = new Db(':memory:');
  db.migrate();
  return db;
}

const MASTER = randomBytes(32);

function providerRepo(db: Db): ProviderRepo {
  return new ProviderRepo(db, MASTER);
}

function makeProvider(db: Db, id = 'prov-a', enabled = true) {
  const repo = providerRepo(db);
  return repo.create({
    id,
    name: 'Provider A',
    adapter: 'openai-compatible',
    enabled,
    base_url: 'http://127.0.0.1:18081',
    auth_type: 'bearer',
    auth_header: null,
    credentials: { api_key: 'sk-live-secret' },
    config: {},
    timeout_ms: 30000,
    retry_max: 1,
  });
}

describe('ApiKeyRepo + KeyAuth', () => {
  it('creates, lists, and never stores plaintext', async () => {
    const db = freshDb();
    const repo = new ApiKeyRepo(db);
    const { record, plaintext } = await repo.create('test-key', 30);
    expect(plaintext.startsWith('zr_')).toBe(true);
    expect(record.key_prefix).toBe(plaintext.slice(0, 12));
    expect(record.label).toBe('test-key');
    expect(record.revoked_at).toBeNull();
    expect(record.expires_at).toBeGreaterThan(Date.now());

    // plaintext must not be anywhere in the DB
    const raw = JSON.stringify(db.raw.prepare('SELECT * FROM api_keys').all());
    expect(raw).not.toContain(plaintext);

    const [stored] = repo.list();
    // list() rows must never expose the scrypt hash
    expect((stored as unknown as Record<string, unknown>)['secret_hash']).toBeUndefined();
    expect(stored?.id).toBe(record.id);
  });

  it('expiry null stores null and expiry days computes roughly', async () => {
    const db = freshDb();
    const repo = new ApiKeyRepo(db);
    const a = await repo.create('forever', null);
    expect(a.record.expires_at).toBeNull();
    const b = await repo.create('ten-days', 10);
    expect(b.record.expires_at).toBeGreaterThan(Date.now() + 9 * 86_400_000);
    expect(b.record.expires_at).toBeLessThan(Date.now() + 11 * 86_400_000);
  });

  it('revoke→false for unknown id, revoke→true then false (idempotence)', async () => {
    const db = freshDb();
    const repo = new ApiKeyRepo(db);
    const { record } = await repo.create('k', null);
    expect(repo.revoke('nope')).toBe(false);
    expect(record.revoked_at).toBeNull();
    expect(repo.revoke(record.id)).toBe(true);
    expect(repo.list()[0]!.revoked_at).not.toBeNull();
    expect(repo.revoke(record.id)).toBe(false);
  });

  it('records last_used_at via touch', async () => {
    const db = freshDb();
    const repo = new ApiKeyRepo(db);
    const { record } = await repo.create('k', null);
    expect(repo.list()[0]!.last_used_at).toBeNull();
    repo.touch(record.id);
    expect(repo.list()[0]!.last_used_at).not.toBeNull();
  });

  it('delete removes the row', async () => {
    const db = freshDb();
    const repo = new ApiKeyRepo(db);
    const { record } = await repo.create('k', null);
    expect(repo.delete(record.id)).toBe(true);
    expect(repo.delete(record.id)).toBe(false);
    expect(repo.list()).toHaveLength(0);
  });
});

describe('KeyAuth.authenticate', () => {
  it('authenticates the exact plaintext and rejects unknown/revoked/expired', async () => {
    const db = freshDb();
    const keys = new ApiKeyRepo(db);
    const auth = new KeyAuth(keys);
    const { plaintext } = await keys.create('good', null);
    const ok = await auth.authenticate(plaintext);
    expect(ok).not.toBeNull();
    expect(ok!.label).toBe('good');
    expect(await auth.authenticate('zr_wrong')).toBeNull();
    expect(await auth.authenticate('')).toBeNull();

    const { record, plaintext: p2 } = await keys.create('bye', null);
    keys.revoke(record.id);
    expect(await auth.authenticate(p2)).toBeNull();
  });
});

describe('ProviderRepo', () => {
  it('encrypts credentials at rest and decrypts on demand', () => {
    const db = freshDb();
    const repo = providerRepo(db);
    const rec = makeProvider(db);
    expect(rec.credentials_enc!.startsWith('enc1:')).toBe(true);
    expect(JSON.stringify(db.raw.prepare('SELECT * FROM providers').all())).not.toContain('sk-live-secret');
    expect(repo.credentials(rec)).toEqual({ api_key: 'sk-live-secret' });
  });

  it('update applies patches and bumps updated_at; updateCredentials decoding round trips', () => {
    const db = freshDb();
    makeProvider(db);
    const repo = providerRepo(db);
    const before = repo.get('prov-a')!;
    const origUpdated = before.updated_at;
    repo.update('prov-a', { name: 'Renamed', enabled: false });
    const after = repo.get('prov-a')!;
    expect(after.name).toBe('Renamed');
    expect(after.enabled).toBe(false);
    expect(after.updated_at).toBeGreaterThanOrEqual(origUpdated);
    // clear credentials
    repo.update('prov-a', { clearCredentials: true });
    expect(repo.get('prov-a')!.credentials_enc).toBeNull();
    // unknown provider is a no-op
    expect(() => repo.update('ghost', { name: 'x' })).not.toThrow();
  });

  it('delete cascades cleanly (unknown id tolerated)', () => {
    const db = freshDb();
    makeProvider(db);
    const repo = providerRepo(db);
    repo.delete('prov-a');
    expect(repo.get('prov-a')).toBeNull();
    expect(() => repo.delete('ghost')).not.toThrow();
  });
});

describe('ModelRepo', () => {
  it('upsertManual inserts and updates cammelCase items', () => {
    const db = freshDb();
    makeProvider(db);
    const models = new ModelRepo(db);
    models.upsertManual('prov-a', { upstreamId: 'm1', displayName: 'Model One', contextLength: 4096, streaming: true, tools: false }, Date.now());
    const rec = models.get('prov-a', 'm1')!;
    expect(rec.display_name).toBe('Model One');
    expect(rec.context_length).toBe(4096);
    expect(rec.source).toBe('manual');
    expect(rec.status).toBe('untested');
    models.upsertManual('prov-a', { upstreamId: 'm1', displayName: 'Model One v2' }, Date.now());
    expect(models.get('prov-a', 'm1')!.display_name).toBe('Model One v2');
    expect(models.get('prov-a', 'm1')!.context_length).toBe(4096); // untouched fields preserved
    expect(models.forProvider('prov-a')).toHaveLength(1);
    expect(models.forProvider('other')).toHaveLength(0);
  });

  it('delete removes only the matching pair', () => {
    const db = freshDb();
    makeProvider(db);
    const models = new ModelRepo(db);
    models.upsertManual('prov-a', { upstreamId: 'm1' }, Date.now());
    models.upsertManual('prov-a', { upstreamId: 'm2' }, Date.now());
    models.delete('prov-a', 'm1');
    expect(models.get('prov-a', 'm1')).toBeNull();
    expect(models.get('prov-a', 'm2')).not.toBeNull();
  });
});

describe('AliasRepo', () => {
  it('upsert stores full records and list serves them back', () => {
    const db = freshDb();
    // aliases carry an FK to (provider_id, model) — wire the targets first
    makeProvider(db);
    const models = new ModelRepo(db);
    models.upsertManual('prov-a', { upstreamId: 'm1' }, Date.now());
    models.upsertManual('prov-a', { upstreamId: 'm2' }, Date.now());
    const aliases = new AliasRepo(db);
    const now = Date.now();
    aliases.upsert({
      alias: 'fast',
      provider_id: 'prov-a',
      model: 'm1',
      enabled: true,
      params: { temperature: 0.1 },
      fallbacks: [{ provider_id: 'prov-a', model: 'm2' }],
      notes: null,
      created_at: now,
      updated_at: now,
    });
    const rec = aliases.get('fast')!;
    expect(rec.model).toBe('m1');
    expect(rec.params).toEqual({ temperature: 0.1 });
    expect(rec.fallbacks).toEqual([{ provider_id: 'prov-a', model: 'm2' }]);
    expect(aliases.get('nope')).toBeNull();
    aliases.delete('fast');
    expect(aliases.get('fast')).toBeNull();
    expect(() => aliases.delete('never-existed')).not.toThrow();
  });
});

describe('RoutingRepo.resolve — deterministic routing', () => {
  function wired() {
    const db = freshDb();
    makeProvider(db);
    const models = new ModelRepo(db);
    models.upsertManual('prov-a', { upstreamId: 'shared' }, Date.now());
    models.upsertManual('prov-a', { upstreamId: 'unique' }, Date.now());
    // second provider holding the same upstream id → ambiguity
    providerRepo(db).create({
      id: 'prov-b',
      name: 'Provider B',
      adapter: 'openai-compatible',
      enabled: true,
      base_url: 'http://127.0.0.1:1',
      auth_type: 'bearer',
      auth_header: null,
      credentials: null,
      config: {},
      timeout_ms: 30000,
      retry_max: 0,
    });
    models.upsertManual('prov-b', { upstreamId: 'shared' }, Date.now());
    providerRepo(db).create({
      id: 'prov-disabled',
      name: 'Disabled',
      adapter: 'openai-compatible',
      enabled: false,
      base_url: 'http://127.0.0.1:2',
      auth_type: 'bearer',
      auth_header: null,
      credentials: null,
      config: {},
      timeout_ms: 30000,
      retry_max: 0,
    });
    models.upsertManual('prov-disabled', { upstreamId: 'unique' }, Date.now());
    const aliases = new AliasRepo(db);
    aliases.upsert({ alias: 'fast', provider_id: 'prov-a', model: 'unique', enabled: true, params: null, fallbacks: null, notes: null, created_at: Date.now(), updated_at: Date.now() });
    const routing = new RoutingRepo(db, providerRepo(db), models, aliases);
    return { routing, models };
  }

  it('resolves exact provider/model first', () => {
    const { routing } = wired();
    const r = routing.resolve('prov-a/unique');
    expect(r).toMatchObject({ providerId: 'prov-a', modelId: 'unique', aliasParams: null });
  });

  it('aliases trump direct lookups', () => {
    const { routing } = wired();
    const r = routing.resolve('fast');
    expect((r as { alias: string }).alias).toBe('fast');
  });

  it('bare names route when unique, turn ambiguous when not', () => {
    const { routing } = wired();
    expect(routing.resolve('unique')).toMatchObject({ providerId: 'prov-a', modelId: 'unique' });
    const amb = routing.resolve('shared');
    expect((amb as { ambiguous?: string[] }).ambiguous).toBeTypeOf('object');
  });

  it('disabled providers are excluded from bare-name resolution', () => {
    // prov-disabled also has 'unique', so resolution is still unambiguous via enabled prov-a
    const { routing } = wired();
    expect(routing.resolve('unique')).toMatchObject({ providerId: 'prov-a' });
  });

  it('unknown models and empty strings → null', () => {
    const { routing } = wired();
    expect(routing.resolve('ghost/none')).toMatchObject({ ambiguous: [] }); // explicit not-found sentinel
    expect(routing.resolve('')).toBeNull();
    expect(routing.resolve('   ')).toBeNull();
  });
});

describe('SessionRepo', () => {
  it('creates, validates within TTL, expires past TTL, prunes', () => {
    const db = freshDb();
    const sessions = new SessionRepo(db);
    const { id } = sessions.create(300_000);
    expect(sessions.valid(id)).toBe(true);
    expect(sessions.valid('bogus')).toBe(false);
    // expired session
    const expired = sessions.create(1);
    const repo = sessions as unknown as { db: Db };
    repo.db.prepare('UPDATE sessions SET expires_at = 1 WHERE id = ?').run(expired.id);
    expect(sessions.valid(expired.id)).toBe(false);
    sessions.prune();
    expect(sessions.valid(id)).toBe(true);
    sessions.delete(id);
    expect(sessions.valid(id)).toBe(false);
  });
});

describe('ProviderEventRepo', () => {
  it('stores and lists events newest-first', () => {
    const db = freshDb();
    makeProvider(db);
    const events = new ProviderEventRepo(db);
    events.add({ provider_id: 'prov-a', ts: Date.now() - 1000, kind: 'connection_test', status: 'ok', message: 'ok', latency_ms: 12 });
    events.add({ provider_id: 'prov-a', ts: Date.now(), kind: 'discovery', status: null, message: 'found 2', latency_ms: 5 });
    const list = events.forProvider('prov-a');
    expect(list).toHaveLength(2);
    expect(list[0]!.kind).toBe('discovery');
    expect(list[1]!.kind).toBe('connection_test');
  });
});

describe('RequestLogs', () => {
  it('adds and lists with filters', () => {
    const db = freshDb();
    const logs = new RequestLogs(db);
    for (let i = 0; i < 5; i++) {
      logs.add({ id: `r${i}`, ts: Date.now() + i, source: 'gateway', status: i === 4 ? 500 : 200, model: 'm', stream: i % 2 === 0, provider_id: `p${i}`, error_code: i === 4 ? 'internal_error' : null, duration_ms: 10 + i });
    }
    const all = logs.list({ limit: 200 });
    expect(all.total).toBe(5);
    expect(all.rows[0]!.id).toBe('r4'); // newest first
    expect(logs.list({ status: 'error' }).total).toBe(1);
    expect(logs.list({ status: 'ok' }).total).toBe(4);
    expect(logs.list({ provider_id: 'p0' }).total).toBe(1);
    expect(logs.find('r1')!.stream).toBe(false);
    expect(logs.find('ghost')).toBeNull();
  });

  it('stats compute totals, rate, latency percentiles, tokens, streaming share', () => {
    const db = freshDb();
    const logs = new RequestLogs(db);
    logs.add({ id: 'g1', ts: Date.now(), source: 'gateway', status: 200, duration_ms: 100, prompt_tokens: 10, completion_tokens: 5, stream: false, provider_id: 'p' });
    logs.add({ id: 'g2', ts: Date.now(), source: 'gateway', status: 200, duration_ms: 200, prompt_tokens: 10, completion_tokens: 10, stream: true, provider_id: 'p' });
    logs.add({ id: 'g3', ts: Date.now(), source: 'gateway', status: 502, duration_ms: 50, error_code: 'provider_blocked', provider_id: 'p' });
    const stats = logs.stats();
    expect(stats.requests_24h).toBe(3);
    expect(stats.success_rate_24h).toBeCloseTo(2 / 3, 5);
    expect(stats.tokens_24h).toEqual({ prompt: 20, completion: 15 });
    expect(stats.streaming_share_24h).toBeCloseTo(1 / 3, 5);
    expect(stats.avg_latency_ms_24h).toBeCloseTo(Math.round((100 + 200 + 50) / 3), 5);
    expect(stats.recent_errors).toHaveLength(1);
    expect(stats.recent_errors[0]!.error_code).toBe('provider_blocked');
    expect(stats.p95_latency_ms_24h).toBe(100); // sorted [50,100,200] → ceiling index 1
  });

  it('retention prune removes old rows only', () => {
    const db = freshDb();
    const logs = new RequestLogs(db);
    logs.add({ id: 'old', ts: Date.now() - 30 * 86_400_000, source: 'gateway', status: 200 });
    logs.add({ id: 'new', ts: Date.now(), source: 'gateway', status: 200 });
    expect(logs.prune(14)).toBe(1);
    expect(logs.list({ limit: 100 }).total).toBe(1);
    expect(logs.find('new')).not.toBeNull();
  });
});
