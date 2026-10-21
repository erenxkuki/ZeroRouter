import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface AppConfig {
  env: 'development' | 'production' | 'test';
  /** Bind address. Loopback by default; non-loopback requires explicit opt-in. */
  host: string;
  port: number;
  dataDir: string;
  /** Postgres connection string (Supabase). Unset → local SQLite storage. */
  databaseUrl: string | null;
  /** Master key material for AES-256-GCM credential encryption (32 bytes). */
  masterKey: Buffer;
  /** Env-provided dashboard password (legacy fallback for owner login). */
  dashboardPassword: string | null;
  allowRemote: boolean;
  /** Trust x-forwarded-for/-proto from a TLS-terminating reverse proxy. */
  trustProxy: boolean;
  logLevel: LogLevel;
  /** Absolute path of the built web console (served in production). */
  webDist: string | null;
  devCorsOrigin: string | null;
}

export const LIMITS = {
  request_body_bytes: 2 * 1024 * 1024, // inbound client bodies
  response_capture_bytes: 16 * 1024 * 1024, // upstream response read cap
  max_messages: 256,
  max_message_parts: 64,
  max_tools: 64,
  default_provider_timeout_ms: 120_000,
  max_provider_timeout_ms: 600_000,
  max_output_tokens: 262_144,
} as const;

export const DEFAULT_SETTINGS = {
  /** Record request/response bodies in request logs (privacy-sensitive). */
  debug_log_request_bodies: false,
  log_retention_days: 14,
  max_inflight_requests: 8,
  rate_limit_per_minute: 120,
  rate_limit_burst: 30,
  stream_max_events: 20_000,
} as const;

export type Settings = typeof DEFAULT_SETTINGS;

function bool(v: string | undefined): boolean {
  if (v === undefined) return false;
  return /^(1|true|yes|on)$/i.test(v);
}

function isLoopbackHost(host: string): boolean {
  if (host === 'localhost') return true;
  if (host === '127.0.0.1' || host === '::1' || host === '127.0.0.2') return true;
  return false;
}

function resolveMasterKey(env: NodeJS.ProcessEnv, dataDir: string): Buffer {
  const fromEnv = env['ZEROROUTER_MASTER_KEY'];
  if (fromEnv && fromEnv.length > 0) {
    const buf = Buffer.from(fromEnv.trim(), 'base64');
    if (buf.length !== 32) {
      throw new Error(
        'ZEROROUTER_MASTER_KEY must be 32 raw bytes encoded as base64 (44 chars ending with "=").',
      );
    }
    return buf;
  }
  const keyPath = path.join(dataDir, '.master_key');
  if (existsSync(keyPath)) {
    const buf = Buffer.from(readFileSync(keyPath, 'utf8').trim(), 'base64');
    if (buf.length !== 32) {
      throw new Error(
        `Master key file ${keyPath} is corrupt (expected 32 raw bytes base64-encoded).`,
      );
    }
    return buf;
  }
  // Auto-generate an application master key. Stored outside the database so the
  // encrypted credentials and their key never sit in the same file.
  const buf = randomBytes(32);
  try {
    writeFileSync(keyPath, buf.toString('base64') + '\n', { encoding: 'utf8' });
    try {
      // Best effort POSIX permission hardening; Windows enforces per-user ACL via parent dir.
      chmodSync(keyPath, 0o600);
    } catch {
      /* on Windows chmod is a no-op; ACL of the profile directory applies */
    }
  } catch (err) {
    throw new Error(`Unable to persist generated master key to ${keyPath}: ${String(err)}`);
  }
  return buf;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const envType = (env['NODE_ENV'] ?? 'development') as AppConfig['env'];
  const dataDir = path.resolve(env['ZEROROUTER_DATA_DIR'] ?? './data');
  if (!existsSync(dataDir)) {
    try {
      mkdirSync(dataDir, { recursive: true });
    } catch (err) {
      throw new Error(`Cannot create data directory ${dataDir}: ${String(err)}`);
    }
  } else if (!statSync(dataDir).isDirectory()) {
    throw new Error(`ZEROROUTER_DATA_DIR path exists and is not a directory: ${dataDir}`);
  }

  const masterKey = resolveMasterKey(env, dataDir);

  const host = env['ZEROROUTER_HOST'] ?? '127.0.0.1';
  const portRaw = env['ZEROROUTER_PORT'] ?? '8787';
  const port = Number.parseInt(portRaw, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid ZEROROUTER_PORT: ${portRaw}`);
  }

  const allowRemote = bool(env['ZEROROUTER_ALLOW_REMOTE']);
  const dashboardPassword = env['ZEROROUTER_DASHBOARD_PASSWORD'] || null;
  const trustProxy = bool(env['ZEROROUTER_TRUST_PROXY']);

  const databaseUrl = env['ZEROROUTER_DATABASE_URL'] || null;
  if (databaseUrl && !/^postgres(ql)?:\/\//.test(databaseUrl)) {
    throw new Error('ZEROROUTER_DATABASE_URL must be a postgres:// or postgresql:// connection string.');
  }

  if (!isLoopbackHost(host) && !allowRemote) {
    throw new Error(
      `Refusing to bind ${host}. ZeroRouter binds loopback only by default. ` +
        'To listen on a public interface set ZEROROUTER_ALLOW_REMOTE=true, provide a dashboard credential ' +
        '(ZEROROUTER_DASHBOARD_PASSWORD or a provisioned owner credential), ' +
        'and put the server behind TLS. See docs/security.md.',
    );
  }
  // A remote bind requires a dashboard credential. This cannot be fully
  // validated here because the owner credential lives in the database; the
  // definitive check runs in bootstrap() once the DB is open.

  const logLevel = (env['ZEROROUTER_LOG_LEVEL'] as LogLevel) ?? 'info';
  if (!['debug', 'info', 'warn', 'error'].includes(logLevel)) {
    throw new Error(`Invalid ZEROROUTER_LOG_LEVEL: ${String(env['ZEROROUTER_LOG_LEVEL'])}`);
  }

  const webDist =
    env['ZEROROUTER_WEB_DIST'] ||
    (envType === 'production' ? resolveWebDistDefault() : null) ||
    null;

  const devCorsOrigin = env['ZEROROUTER_DEV_CORS_ORIGIN'] || null;

  return {
    env: envType,
    host,
    port,
    dataDir,
    databaseUrl,
    masterKey,
    dashboardPassword,
    allowRemote,
    trustProxy,
    logLevel,
    webDist,
    devCorsOrigin,
  };
}

/**
 * Default location of the built web console. Works both when running from
 * `src/` (tsx) and when running compiled output from `dist/`.
 */
function resolveWebDistDefault(): string {
  const here = fileURLToPath(import.meta.url);
  const packagesDir = path.resolve(path.dirname(here), '..', '..');
  return path.join(packagesDir, 'web', 'dist');
}
