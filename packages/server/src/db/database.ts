/**
 * Local SQLite storage engine (node:sqlite) implementing the StorageBackend
 * seam (db/storage.js). Default when ZEROROUTER_DATABASE_URL is unset; the
 * Postgres backend (db/pg.js) is the opt-in remote mode.
 *
 * Synchronous inner mechanics: statement execution happens at the call site
 * (no hidden awaits inside query/exec), so per-statement atomicity matches the
 * previous fully-sync design. A transaction remains connection-scoped
 * (BEGIN/COMMIT), exactly as before.
 */
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import type { Executor, Row, StorageBackend } from './storage.js';
import { MIGRATIONS } from './migrations.js';
import { logger } from '../logger.js';

const log = logger('db');

export class Db implements StorageBackend {
  readonly raw: DatabaseSync;
  private stmtCache = new Map<string, StatementSync>();

  constructor(dbPath: string) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.raw = new DatabaseSync(dbPath);
    this.raw.exec('PRAGMA journal_mode = WAL;');
    this.raw.exec('PRAGMA foreign_keys = ON;');
    this.raw.exec('PRAGMA busy_timeout = 5000;');
    this.raw.exec('PRAGMA synchronous = NORMAL;');
  }

  /** Runs a read; returns every matching row as a plain object. */
  query(sql: string, params: unknown[] = []): Promise<Row[]> {
    const rows = this.prepare(sql).all(...(params as unknown as SQLInputValue[])) as unknown as Row[];
    return Promise.resolve(rows);
  }

  /** Runs a write; returns the number of affected rows. */
  exec(sql: string, params: unknown[] = []): Promise<number> {
    const res = this.prepare(sql).run(...(params as unknown as SQLInputValue[]));
    return Promise.resolve(Number(res.changes));
  }

  prepare(sql: string): StatementSync {
    const cached = this.stmtCache.get(sql);
    if (cached) return cached;
    const stmt = this.raw.prepare(sql);
    this.stmtCache.set(sql, stmt);
    return stmt;
  }

  /** Runs `fn` inside a connection-scoped transaction; rolls back on throw. */
  transaction<T>(fn: (tx: Executor) => Promise<T>): Promise<T> {
    return (async () => {
      this.raw.exec('BEGIN');
      try {
        const result = await fn(this);
        this.raw.exec('COMMIT');
        return result;
      } catch (err) {
        try {
          this.raw.exec('ROLLBACK');
        } catch {
          /* already rolled back */
        }
        throw err;
      }
    })();
  }

  async migrate(): Promise<string[]> {
    this.raw.exec(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);',
    );
    const applied = new Set<string>(
      this.raw
        .prepare('SELECT version FROM schema_migrations ORDER BY applied_at')
        .all()
        .map((r) => String((r as { version: string }).version)),
    );
    const ran: string[] = [];
    for (const m of MIGRATIONS) {
      if (applied.has(m.id)) continue;
      log.info('applying migration', { id: m.id });
      await this.transaction(async () => {
        this.raw.exec(m.sql);
        this.raw
          .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
          .run(m.id, Date.now());
      });
      ran.push(m.id);
    }
    return ran;
  }

  close(): Promise<void> {
    try {
      this.raw.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    } catch (err) {
      log.warn('wal checkpoint failed on close', { err: String(err) });
    }
    this.raw.close();
    return Promise.resolve();
  }
}
