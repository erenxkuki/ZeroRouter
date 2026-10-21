/**
 * Live Postgres storage verifier — run after setting ZEROROUTER_DATABASE_URL:
 *
 *   npm run db:verify -w packages/server
 *
 * Connects, applies migrations (idempotent), round-trips a settings row,
 * confirms every expected table exists and prints row counts. Exits 0 on
 * PASS, 1 on failure. Never prints the connection string.
 */
import { PgStore } from './pg.js';

const EXPECTED_TABLES = [
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

async function main(): Promise<void> {
  const url = process.env['ZEROROUTER_DATABASE_URL'];
  if (!url) {
    console.error('FAIL: ZEROROUTER_DATABASE_URL is not set (expected the Supabase connection string).');
    process.exitCode = 1;
    return;
  }

  const store = new PgStore({ url });
  try {
    await store.ping();
    console.log('connect: OK');

    const ran = await store.migrate();
    console.log(ran.length > 0 ? `migrations applied: ${ran.join(', ')}` : 'migrations: already up to date');

    const roundtripKey = `zr_pg_verify_${Date.now()}`;
    await store.sql`INSERT INTO settings (key, value) VALUES (${roundtripKey}, ${'pong'})`;
    const readBack = await store.sql<{ value: string | null }[]>`SELECT value FROM settings WHERE key = ${roundtripKey}`;
    const value = readBack.length === 1 ? (readBack[0]?.value ?? null) : null;
    await store.sql`DELETE FROM settings WHERE key = ${roundtripKey}`;
    if (value !== 'pong') {
      throw new Error(`settings round-trip mismatch: got ${String(value)}`);
    }
    console.log('settings round-trip: OK (write → read → delete)');

    const tables = await store.sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`;
    const names = new Set(tables.map((row) => row.table_name));
    const missing = EXPECTED_TABLES.filter((table) => !names.has(table));
    if (missing.length > 0) {
      throw new Error(`missing tables: ${missing.join(', ')}`);
    }
    console.log(`schema: all ${EXPECTED_TABLES.length} tables present`);

    console.log('row counts:');
    for (const table of EXPECTED_TABLES) {
      const rows = (await store.sql.unsafe(`SELECT COUNT(*)::int AS n FROM ${table}`)) as Array<{ n: number }>;
      const n = rows[0]?.n ?? -1;
      console.log(`  ${table.padEnd(18)}${n >= 0 ? n : '?'} row(s)`);
    }

    console.log('PASS: Postgres storage backend is ready.');
  } catch (err) {
    console.error(`FAIL: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  } finally {
    await store.close();
  }
}

await main();
