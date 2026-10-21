/**
 * ZeroRouter server entrypoint (always-on mode).
 *
 * Boot order matters for safety:
 *   1. load config (fails fast on insecure remote binds without a password)
 *   2. open + migrate the database
 *   3. repositories/services + the hono app (shared runtime wiring)
 *   4. bind (loopback unless explicitly opted in)
 *   5. schedule maintenance (log retention, session pruning)
 *
 * The serverless twin (`serverless.ts`) shares steps 2–3 via `runtime.ts` and
 * skips the socket + interval entirely.
 */
import { serve } from '@hono/node-server';

import { loadConfig, type AppConfig } from './config.js';
import { logger, setLogLevel, type LogLevel } from './logger.js';
import { buildRuntime, runMaintenanceSweep, type Runtime } from './runtime.js';

const log = logger('server');

export interface RunningServer {
  config: AppConfig;
  db: Runtime['db'];
  server: ReturnType<typeof serve>;
  stop(): Promise<void>;
}

/** Builds the runtime and binds the HTTP server. */
export async function bootstrap(env: NodeJS.ProcessEnv = process.env): Promise<RunningServer> {
  const cfg = loadConfig(env);
  setLogLevel(cfg.logLevel as LogLevel);

  const rt = await buildRuntime(cfg);

  const server = serve({ fetch: rt.app.fetch, hostname: cfg.host, port: cfg.port }, (info) => {
    log.info('zerorouter listening', {
      host: info.address,
      port: info.port,
      env: cfg.env,
      remote: cfg.allowRemote,
      owner_auth_mode: rt.ownerAuth.mode,
      data_dir: cfg.dataDir,
    });
    // eslint-disable-next-line no-console
    console.log(`ZeroRouter ready on http://${cfg.host}:${info.port} (${cfg.env})`);
  });

  /* ─── maintenance loop: log retention + session pruning ─── */

  const maintenance = setInterval(() => {
    void runMaintenanceSweep(rt);
  }, 10 * 60_000);
  maintenance.unref();

  /* ─── lifecycle ─── */

  const stop = (): Promise<void> =>
    new Promise((resolve) => {
      clearInterval(maintenance);
      // Close idle keep-alive sockets up front so a quiesced server finishes
      // closing immediately; in-flight requests still complete nominally.
      // Optional call: only http/1 servers expose closeIdleConnections.
      (server as { closeIdleConnections?: () => void }).closeIdleConnections?.();
      // Force-drain only as a last resort: armed per close and cancelled the
      // moment close() completes. Without the cancellation a finished
      // shutdown would still force-exit the process ten seconds later while
      // other work is running (observed under vitest workers).
      let drainTimer: ReturnType<typeof setTimeout> | null = null;
      server.close((err) => {
        if (err) log.warn('server close reported an error', { err: String(err) });
        if (drainTimer) clearTimeout(drainTimer);
        drainTimer = null;
        void rt.db
          .close()
          .then(() => log.info('database closed'))
          .catch((closeErr: unknown) => log.error('database close failed', { err: String(closeErr) }))
          .finally(() => resolve());
      });
      drainTimer = setTimeout(() => {
        server.getConnections((connErr, count) => {
          log.warn('drain timeout exceeded; forcing exit', { connections: connErr ? String(connErr) : count });
          process.exit(1);
        });
      }, 10_000).unref();
    });

  return { config: cfg, db: rt.db, server: server as RunningServer['server'], stop };
}

/** CLI entrypoint. */
async function main(): Promise<void> {
  const running = await bootstrap();

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.warn('shutting down', { signal });
    void running.stop().then(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => {
    log.error('uncaught exception', { err: err.stack ?? String(err) });
  });
  process.on('unhandledRejection', (reason) => {
    log.error('unhandled rejection', { reason: reason instanceof Error ? reason.stack : String(reason) });
  });
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href;
if (invokedDirectly) {
  void main().catch((err) => {
    log.error('fatal boot failure', { err: err instanceof Error ? err.stack : String(err) });
    // eslint-disable-next-line no-console
    console.error('Fatal boot failure:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}

export { logger as serverLogger };
