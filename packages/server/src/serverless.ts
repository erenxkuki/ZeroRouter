/**
 * ZeroRouter serverless runtime (Vercel twin of `index.ts`).
 *
 * Shares the exact wiring (repos, services, app) with the always-on entry via
 * `runtime.ts`, but never binds a socket and keeps no interval — Vercel calls
 * the returned fetch-style handler per request and freezes the instance
 * between cold starts. Database state must live in Postgres (`ZEROROUTER_DATABASE_URL`)
 * because the function filesystem is ephemeral (and, except for `/tmp`,
 * read-only).
 *
 * Cold-start policy:
 *   - boot failures throw loudly (misconfiguration is a function error, not a
 *     silent fallback to a useless instance);
 *   - the retention sweep runs once per cold start, fire-and-forget.
 *
 * Streaming: the handler simply returns the runtime's `app.fetch` Response, so
 * SSE streams pass through unchanged — bounded externally by the platform's
 * `maxDuration` (60 s on the Hobby plan).
 */
import { loadConfig, type AppConfig } from './config.js';
import { logger, setLogLevel, type LogLevel } from './logger.js';
import { buildRuntime, runMaintenanceSweep, type Runtime } from './runtime.js';

const log = logger('serverless');

export type FetchHandler = (req: Request) => Promise<Response> | Response;

/**
 * Resolves the config for a serverless environment. Vercel's filesystem is
 * ephemeral, so the data dir (only used for temp files under this mode) goes
 * to `/tmp`, and the static dashboard is served from the CDN — `webDist`
 * must point at nothing inside this bundle.
 */
function loadServerlessConfig(env: NodeJS.ProcessEnv): AppConfig {
  const cfg = loadConfig({
    ...env,
    // Function sandbox: /tmp is the only writable path. No state is kept
    // there that has to survive (SQLite mode is rejected below anyway).
    ZEROROUTER_DATA_DIR: env['ZEROROUTER_DATA_DIR'] ?? '/tmp/zerorouter-data',
  });
  // Static assets are served by Vercel's CDN (vercel.json → packages/web/dist).
  // Serving them from the function would shadow the CDN and read from a path
  // that does not exist in the bundle.
  return { ...cfg, webDist: null, devCorsOrigin: null, env: 'production' };
}

function failServerless(bad: boolean, message: string): void {
  if (!bad) return;
  throw new Error(`Serverless boot refused: ${message}`);
}

/** Builds the runtime once per instance and returns a request handler. */
export async function createVercelHandler(env: NodeJS.ProcessEnv = process.env): Promise<Pick<Runtime, 'cfg' | 'db' | 'app'> & { ready: Promise<void>; handle: FetchHandler }> {
  failServerless(
    !env['ZEROROUTER_DATABASE_URL'],
    'ZEROROUTER_DATABASE_URL is required — the function filesystem is ephemeral, so local SQLite storage is not usable here. ' +
      'Point it at Postgres (e.g. the Supabase Transaction pooler URL, port 6543). See docs/vercel-deploy.md.',
  );
  failServerless(
    !env['ZEROROUTER_MASTER_KEY'],
    'ZEROROUTER_MASTER_KEY must be set — without it a fresh key is generated per cold start and ' +
      'previously encrypted provider credentials become undecryptable. See docs/vercel-deploy.md.',
  );

  const cfg = loadServerlessConfig(env);
  setLogLevel(cfg.logLevel as LogLevel);

  const rt = await buildRuntime(cfg);

  failServerless(
    !rt.ownerAuth.credentialRequired,
    'no dashboard credential is configured for this deployment. Provision the owner credential in the ' +
      'database (`npm -w packages/server run owner -- set-owner` against the same database, or the CLI hint in ' +
      'docs/vercel-deploy.md) or set ZEROROUTER_DASHBOARD_PASSWORD. Every /console route must be authenticated.',
  );

  // Retention/pruning with no interval: catch each cold start up.
  const ready = runMaintenanceSweep(rt).catch(() => undefined);

  log.info('serverless runtime ready', {
    env: cfg.env,
    storage: 'postgres',
    owner_auth_mode: rt.ownerAuth.mode,
  });

  return {
    cfg,
    db: rt.db,
    app: rt.app,
    ready,
    handle: (req) => rt.app.fetch(req),
  };
}
