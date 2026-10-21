import { performance } from 'node:perf_hooks';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let currentLevel: LogLevel = (process.env['ZEROROUTER_LOG_LEVEL'] as LogLevel) || 'info';

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

const SECRET_KEY_RE =
  /^(authorization|auth|api_?key|apikey|secret|password|credential|credentials|credentials_enc|token|session|cookie)$/i;
const SECRET_PATTERN_RE =
  /(bearer\s+[A-Za-z0-9._~+/=-]{12,}|x-api-key\s*:\s*\S+|sk-[A-Za-z0-9_-]{16,}|Bearer [A-Za-z0-9._~+/=-]{12,})/gi;

/** Scrubs obvious secrets from an arbitrary value for logging/diagnostics. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth]';
  if (typeof value === 'string') {
    return value.replace(SECRET_PATTERN_RE, (m) => `${m.slice(0, Math.min(6, m.length))}…[REDACTED]`);
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_RE.test(k)) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = redact(v, depth + 1);
      }
    }
    return out;
  }
  return value;
}

function emit(level: LogLevel, scope: string, message: string, meta?: unknown): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel]) return;
  const row = {
    ts: new Date().toISOString(),
    level,
    scope,
    msg: message,
    ...(meta !== undefined ? { meta: redact(meta) } : {}),
  };
  const line = JSON.stringify(row);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export interface ScopedLogger {
  debug(msg: string, meta?: unknown): void;
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
}

export function logger(scope: string): ScopedLogger {
  return {
    debug: (msg, meta) => emit('debug', scope, msg, meta),
    info: (msg, meta) => emit('info', scope, msg, meta),
    warn: (msg, meta) => emit('warn', scope, msg, meta),
    error: (msg, meta) => emit('error', scope, msg, meta),
  };
}

export function nowMs(): number {
  return performance.now();
}
