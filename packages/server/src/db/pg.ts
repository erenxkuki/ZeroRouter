/**
 * Postgres storage backend (Supabase-compatible) — docs/postgres-migration.md.
 *
 * Implements the StorageBackend seam (db/storage.js): statements arrive as
 * SQLite-flavored text (`?` positional placeholders, LIKE) and are translated
 * (`$1..$n`, ILIKE) before execution. Runtime-verified against the driver:
 * `sql.unsafe(query, params)` takes `$n` placeholders and returns JS `null`
 * for SQL NULL; `?` placeholders are NOT translated by the driver itself.
 */
import postgres from 'postgres';
import { logger } from '../logger.js';
import type { Executor, Row, StorageBackend } from './storage.js';
import { PG_MIGRATIONS } from './migrations.pg.js';

const log = logger('db.pg');

export interface PgStoreOptions {
  /** postgres:// or postgresql:// connection string. */
  url: string;
  /** Max pooled connections. */
  max?: number;
  /**
   * Server-side prepared statements. Required false on the Supabase
   * transaction pooler (port 6543); false also on always-on hosts avoids
   * prepared-statement leakage across pooled connections.
   */
  prepare?: boolean;
}

/**
 * Translates SQLite-flavored statement text to Postgres:
 *   1. `LIKE` → `ILIKE` at word boundaries outside single-quoted strings
 *      (SQLite matches case-insensitively by default; Postgres does not).
 *   2. `?` positional placeholders → `$1..$n` (the driver does not do this).
 * Single-quoted strings (including `''` escapes) are copied verbatim.
 */
export function toPgSql(sql: string): string {
  let out = '';
  let n = 0;
  let inString = false;
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    if (inString) {
      out += ch;
      if (ch === "'") {
        if (sql[i + 1] === "'") {
          out += "'";
          i += 2;
          continue;
        }
        inString = false;
      }
      i++;
      continue;
    }
    if (ch === "'") {
      inString = true;
      out += ch;
      i++;
      continue;
    }
    if (/^like/i.test(sql.slice(i, i + 5))) {
      const before = i > 0 ? sql[i - 1]! : ' ';
      const after = sql[i + 4] ?? '';
      if (!/[A-Za-z0-9_]/.test(before) && !/[A-Za-z0-9_]/.test(after)) {
        out += 'ILIKE';
        i += 4;
        continue;
      }
    }
    if (ch === '?' && sql[i + 1] !== '?') {
      n += 1;
      out += `$${n}`;
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

export class PgStore implements StorageBackend {
  readonly sql: postgres.Sql;

  constructor(options: PgStoreOptions) {
    this.sql = postgres(options.url, {
      max: options.max ?? 10,
      prepare: options.prepare ?? false,
      ssl: 'require',
      connect_timeout: 15,
      idle_timeout: 60,
      // IF NOT EXISTS DDL emits "relation already exists, skipping" NOTICEs on
      // every boot of an already-migrated database — informational only.
      onnotice: () => {},
      // int8 comes back as a string by default. Epoch-ms values fit safely in
      // a JS number (< 2^53), so parse BIGINT columns back to numbers and
      // keep the Date.now()-based logic in the repos layer unchanged.
      types: {
        bigint: {
          to: 20,
          from: [20],
          serialize: (x: number | string) => String(x),
          parse: (x: string) => Number(x),
        },
      },
    });
  }

  async ping(): Promise<void> {
    await this.sql`SELECT 1`;
  }

  /**
   * Single boundary for the driver call: postgres.js narrows unsafe()'s param
   * type far beyond what ever reaches the repos (all values are JS
   * primitives or null), so the executor asserts it once here.
   */
  private async driver(queryText: string, params: unknown[]): Promise<unknown[] & { count: number }> {
    const res = (await this.sql.unsafe(queryText, params as unknown as never[])) as unknown as unknown[] & {
      count: number;
    };
    return res;
  }

  /** Runs a read; returns every matching row as a plain object. */
  async query(sqlText: string, params: unknown[] = []): Promise<Row[]> {
    return (await this.driver(toPgSql(sqlText), params)) as Row[];
  }

  /** Runs a write; returns the number of affected rows. */
  async exec(sqlText: string, params: unknown[] = []): Promise<number> {
    const res = await this.driver(toPgSql(sqlText), params);
    return res.count;
  }

  /** Executes `fn` inside a single transaction; rolls back on throw. */
  async transaction<T>(fn: (tx: Executor) => Promise<T>): Promise<T> {
    // NOTE (pg): transaction scope escapes only through the Executor handed to
    // `fn`; repos accept any Executor, which is how tx-scoped repo instances
    // participate in the same transaction (docs/postgres-migration.md).
    return (await this.sql.begin(async (tx) => {
      const txExec: Executor = {
        query: async (q, p = []) =>
          (await tx.unsafe(toPgSql(q), p as unknown as never[])) as unknown as Row[],
        exec: async (q, p = []) =>
          (await tx.unsafe(toPgSql(q), p as unknown as never[])).count,
      };
      return fn(txExec);
      // The callback is Promise-returning by contract; postgres.js types
      // begin()'s result through DeferredPromiseUnwrap, hence the cast.
    })) as unknown as Promise<T>;
  }

  /**
   * Applies pending migrations once each, inside a transaction per migration,
   * tracked in schema_migrations with the same ids as the SQLite runner. DDL
   * is IF NOT EXISTS so re-running over a Supabase project whose schema was
   * created via docs/schema.postgres.sql is a no-op, not an error.
   */
  async migrate(): Promise<string[]> {
    await this.sql`CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at BIGINT NOT NULL
    )`;

    const applied = await this.sql<{ version: string }[]>`SELECT version FROM schema_migrations`;
    const done = new Set(applied.map((row) => row.version));

    const ran: string[] = [];
    for (const migration of PG_MIGRATIONS) {
      if (done.has(migration.id)) continue;
      const start = Date.now();
      await this.sql.begin(async (tx) => {
        await tx.unsafe(migration.sql);
        await tx`INSERT INTO schema_migrations (version, applied_at) VALUES (${migration.id}, ${Date.now()})`;
      });
      ran.push(migration.id);
      log.info(`migration ${migration.id} applied in ${Date.now() - start}ms`);
    }
    return ran;
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }
}
