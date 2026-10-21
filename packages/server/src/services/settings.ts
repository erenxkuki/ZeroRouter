/**
 * Runtime settings: persisted overrides merged over compile-time defaults.
 * The RateLimiter receives this object by reference so dashboard changes
 * apply live without restart.
 */
import { SettingsRepo } from '../db/repos.js';
import type { Executor } from '../db/storage.js';
import { DEFAULT_SETTINGS, type Settings } from '../config.js';
import type { SettingsPatch } from '../types.js';

const SETTINGS_KEY = 'settings';

export class SettingsService {
  private readonly repo: SettingsRepo;
  /** Mutable live view — pass this into RateLimiter so limits update in place. */
  live: Settings;

  private constructor(db: Executor) {
    this.repo = new SettingsRepo(db);
    this.live = { ...DEFAULT_SETTINGS };
  }

  /** Constructors can no longer read the DB synchronously; load persisted state here. */
  static async create(db: Executor): Promise<SettingsService> {
    const svc = new SettingsService(db);
    const stored = await svc.repo.get<Partial<Settings>>(SETTINGS_KEY);
    svc.live = { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
    return svc;
  }

  all(): Settings {
    return { ...this.live };
  }

  async patch(patch: SettingsPatch): Promise<Settings> {
    const applied: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      applied[k] = v;
    }
    // Runtime mutation by reference so RateLimiter (holding `live`) sees updates.
    Object.assign(this.live, applied as Partial<Settings>);
    // Persist merged record so later patches accumulate rather than replace.
    const stored = (await this.repo.get<Record<string, unknown>>(SETTINGS_KEY)) ?? {};
    await this.repo.set(SETTINGS_KEY, { ...stored, ...applied });
    return { ...this.live };
  }
}
