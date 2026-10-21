import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { MIGRATIONS } from './migrations.js';
import { logger } from '../logger.js';

const log = logger('db');

export class Db {
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

  prepare(sql: string): StatementSync {
    const cached = this.stmtCache.get(sql);
    if (cached) return cached;
    const stmt = this.raw.prepare(sql);
    this.stmtCache.set(sql, stmt);
    return stmt;
  }

  /** Runs a function inside a transaction; rolls back on throw. */
  transaction<T>(fn: () => T): T {
    this.raw.exec('BEGIN');
    try {
      const result = fn();
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
  }

  migrate(): void {
    this.raw.exec(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);',
    );
    const applied = new Set<string>(
      this.raw
        .prepare('SELECT version FROM schema_migrations ORDER BY applied_at')
        .all()
        .map((r) => String((r as { version: string }).version)),
    );
    for (const m of MIGRATIONS) {
      if (applied.has(m.id)) continue;
      log.info('applying migration', { id: m.id });
      this.transaction(() => {
        this.raw.exec(m.sql);
        this.raw
          .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
          .run(m.id, Date.now());
      });
    }
  }

  close(): void {
    try {
      this.raw.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    } catch (err) {
      log.warn('wal checkpoint failed on close', { err: String(err) });
    }
    this.raw.close();
  }
}
