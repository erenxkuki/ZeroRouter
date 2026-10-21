/**
 * ZeroRouter server entrypoint.
 *
 * Boot order matters for safety:
 *   1. load config (fails fast on insecure remote binds without a password)
 *   2. open + migrate the database
 *   3. construct repos/services + the hono app (dependency injection)
 *   4. bind (loopback unless explicitly opted in)
 *   5. schedule maintenance (log retention, session pruning)
 */
import { serve } from '@hono/node-server';
import path from 'node:path';

import { loadConfig, type AppConfig } from './config.js';
import { logger, setLogLevel, type LogLevel } from './logger.js';
import { Db } from './db/database.js';
import {
  AliasRepo,
  ApiKeyRepo,
  KeyAuth,
  LoginThrottleRepo,
  ModelRepo,
  OwnerCredentialRepo,
  ProviderEventRepo,
  ProviderRepo,
  SessionRepo,
} from './db/repos.js';
import { OwnerAuthService } from './services/ownerAuth.js';
import { LoginThrottleService, LOGIN_THROTTLE_DEFAULTS } from './services/loginThrottle.js';
import { RequestLogs } from './services/requestLogs.js';
import { RateLimiter } from './services/rateLimit.js';
import { SettingsService } from './services/settings.js';
import { ChatRuntime } from './services/chatRuntime.js';
import { ProviderService } from './services/providerService.js';
import { createApp } from './app.js';
import { makeTransportHooks } from './adapters/transport-helpers.js';

const log = logger('server');

export interface RunningServer {
  config: AppConfig;
  db: Db;
  server: ReturnType<typeof serve>;
  stop(): Promise<void>;
}

/** Builds all repositories/services and binds the HTTP server. */
export async function bootstrap(env: NodeJS.ProcessEnv = process.env): Promise<RunningServer> {
  const cfg = loadConfig(env);
  setLogLevel(cfg.logLevel as LogLevel);

  const db = new Db(path.join(cfg.dataDir, 'gateway.db'));
  db.migrate();

  const providers = new ProviderRepo(db, cfg.masterKey);
  const models = new ModelRepo(db);
  const aliases = new AliasRepo(db);
  const events = new ProviderEventRepo(db);
  const keys = new ApiKeyRepo(db);
  const keyAuth = new KeyAuth(keys);
  const sessions = new SessionRepo(db);
  const logs = new RequestLogs(db);
  const settings = new SettingsService(db);
  const limiter = new RateLimiter({
    burst: settings.live.rate_limit_burst,
    perMinute: settings.live.rate_limit_per_minute,
    maxInflight: settings.live.max_inflight_requests,
  });

  const providerService = new ProviderService(db, providers, models, events, aliases, (policy) =>
    makeTransportHooks(policy),
  );
  const runtime = new ChatRuntime(db, providers, models, aliases, {
    urlPolicy: { allowInsecureHttp: true },
  });

  /* ─── owner authentication (DB-provisioned credential > env fallback) ─── */

  const ownerAuth = new OwnerAuthService({
    db,
    ownerRepo: new OwnerCredentialRepo(db),
    sessions,
    loginThrottleRepo: new LoginThrottleRepo(db),
    envPassword: cfg.dashboardPassword,
  });
  const loginThrottle = new LoginThrottleService(
    new LoginThrottleRepo(db),
    LOGIN_THROTTLE_DEFAULTS,
  );

  // Definitive remote-bind guard: the credential may come from the environment
  // (config) or from the provisioned owner row (database). Refuse any remote
  // bind that would expose an unauthenticated dashboard.
  if (cfg.allowRemote && !ownerAuth.credentialRequired) {
    throw new Error(
      'ZEROROUTER_ALLOW_REMOTE=true requires a dashboard credential: provision the owner credential ' +
        '(`npm -w packages/server run owner -- set-owner`) or set ZEROROUTER_DASHBOARD_PASSWORD. ' +
        'A management console reachable from other machines must be authenticated.',
    );
  }

  const app = createApp({
    cfg,
    settings,
    limiter,
    admin: {
      cfg,
      providers: providerService,
      providerRepo: providers,
      models,
      aliases,
      events,
      keys,
      keyAuth,
      sessions,
      settings,
      logs,
      limiter,
      runtime,
      ownerAuth,
      loginThrottle,
      trustProxy: cfg.trustProxy,
    },
    v1: { runtime, providers, models, aliases, logs },
    gatewayAuth: { keys, authenticate: (plain) => keyAuth.authenticate(plain) },
  });

  const server = serve({ fetch: app.fetch, hostname: cfg.host, port: cfg.port }, (info) => {
    log.info('zerorouter listening', {
      host: info.address,
      port: info.port,
      env: cfg.env,
      remote: cfg.allowRemote,
      owner_auth_mode: ownerAuth.mode,
      data_dir: cfg.dataDir,
    });
    // eslint-disable-next-line no-console
    console.log(`ZeroRouter ready on http://${cfg.host}:${info.port} (${cfg.env})`);
  });

  /* ─── maintenance loop: log retention + session pruning ─── */

  const maintenance = setInterval(() => {
    try {
      const removed = logs.prune(settings.live.log_retention_days);
      sessions.prune();
      loginThrottle.prune();
      if (removed > 0) log.info('retention sweep removed log rows', { removed });
    } catch (err) {
      log.warn('maintenance sweep failed', { err: String(err) });
    }
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
        try {
          db.close();
          log.info('database closed');
        } catch (closeErr) {
          log.error('database close failed', { err: String(closeErr) });
        }
        resolve();
      });
      drainTimer = setTimeout(() => {
        server.getConnections((connErr, count) => {
          log.warn('drain timeout exceeded; forcing exit', { connections: connErr ? String(connErr) : count });
          process.exit(1);
        });
      }, 10_000).unref();
    });

  return { config: cfg, db, server: server as RunningServer['server'], stop };
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
