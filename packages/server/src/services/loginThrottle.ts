/**
 * Dashboard-login abuse protection (§ login security):
 *
 *  - an attempt-rate bucket: max `attemptLimit` login attempts per client IP
 *    per rolling `attemptWindowMs` (blocks brute-force hammering — scrypt
 *    verification is deliberately expensive);
 *  - a progressive cooldown: the 3rd and each further consecutive failure
 *    doubles the cooldown (0.5 s → cap 5 min). Cooldowns are temporary and
 *    never result in a permanent lockout; a successful login clears all state
 *    for that client, and the owner CLI `unlock` command clears everything.
 *
 * Counters are stored in the database (`login_throttle`, keyed by a hash of
 * the client address — no raw IPs at rest) so they survive restarts, matching
 * the DB-backed design used for sessions.
 */
import { createHash } from 'node:crypto';

import type { LoginThrottleRepo } from '../db/repos.js';

export interface LoginThrottleConfig {
  /** Max login attempts per client within `attemptWindowMs`. */
  attemptLimit: number;
  attemptWindowMs: number;
  /** Consecutive-failure window: counts reset when it elapses. */
  failureWindowMs: number;
  /** Cooldown after the 3rd consecutive failure; doubles per further failure. */
  baseCooldownMs: number;
  /** Never lock out longer than this. */
  maxCooldownMs: number;
}

export const LOGIN_THROTTLE_DEFAULTS: LoginThrottleConfig = {
  attemptLimit: 12,
  attemptWindowMs: 60_000,
  failureWindowMs: 15 * 60_000,
  baseCooldownMs: 500,
  maxCooldownMs: 5 * 60_000,
};

/** Stable storage key for a client address: sha256 hex (no raw IPs at rest). */
export function loginKeyHash(clientAddress: string | null): string {
  return createHash('sha256').update(clientAddress ?? 'unknown-address').digest('hex');
}

export class LoginThrottleService {
  constructor(
    private readonly repo: LoginThrottleRepo,
    private readonly cfg: LoginThrottleConfig,
  ) {}

  /** `null` when the caller may attempt a login, otherwise a retry delay (ms). */
  async precheck(keyHash: string, now = Date.now()): Promise<number | null> {
    const row = await this.repo.get(keyHash);
    if (!row) return null;
    if (row.cooldownUntil > now) return row.cooldownUntil - now;
    if (now - row.attemptWindowStart >= this.cfg.attemptWindowMs) return null;
    if (row.attemptCount >= this.cfg.attemptLimit) {
      return Math.max(1, this.cfg.attemptWindowMs - (now - row.attemptWindowStart));
    }
    return null;
  }

  /** Counts one attempt consumed (call after a passing precheck). */
  async consume(keyHash: string, now = Date.now()): Promise<void> {
    const row = await this.repo.get(keyHash);
    if (!row || now - row.attemptWindowStart >= this.cfg.attemptWindowMs) {
      await this.repo.upsert({
        keyHash,
        attemptWindowStart: now,
        attemptCount: 1,
        failureWindowStart: row?.failureWindowStart ?? now,
        failureCount: row?.failureCount ?? 0,
        cooldownUntil: 0,
      });
      return;
    }
    await this.repo.upsert({ ...row, attemptCount: row.attemptCount + 1, cooldownUntil: 0 });
  }

  async recordFailure(keyHash: string, now = Date.now()): Promise<void> {
    const row = await this.repo.get(keyHash);
    const base = row ?? {
      keyHash,
      attemptWindowStart: now,
      attemptCount: 0,
      failureWindowStart: now,
      failureCount: 0,
      cooldownUntil: 0,
    };
    const continuingFailure = now - base.failureWindowStart < this.cfg.failureWindowMs;
    const failureWindowStart = continuingFailure ? base.failureWindowStart : now;
    const failureCount = (continuingFailure ? base.failureCount : 0) + 1;
    let cooldownMs = 0;
    if (failureCount >= 3) {
      cooldownMs = Math.min(this.cfg.maxCooldownMs, this.cfg.baseCooldownMs * 2 ** (failureCount - 3));
    }
    await this.repo.upsert({
      ...base,
      failureWindowStart,
      failureCount,
      cooldownUntil: now + cooldownMs,
    });
  }

  /** A successful login clears all throttle state for the client. */
  async recordSuccess(keyHash: string): Promise<void> {
    await this.repo.clear(keyHash);
  }

  async clearAll(): Promise<void> {
    await this.repo.clearAll();
  }

  async prune(now = Date.now(), maxAgeMs = 24 * 3600_000): Promise<void> {
    await this.repo.prune(now, maxAgeMs);
  }
}
