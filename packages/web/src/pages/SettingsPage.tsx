/** Runtime settings editor with server-validated constraints. */
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { Save, Settings as SettingsIcon } from 'lucide-react';
import { api, type Settings } from '../api';
import { Badge, ErrorNote, Field, Loading, Panel, Toggle } from '../ui';

interface FormState {
  debug_log_request_bodies: boolean;
  log_retention_days: string;
  max_inflight_requests: string;
  rate_limit_per_minute: string;
  rate_limit_burst: string;
  stream_max_events: string;
}

function toForm(s: Settings): FormState {
  return {
    debug_log_request_bodies: s.debug_log_request_bodies,
    log_retention_days: String(s.log_retention_days),
    max_inflight_requests: String(s.max_inflight_requests),
    rate_limit_per_minute: String(s.rate_limit_per_minute),
    rate_limit_burst: String(s.rate_limit_burst),
    stream_max_events: String(s.stream_max_events),
  };
}

const NUMERIC: { key: keyof FormState; min: number; max: number; label: string; hint: string }[] = [
  { key: 'log_retention_days', min: 1, max: 365, label: 'Log retention (days)', hint: 'Older request log rows are pruned by the retention sweeper.' },
  { key: 'max_inflight_requests', min: 1, max: 512, label: 'Max in-flight requests', hint: 'Global concurrent gateway + playground cap.' },
  { key: 'rate_limit_per_minute', min: 1, max: 10_000, label: 'Rate limit / minute / key', hint: 'Sustained request budget per gateway key.' },
  { key: 'rate_limit_burst', min: 1, max: 10_000, label: 'Rate limit burst', hint: 'Token-bucket ceiling; must be ≥ rate/minute ÷ 60.' },
  { key: 'stream_max_events', min: 1, max: 100_000, label: 'Stream event cap', hint: 'Hard safety cap on relayed SSE chunks per response.' },
];

export function SettingsPage() {
  const [loaded, setLoaded] = useState<{ settings: Settings; dashboard_password: string; notes: Record<string, string> } | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    setLoadError(null);
    api
      .settings()
      .then((r) => {
        setLoaded(r);
        setForm(toForm(r.settings));
        setSaveNotice(null);
      })
      .catch((e: unknown) => setLoadError(e));
  }, []);
  useEffect(load, [load]);

  const validate = (f: FormState): string | null => {
    for (const n of NUMERIC) {
      const v = Number(f[n.key]);
      if (!Number.isFinite(v) || !Number.isInteger(v) || v < n.min || v > n.max) {
        return `${n.label}: integer between ${n.min} and ${n.max}.`;
      }
    }
    const burst = Number(f.rate_limit_burst);
    const perMinute = Number(f.rate_limit_per_minute);
    if (burst < perMinute / 60) return 'Rate limit burst must be at least rate/minute ÷ 60.';
    return null;
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!form) return;
    setSaveError(null);
    setSaveNotice(null);
    const invalid = validate(form);
    if (invalid) {
      setSaveError(invalid);
      return;
    }
    const patch: Partial<Settings> = {
      debug_log_request_bodies: form.debug_log_request_bodies,
      log_retention_days: Number(form.log_retention_days),
      max_inflight_requests: Number(form.max_inflight_requests),
      rate_limit_per_minute: Number(form.rate_limit_per_minute),
      rate_limit_burst: Number(form.rate_limit_burst),
      stream_max_events: Number(form.stream_max_events),
    };
    setSaving(true);
    try {
      const res = await api.patchSettings(patch);
      setForm(toForm(res.settings));
      setLoaded((l) => (l ? { ...l, settings: res.settings } : l));
      setSaveNotice('Settings applied (persisted in the gateway database).');
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      {loadError !== null && <ErrorNote error={loadError} onRetry={load} />}
      {loadError === null && (loaded === null || form === null) && <Loading label="Loading settings" />}
      {loadError === null && loaded !== null && form !== null && (
        <>
          <div className="grid gap-4 md:grid-cols-2">
            <Panel
              title={
                <span className="flex items-center gap-2">
                  <SettingsIcon size={15} className="text-amber" /> Runtime settings
                </span>
              }
            >
              <form onSubmit={submit} className="space-y-3">
                <div className="rounded-md border border-hairline bg-panel-raised px-3 py-2.5">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-[13px]">Store request bodies in logs</div>
                      <div className="text-[11.5px] text-ink-faint">{loaded.notes['debug_log_request_bodies']}</div>
                    </div>
                    <Toggle
                      checked={form.debug_log_request_bodies}
                      onChange={(v) => setForm((f) => (f ? { ...f, debug_log_request_bodies: v } : f))}
                    />
                  </div>
                </div>
                {NUMERIC.map((n) => (
                  <Field key={n.key} label={n.label} hint={`Allowed: ${n.min}–${n.max}. ${n.hint}`}>
                    <input
                      className="zr-input"
                      inputMode="numeric"
                      value={form[n.key] as string}
                      onChange={(e) => setForm((f) => (f ? { ...f, [n.key]: e.target.value } : f))}
                    />
                  </Field>
                ))}
                {saveError && <ErrorNote error={saveError} />}
                {saveNotice && (
                  <div className="rounded-md border border-ok/40 bg-ok/10 px-3 py-2 text-[12.5px] text-ok">{saveNotice}</div>
                )}
                <button type="submit" className="zr-btn zr-btn-accent" disabled={saving}>
                  <Save size={13} /> {saving ? 'Saving…' : 'Save settings'}
                </button>
              </form>
            </Panel>

            <div className="space-y-4">
              <Panel title="Dashboard password">
                <div className="flex items-center gap-2">
                  <Badge tone={loaded.dashboard_password.startsWith('not configured') ? 'warn' : 'ok'}>
                    {loaded.dashboard_password.startsWith('not configured') ? 'loopback-only' : 'configured'}
                  </Badge>
                  <span className="text-[12.5px] text-ink-dim">
                    {loaded.dashboard_password.startsWith('not configured')
                      ? 'Anyone on this machine can open the console. Set ZEROROUTER_DASHBOARD_PASSWORD to require a session login.'
                      : 'Password comes from the ZEROROUTER_DASHBOARD_PASSWORD environment variable; sessions are cookie-based with a 12-hour TTL.'}
                  </span>
                </div>
                <div className="pt-2 text-[11.5px] text-ink-faint">
                  Settings live in <span className="font-mono">gateway.db</span> — they survive restarts; the dashboard
                  password is env-only by design and never stored in the database.
                </div>
              </Panel>
              <Panel title="Rate limits">
                <ul className="space-y-1.5 text-[12.5px] text-ink-dim">
                  <li>• Applied per gateway key, enforced before any upstream call.</li>
                  <li>• Rejections log <span className="font-mono">429 rate_limited</span> with <span className="font-mono">Retry-After</span>.</li>
                  <li>• Updated limits take effect immediately for new requests.</li>
                </ul>
              </Panel>
              <Panel title="Log privacy">
                <ul className="space-y-1.5 text-[12.5px] text-ink-dim">
                  <li>• Bodies are stored verbatim in plaintext: they contain prompts and other request content.</li>
                  <li>• Provider credentials are always encrypted (AES-256-GCM) — unrelated to this toggle.</li>
                  <li>• Clear all entries from the Request logs page.</li>
                </ul>
              </Panel>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
