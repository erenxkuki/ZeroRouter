/**
 * Owner credential service: resolves the active dashboard auth mode and
 * verifies owner credentials. Three modes (mutually exclusive, in priority
 * order):
 *
 *   database      — owner credential provisioned into the DB via the owner CLI
 *                   (username + scrypt password hash). Preferred.
 *   environment   — ZEROROUTER_DASHBOARD_PASSWORD from the deployment env
 *                   (password-only fallback for existing deployments).
 *   loopback_only — no credential; admin API restricted to loopback clients.
 *
 * Non-enumeration: there is exactly one owner. Wrong username and wrong
 * password produce the same generic error, and a wrong username still costs
 * one full scrypt evaluation (against a throwaway hash) so the two failure
 * kinds are not distinguishable by latency.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import type { Db } from '../db/database.js';
import { OwnerCredentialRepo, SessionRepo, LoginThrottleRepo } from '../db/repos.js';
import { hashSecret, verifySecret } from '../crypto.js';
import { passwordMatches } from '../middleware.js';

export type OwnerAuthMode = 'loopback_only' | 'environment' | 'database';

/** Lower-cased owner handle: 3–32 chars of [a-z0-9._@-], starting alnum. */
export const USERNAME_RE = /^[a-z0-9][a-z0-9._@-]{2,31}$/;

export const PASSWORD_MIN_LEN = 10;
export const PASSWORD_MAX_LEN = 1024;
export const USERNAME_MAX_LEN = 64;

export const PASSWORD_HINT = `at least ${PASSWORD_MIN_LEN} characters`;

function digestEq(a: string, b: string): boolean {
  const da = createHash('sha256').update(a.normalize('NFKC')).digest();
  const db = createHash('sha256').update(b.normalize('NFKC')).digest();
  return timingSafeEqual(da, db);
}

export interface OwnerAuthServiceDeps {
  db: Db;
  ownerRepo: OwnerCredentialRepo;
  sessions: SessionRepo;
  loginThrottleRepo: LoginThrottleRepo;
  /** ZEROROUTER_DASHBOARD_PASSWORD (environment fallback); null when unset. */
  envPassword: string | null;
}

export class OwnerAuthService {
  private readonly db: Db;
  private readonly ownerRepo: OwnerCredentialRepo;
  private readonly sessions: SessionRepo;
  private readonly loginThrottleRepo: LoginThrottleRepo;
  private readonly envPassword: string | null;
  /** Throwaway hash so failed username checks burn the same scrypt time as
   *  failed password checks. Generated lazily on first use. */
  private dummyHash: Promise<string> | null = null;

  readonly initialMode: OwnerAuthMode;
  mode: OwnerAuthMode;
  username: string | null;

  constructor(deps: OwnerAuthServiceDeps) {
    this.db = deps.db;
    this.ownerRepo = deps.ownerRepo;
    this.sessions = deps.sessions;
    this.loginThrottleRepo = deps.loginThrottleRepo;
    this.envPassword = deps.envPassword;

    const stored = deps.ownerRepo.get();
    if (stored) {
      this.mode = 'database';
      this.username = stored.username;
    } else if (deps.envPassword) {
      this.mode = 'environment';
      this.username = null;
    } else {
      this.mode = 'loopback_only';
      this.username = null;
    }
    this.initialMode = this.mode;
  }

  /** True when the dashboard requires any credential (not loopback-only). */
  get credentialRequired(): boolean {
    return this.mode !== 'loopback_only';
  }

  /**
   * Verifies credentials. Inputs must already be normalized/length-capped by
   * the caller (route-time validation). Returns false for any invalid input.
   */
  async verify(username: string | null, password: string): Promise<boolean> {
    if (password.length === 0 || password.length > PASSWORD_MAX_LEN) return false;

    if (this.mode === 'environment') {
      return passwordMatches(password, this.envPassword ?? '');
    }
    if (this.mode !== 'database') return false;

    const row = this.ownerRepo.get();
    if (!row) return false;

    const uname = (username ?? '').normalize('NFKC').trim().toLowerCase();
    const unameOk = uname.length > 0 && uname.length <= USERNAME_MAX_LEN && digestEq(uname, row.username);
    const pwOk = await verifySecret(password, row.passwordHash);
    if (!unameOk) {
      // Even when the username is wrong, spend one full scrypt verification so
      // wrong-username attempts are not distinguishable by response latency.
      await this.dummyScryptCost(password);
    }
    return unameOk && pwOk;
  }

  private async dummyScryptCost(password: string): Promise<void> {
    if (!this.dummyHash) {
      this.dummyHash = hashSecret(randomBytes(24).toString('base64url'));
    }
    await verifySecret(password, await this.dummyHash);
  }

  /**
   * Creates or replaces the owner credential (CLI provisioning / rotation /
   * recovery). Revokes every dashboard session and clears login throttles.
   * Returns the number of revoked sessions.
   *
   * `allowShortPassword` accepts a password below the PASSWORD_MIN_LEN policy
   * floor. Default off — the CLI exposes it as an explicit `--allow-short-password`
   * flag that prints a warning, so a requested-but-weak password can still be
   * honored on a private deployment without weakening provisioning for everyone.
   */
  async provision(
    usernameInput: string,
    password: string,
    opts: { allowShortPassword?: boolean } = {},
  ): Promise<{ username: string; revokedSessions: number; created: boolean }> {
    const username = usernameInput.normalize('NFKC').trim().toLowerCase();
    if (!USERNAME_RE.test(username)) {
      throw new Error('Owner username must match 3–32 chars of [a-z0-9._@-], starting with a letter or digit.');
    }
    if (password.length < PASSWORD_MIN_LEN && !opts.allowShortPassword) {
      throw new Error(`Owner password must be ${PASSWORD_MIN_LEN}–${PASSWORD_MAX_LEN} characters (${PASSWORD_HINT}).`);
    }
    if (password.length > PASSWORD_MAX_LEN) {
      throw new Error(`Owner password must be ${PASSWORD_MIN_LEN}–${PASSWORD_MAX_LEN} characters (${PASSWORD_HINT}).`);
    }
    const hash = await hashSecret(password);
    const prior = this.ownerRepo.exists();
    return this.db.transaction(() => {
      if (prior) this.ownerRepo.update(username, hash);
      else this.ownerRepo.insert(username, hash);
      const revokedSessions = this.sessions.deleteAll();
      this.loginThrottleRepo.clearAll();
      this.mode = 'database';
      this.username = username;
      return { username, revokedSessions, created: !prior };
    });
  }
}
