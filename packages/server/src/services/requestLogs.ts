import type { Db } from '../db/database.js';
import { logger } from '../logger.js';

const log = logger('logs');

export interface RequestLogInput {
  id: string;
  ts: number;
  source: 'gateway' | 'playground' | 'admin' | 'discovery' | 'connection_test';
  client_key_id?: string | null;
  provider_id?: string | null;
  provider_name?: string | null;
  model?: string | null;
  alias?: string | null;
  stream?: boolean;
  status: number;
  duration_ms?: number | null;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  error_code?: string | null;
  error_message?: string | null;
  body_json?: string | null;
}

export interface RequestLogRecord extends RequestLogInput {}

export class RequestLogs {
  constructor(private readonly db: Db) {}

  add(input: RequestLogInput): void {
    try {
      this.db
        .prepare(
          `INSERT INTO request_logs (id, ts, source, client_key_id, provider_id, provider_name, model, alias,
           stream, status, duration_ms, prompt_tokens, completion_tokens, error_code, error_message, body_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.ts,
          input.source,
          input.client_key_id ?? null,
          input.provider_id ?? null,
          input.provider_name ?? null,
          input.model ?? null,
          input.alias ?? null,
          input.stream ? 1 : 0,
          input.status,
          input.duration_ms ?? null,
          input.prompt_tokens ?? null,
          input.completion_tokens ?? null,
          input.error_code ?? null,
          input.error_message ?? null,
          input.body_json ?? null,
        );
    } catch (err) {
      log.error('failed to persist request log', { err: String(err) });
    }
  }

  list(filters: {
    provider_id?: string | null;
    status?: 'ok' | 'error' | null;
    since?: number | null;
    limit?: number;
    offset?: number;
  }): { rows: RequestLogRecord[]; total: number } {
    const conditions: string[] = [];
    const values: (string | number)[] = [];
    if (filters.provider_id) {
      conditions.push('provider_id = ?');
      values.push(filters.provider_id);
    }
    if (filters.status === 'ok') conditions.push('status < 400');
    if (filters.status === 'error') conditions.push('status >= 400');
    if (filters.since) {
      conditions.push('ts >= ?');
      values.push(filters.since);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
    const offset = Math.max(filters.offset ?? 0, 0);
    const countRow = this.db.prepare(`SELECT COUNT(*) AS n FROM request_logs ${where}`).get(...values) as { n: number };
    const rows = this.db
      .prepare(`SELECT * FROM request_logs ${where} ORDER BY ts DESC LIMIT ? OFFSET ?`)
      .all(...values, limit, offset) as Array<Record<string, unknown>>;
    return { rows: rows.map(rowToLog), total: countRow.n };
  }

  find(id: string): RequestLogRecord | null {
    const row = this.db.prepare('SELECT * FROM request_logs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? rowToLog(row) : null;
  }

  /** Deletes records older than retention. Returns rows removed. */
  prune(retentionDays: number): number {
    const cutoff = Date.now() - retentionDays * 86_400_000;
    const res = this.db.prepare('DELETE FROM request_logs WHERE ts < ?').run(cutoff);
    return Number(res.changes);
  }

  clear(): void {
    this.db.raw.exec('DELETE FROM request_logs;');
  }

  stats(): {
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
  } {
    const now = Date.now();
    const since24 = now - 86_400_000;
    const since7d = now - 7 * 86_400_000;
    const count = (since: number) =>
      (this.db.prepare('SELECT COUNT(*) AS n FROM request_logs WHERE ts >= ? AND source != ?').get(since, 'connection_test') as { n: number }).n;
    const agg24 = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN status < 400 THEN 1 ELSE 0 END) AS ok,
                AVG(duration_ms) AS avg,
                SUM(prompt_tokens) AS prompt,
                SUM(completion_tokens) AS completion,
                SUM(CASE WHEN stream = 1 THEN 1 ELSE 0 END) AS streamed
         FROM request_logs WHERE ts >= ? AND source != ?`,
      )
      .get(since24, 'connection_test') as {
      total: number;
      ok: number | null;
      avg: number | null;
      prompt: number | null;
      completion: number | null;
      streamed: number | null;
    };
    // p95 via sorted duration sample bound (last 1000)
    const durations = (
      this.db
        .prepare('SELECT duration_ms FROM request_logs WHERE ts >= ? AND duration_ms IS NOT NULL ORDER BY duration_ms DESC LIMIT 1000')
        .all(since24) as Array<{ duration_ms: number }>
    ).map((r) => r.duration_ms);
    durations.sort((a, b) => a - b);
    const p95 = durations.length > 0 ? durations[Math.floor(0.95 * (durations.length - 1))]! : null;

    const providerCounts = this.db
      .prepare('SELECT COUNT(*) AS total, SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) AS enabled FROM providers')
      .get() as { total: number; enabled: number | null };

    const recentErrors = (
      this.db
        .prepare(
          `SELECT ts, provider_id, error_code, error_message, status FROM request_logs
           WHERE status >= 400 AND source != 'connection_test' ORDER BY ts DESC LIMIT 8`,
        )
        .all() as Array<Record<string, unknown>>
    ).map((r) => ({
      ts: Number(r['ts']),
      provider_id: (r['provider_id'] as string | null) ?? null,
      error_code: (r['error_code'] as string | null) ?? null,
      error_message: (r['error_message'] as string | null) ?? null,
      status: Number(r['status']),
    }));

    const total24 = Number(agg24.total ?? 0);
    return {
      providers_configured: Number(providerCounts.total ?? 0),
      providers_enabled: Number(providerCounts.enabled ?? 0),
      models_total: (this.db.prepare('SELECT COUNT(*) AS n FROM models').get() as { n: number }).n,
      requests_24h: total24,
      requests_7d: count(since7d),
      success_rate_24h: total24 > 0 && agg24.ok !== null ? Number(agg24.ok) / total24 : null,
      avg_latency_ms_24h: agg24.avg !== null ? Math.round(Number(agg24.avg)) : null,
      p95_latency_ms_24h: p95,
      streaming_share_24h: total24 > 0 && agg24.streamed !== null ? Number(agg24.streamed) / total24 : null,
      recent_errors: recentErrors,
      tokens_24h:
        agg24.prompt !== null || agg24.completion !== null
          ? { prompt: Number(agg24.prompt ?? 0), completion: Number(agg24.completion ?? 0) }
          : null,
    };
  }

  activitySeries24h(): { bucket: number; total: number; errors: number }[] {
    const now = Date.now();
    const since = now - 24 * 3600_000;
    const rows = this.db
      .prepare(
        `SELECT CAST(ts / 3600000 AS INTEGER) AS h,
                COUNT(*) AS total,
                SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS errors
         FROM request_logs WHERE ts >= ? AND source != 'connection_test'
         GROUP BY h ORDER BY h ASC`,
      )
      .all(since) as Array<{ h: number; total: number; errors: number }>;
    return rows.map((r) => ({ bucket: r.h * 3_600_000, total: Number(r.total), errors: Number(r.errors) }));
  }
}

function rowToLog(r: Record<string, unknown>): RequestLogRecord {
  return {
    id: String(r['id']),
    ts: Number(r['ts']),
    source: String(r['source']) as RequestLogRecord['source'],
    client_key_id: (r['client_key_id'] as string | null) ?? null,
    provider_id: (r['provider_id'] as string | null) ?? null,
    provider_name: (r['provider_name'] as string | null) ?? null,
    model: (r['model'] as string | null) ?? null,
    alias: (r['alias'] as string | null) ?? null,
    stream: Number(r['stream']) === 1,
    status: Number(r['status']),
    duration_ms: (r['duration_ms'] as number | null) ?? null,
    prompt_tokens: (r['prompt_tokens'] as number | null) ?? null,
    completion_tokens: (r['completion_tokens'] as number | null) ?? null,
    error_code: (r['error_code'] as string | null) ?? null,
    error_message: (r['error_message'] as string | null) ?? null,
    body_json: (r['body_json'] as string | null) ?? null,
  };
}
