/**
 * Runtime assembly shared by every entrypoint: repositories, services and the
 * HTTP application. Process-level concerns (binding a socket, keeping a
 * maintenance interval, draining on shutdown) stay with the entrypoints:
 *
 *   - `index.ts`      → buildRuntime + node server + maintenance interval
 *   - `serverless.ts` → buildRuntime + one request handler per invocation
 *
 * Keeping the wiring in one place means the serverless deployment cannot
 * drift from the always-on one: same guards, same services, same app.
 */
import type { Hono } from 'hono';
import { type AppConfig } from './config.js';
import { createStorageFromConfig, type StorageBackend } from './db/storage.js';
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
import { createApp, type AppEnv } from './app.js';
import { makeTransportHooks } from './adapters/transport-helpers.js';
import { logger } from './logger.js';

const log = logger('runtime');

export interface Runtime {
  cfg: AppConfig;
  db: StorageBackend;
  app: Hono<AppEnv>;
  /* What entrypoints need beyond the app itself. */
  logs: RequestLogs;
  sessions: SessionRepo;
  loginThrottleRepo: LoginThrottleRepo;
  loginThrottle: LoginThrottleService;
  settings: SettingsService;
  ownerAuth: OwnerAuthService;
  limiter: RateLimiter;
}

/** Builds all repositories/services and the hono app (dependency injection). */
export async function buildRuntime(cfg: AppConfig): Promise<Runtime> {
  const db = await createStorageFromConfig(cfg);

  const providers = new ProviderRepo(db, cfg.masterKey);
  const models = new ModelRepo(db);
  const aliases = new AliasRepo(db);
  const events = new ProviderEventRepo(db);
  const keys = new ApiKeyRepo(db);
  const keyAuth = new KeyAuth(keys);
  const sessions = new SessionRepo(db);
  const logs = new RequestLogs(db);
  const settings = await SettingsService.create(db);
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

  const ownerAuth = await OwnerAuthService.create({
    db,
    ownerRepo: new OwnerCredentialRepo(db),
    sessions,
    loginThrottleRepo: new LoginThrottleRepo(db),
    envPassword: cfg.dashboardPassword,
  });
  const loginThrottleRepo = new LoginThrottleRepo(db);
  const loginThrottle = new LoginThrottleService(loginThrottleRepo, LOGIN_THROTTLE_DEFAULTS);

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

  log.debug('runtime assembled', { env: cfg.env, storage: cfg.databaseUrl ? 'postgres' : 'sqlite' });

  return {
    cfg,
    db,
    app,
    logs,
    sessions,
    loginThrottleRepo,
    loginThrottle,
    settings,
    ownerAuth,
    limiter,
  };
}

/**
 * One maintenance sweep: log retention + session/throttle pruning. The
 * always-on entrypoint runs it on an interval; the serverless entrypoint runs
 * it once per cold start (best-effort, excluded from request latency).
 */
export async function runMaintenanceSweep(rt: Runtime): Promise<void> {
  try {
    const removed = await rt.logs.prune(rt.settings.live.log_retention_days);
    await rt.sessions.prune();
    await rt.loginThrottle.prune();
    if (removed > 0) log.info('retention sweep removed log rows', { removed });
  } catch (err) {
    log.warn('maintenance sweep failed', { err: String(err) });
  }
}
