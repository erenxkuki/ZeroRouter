/**
 * Gateway key management.
 * Plaintext keys are shown exactly once inside the reveal modal and are never
 * persisted by the dashboard (no localStorage/sessionStorage/caching).
 */
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { Copy, Eye, KeyRound, Plus, ShieldAlert, Trash2, Ban } from 'lucide-react';
import { api, fmtDateTime, type GatewayKey } from '../api';
import { Badge, EmptyState, ErrorNote, Field, Loading, Modal, Panel } from '../ui';

interface CreateState {
  label: string;
  expiresInDays: string;
}

const EXPIRY_PRESETS: { label: string; days: number | null }[] = [
  { label: 'Never', days: null },
  { label: '7 days', days: 7 },
  { label: '30 days', days: 30 },
  { label: '90 days', days: 90 },
];

function keyStatus(k: GatewayKey): { tone: 'ok' | 'danger' | 'warn' | 'neutral'; text: string } {
  if (k.revoked_at) return { tone: 'danger', text: 'revoked' };
  if (k.expires_at !== null && k.expires_at <= Date.now()) return { tone: 'warn', text: 'expired' };
  return { tone: 'ok', text: 'active' };
}

export function KeysPage() {
  const [keys, setKeys] = useState<GatewayKey[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState<CreateState>({ label: '', expiresInDays: '30' });
  const [formError, setFormError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<{ key: GatewayKey; plaintext: string; note: string } | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<{ key: GatewayKey; action: 'revoke' | 'delete' } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    api
      .keys()
      .then((r) => setKeys(r.keys))
      .catch((e: unknown) => setError(e));
  }, []);
  useEffect(load, [load]);

  const submitCreate = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    let days: number | null = null;
    if (form.expiresInDays !== '' && form.expiresInDays !== 'never') {
      const n = Number(form.expiresInDays);
      if (!Number.isFinite(n) || n <= 0 || n > 3650) {
        setFormError('Expiry must be a positive number of days (≤ 3650) or empty/never.');
        return;
      }
      days = Math.round(n);
    }
    try {
      const res = await api.createKey(form.label.trim(), days);
      setRevealed({ key: res.key, plaintext: res.plaintext, note: res.note });
      setShowCreate(false);
      setForm({ label: '', expiresInDays: '30' });
      load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    }
  };

  const doAction = async (key: GatewayKey, action: 'revoke' | 'delete') => {
    setBusyId(`${key.id}:${action}`);
    setNotice(null);
    try {
      if (action === 'revoke') await api.revokeKey(key.id);
      else await api.deleteKey(key.id);
      setNotice(action === 'revoke' ? `Key "${key.label}" revoked.` : 'Key deleted.');
      setConfirmTarget(null);
      load();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
      setConfirmTarget(null);
    } finally {
      setBusyId(null);
    }
  };

  const copyPlaintext = async () => {
    if (!revealed) return;
    try {
      await navigator.clipboard.writeText(revealed.plaintext);
      setNotice('Copied to clipboard. The clipboard is not cleared automatically — use with care.');
    } catch {
      setNotice('Clipboard write failed — select the text and copy manually.');
    }
  };

  return (
    <div className="space-y-4">
      <Panel
        title={
          <span className="flex items-center gap-2">
            <KeyRound size={15} className="text-amber" /> Gateway keys
          </span>
        }
        actions={
          <button type="button" className="zr-btn zr-btn-accent" onClick={() => setShowCreate(true)}>
            <Plus size={14} /> New key
          </button>
        }
        dense
      >
        {error !== null && <div className="p-4"><ErrorNote error={error} onRetry={load} /></div>}
        {error === null && keys === null && <Loading label="Loading keys" />}
        {error === null && keys !== null && keys.length === 0 && (
          <EmptyState>
            No gateway keys yet. Create one to call <span className="font-mono text-ink-dim">/v1/chat/completions</span>.
          </EmptyState>
        )}
        {error === null && keys !== null && keys.length > 0 && (
          <table className="zr-table">
            <thead>
              <tr>
                <th>Label</th>
                <th>Key prefix</th>
                <th>Status</th>
                <th>Created</th>
                <th>Expires</th>
                <th>Last used</th>
                <th className="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => {
                const st = keyStatus(k);
                return (
                  <tr key={k.id}>
                    <td>
                      <div className="font-medium">{k.label}</div>
                      <div className="font-mono text-[10.5px] text-ink-faint">{k.id}</div>
                    </td>
                    <td className="zr-num text-ink-dim">{k.key_prefix}…</td>
                    <td><Badge tone={st.tone}>{st.text}</Badge></td>
                    <td className="zr-num text-ink-dim">{fmtDateTime(k.created_at)}</td>
                    <td className="zr-num text-ink-dim">{k.expires_at ? fmtDateTime(k.expires_at) : 'never'}</td>
                    <td className="zr-num text-ink-dim">{fmtDateTime(k.last_used_at)}</td>
                    <td className="text-right">
                      <div className="flex justify-end gap-1.5">
                        <button
                          type="button"
                          className="zr-btn"
                          onClick={() => setConfirmTarget({ key: k, action: 'revoke' })}
                          disabled={Boolean(k.revoked_at) || busyId !== null}
                          title="Revoke"
                        >
                          <Ban size={13} /> Revoke
                        </button>
                        <button
                          type="button"
                          className="zr-btn zr-btn-danger"
                          onClick={() => setConfirmTarget({ key: k, action: 'delete' })}
                          disabled={busyId !== null}
                          title="Delete key + audit trace"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Panel>

      {notice && <div className="font-mono text-[11.5px] text-ink-dim">{notice}</div>}

      <Panel title="Authentication contract">
        <ul className="space-y-1.5 text-[13px] text-ink-dim">
          <li>• Send <span className="font-mono text-cyan">Authorization: Bearer zr_…</span> on every gateway request.</li>
          <li>• Plaintext is rendered once at creation; the server stores only a scrypt hash plus its prefix.</li>
          <li>• Revoked and expired keys reject requests with <span className="font-mono text-ink">401 invalid_api_key</span>.</li>
          <li>• Rate limits (see Diagnostics → settings) apply per active key.</li>
        </ul>
      </Panel>

      <Modal open={showCreate} onClose={() => setShowCreate(false)} title="Create gateway key">
        <form onSubmit={submitCreate} className="space-y-3">
          <Field label="Label" hint="Shown in logs and audits — e.g. “workstation”, “ci-runner”.">
            <input
              className="zr-input"
              value={form.label}
              onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
              placeholder="workstation"
              autoFocus
              maxLength={64}
            />
          </Field>
          <Field label="Expiry (days)" hint="Empty or never = no expiry.">
            <div className="flex gap-2">
              {EXPIRY_PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  className={`zr-btn ${form.expiresInDays === (p.days === null ? 'never' : String(p.days)) ? 'zr-btn-cyan' : ''}`}
                  onClick={() => setForm((f) => ({ ...f, expiresInDays: p.days === null ? 'never' : String(p.days) }))}
                >
                  {p.label}
                </button>
              ))}
            </div>
            {form.expiresInDays !== 'never' && (
              <input
                className="zr-input mt-2"
                type="number"
                min={1}
                max={3650}
                value={form.expiresInDays}
                onChange={(e) => setForm((f) => ({ ...f, expiresInDays: e.target.value }))}
              />
            )}
          </Field>
          {formError && <ErrorNote error={formError} />}
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" className="zr-btn" onClick={() => setShowCreate(false)}>Cancel</button>
            <button type="submit" className="zr-btn zr-btn-accent" disabled={form.label.trim().length === 0}>
              Create key
            </button>
          </div>
        </form>
      </Modal>

      <Modal
        open={revealed !== null}
        onClose={() => setRevealed(null)}
        title={<span className="flex items-center gap-2"><Eye size={15} className="text-amber" /> Save this key now</span>}
      >
        {revealed && (
          <div className="space-y-3">
            <div className="flex items-start gap-2 rounded-md border border-amber/40 bg-amber/10 px-3 py-2 text-[12.5px] text-amber">
              <ShieldAlert size={15} className="mt-0.5 shrink-0" />
              <span>
                This is the only time the full key is shown. ZeroRouter stores only a scrypt hash; closing this
                dialog discards the plaintext permanently.
              </span>
            </div>
            <div className="rounded-md border border-hairline bg-canvas px-3 py-2.5 font-mono text-[13px] break-all text-cyan">
              {revealed.plaintext}
            </div>
            <div className="text-[12px] text-ink-faint">{revealed.note}</div>
            <div className="flex justify-end gap-2">
              <button type="button" className="zr-btn" onClick={copyPlaintext}>
                <Copy size={13} /> Copy
              </button>
              <button type="button" className="zr-btn zr-btn-accent" onClick={() => setRevealed(null)}>
                Done — I saved it
              </button>
            </div>
          </div>
        )}
      </Modal>

      <Modal
        open={confirmTarget !== null}
        onClose={() => setConfirmTarget(null)}
        title={confirmTarget?.action === 'revoke' ? 'Revoke key?' : 'Delete key?'}
      >
        {confirmTarget && (
          <div className="space-y-3">
            <p className="text-[13px] text-ink-dim">
              {confirmTarget.action === 'revoke' ? (
                <>
                  Key <span className="text-ink">“{confirmTarget.key.label}”</span> will stop accepting gateway
                  requests immediately. The row stays visible for audit purposes.
                </>
              ) : (
                <>
                  Key <span className="text-ink">“{confirmTarget.key.label}”</span> and its audit record will be
                  removed permanently. Revoke first if you only want to disable it.
                </>
              )}
            </p>
            <div className="flex justify-end gap-2">
              <button type="button" className="zr-btn" onClick={() => setConfirmTarget(null)}>Cancel</button>
              <button
                type="button"
                className={`zr-btn ${confirmTarget.action === 'revoke' ? 'zr-btn-danger' : 'zr-btn-danger'}`}
                onClick={() => doAction(confirmTarget.key, confirmTarget.action)}
                disabled={busyId !== null}
              >
                {confirmTarget.action === 'revoke' ? 'Revoke key' : 'Delete permanently'}
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
