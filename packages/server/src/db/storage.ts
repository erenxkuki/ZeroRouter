/**
 * Storage seam shared by the local SQLite engine (node:sqlite) and the
 * Postgres backend (Supabase, via db/pg.js).
 *
 * Repositories depend only on `Executor`: plain statement text with positional
 * `?` placeholders and snake_case result rows. Everything backend-specific
 * (placeholder renumbering, ILIKE normalization, JS-null/number shaping)
 * lives inside the adapters, so repos.ts is written once.
 *
 * Selection: `ZEROROUTER_DATABASE_URL` set → Postgres; otherwise local SQLite
 * file under the data directory. Both paths run the same migration ids.
 */
import path from 'node:path';
import type { AppConfig } from '../config.js';
import { PgStore } from './pg.js';

export type Row = Record<string, unknown>;

/** Statement-only interface. Also serves transaction-scoped executor scopes. */
export interface Executor {
  /** Run a read; returns every matching row (empty array when none match). */
  query(sql: string, params?: unknown[]): Promise<Row[]>;
  /** Run a write; returns the number of affected rows. */
  exec(sql: string, params?: unknown[]): Promise<number>;
}

/** Executor plus lifecycle. Implemented by both storage engines. */
export interface StorageBackend extends Executor {
  transaction<T>(fn: (tx: Executor) => Promise<T>): Promise<T>;
  /** Applies pending migrations; returns the migration ids applied this run. */
  migrate(): Promise<string[]>;
  close(): Promise<void>;
}

/** Picks the storage backend from config and applies migrations. */
export async function createStorage(input: {
  databaseUrl: string | null;
  dataDir: string;
}): Promise<StorageBackend> {
  if (input.databaseUrl) {
    const pg = new PgStore({ url: input.databaseUrl });
    await pg.migrate();
    return pg;
  }
  // Dynamic import on purpose: node:sqlite stays out of the static import
  // graph, so a Postgres-only deployment (e.g. Vercel serverless) bundles and
  // boots without it — and runtimes older than its introduction still work.
  const { Db } = await import('./database.js');
  const db = new Db(path.join(input.dataDir, 'gateway.db'));
  await db.migrate();
  return db;
}

export function createStorageFromConfig(cfg: AppConfig): Promise<StorageBackend> {
  return createStorage({ databaseUrl: cfg.databaseUrl, dataDir: cfg.dataDir });
}
