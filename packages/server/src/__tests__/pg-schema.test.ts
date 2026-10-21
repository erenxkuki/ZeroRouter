/**
 * Static checks for the Postgres migration translations (db/migrations.pg.js):
 * the runner ids stay in lock-step with the SQLite migrations, every table of
 * the schema is defined, and the type-policy anchors (identity pk for events,
 * single-row owner credential) survive translation. Connection-level behavior
 * is covered by `npm run db:verify` against a live database.
 */
import { describe, expect, it } from 'vitest';

import { MIGRATIONS } from '../db/migrations.js';
import { PG_MIGRATIONS } from '../db/migrations.pg.js';

const TABLES = [
  'providers',
  'models',
  'aliases',
  'api_keys',
  'request_logs',
  'provider_events',
  'settings',
  'sessions',
  'owner_credential',
  'login_throttle',
] as const;

describe('PG migration translations', () => {
  it('keep the SQLite migration ids one-to-one', () => {
    expect(PG_MIGRATIONS.map((m) => m.id)).toEqual(MIGRATIONS.map((m) => m.id));
  });

  it('define every table of the SQLite schema', () => {
    const all = PG_MIGRATIONS.map((m) => m.sql).join('\n');
    // schema_migrations is created by the runner (PgStore.migrate), not by a
    // migration entry — the loop below covers every user-data table.
    for (const table of TABLES) {
      expect(all).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\s*\\(`));
    }
  });

  it('use identity generation for provider_events.id', () => {
    const init = PG_MIGRATIONS.find((m) => m.id === '0001_init');
    expect(init?.sql).toContain('GENERATED ALWAYS AS IDENTITY');
  });

  it('keep the canonical indexes from the SQLite migrations', () => {
    const all = PG_MIGRATIONS.map((m) => m.sql).join('\n');
    for (const index of ['idx_models_provider', 'idx_logs_ts', 'idx_logs_provider', 'idx_logs_status', 'idx_provider_events', 'idx_aliases_model']) {
      expect(all).toContain(index);
    }
  });

  it('keep the single-row owner credential constraint', () => {
    const owner = PG_MIGRATIONS.find((m) => m.id === '0003_owner_credential');
    expect(owner?.sql).toContain('CHECK (id = 1)');
  });
});
