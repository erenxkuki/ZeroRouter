/**
 * Runtime settings: persisted overrides merged over compile-time defaults.
 * The RateLimiter receives this object by reference so dashboard changes
 * apply live without restart.
 */
import type { Db } from '../db/database.js';
import { SettingsRepo } from '../db/repos.js';
import { DEFAULT_SETTINGS, type Settings } from '../config.js';
import type { SettingsPatch } from '../types.js';

const SETTINGS_KEY = 'settings';

export class SettingsService {
  private readonly repo: SettingsRepo;
  /** Mutable live view — pass this into RateLimiter so limits update in place. */
  readonly live: Settings;

  constructor(db: Db) {
    this.repo = new SettingsRepo(db);
    this.live = { ...DEFAULT_SETTINGS, ...(this.repo.get<Partial<Settings>>(SETTINGS_KEY) ?? {}) };
  }

  all(): Settings {
    return { ...this.live };
  }

  patch(patch: SettingsPatch): Settings {
    const applied: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      applied[k] = v;
    }
    // Runtime mutation by reference so RateLimiter (holding `live`) sees updates.
    Object.assign(this.live, applied as Partial<Settings>);
    // Persist merged record so later patches accumulate rather than replace.
    const stored = this.repo.get<Record<string, unknown>>(SETTINGS_KEY) ?? {};
    this.repo.set(SETTINGS_KEY, { ...stored, ...applied });
    return { ...this.live };
  }
}
