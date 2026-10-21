/**
 * Alias management: stable gateway-facing model names that map to a concrete
 * provider/model target with optional baked-in sampling params and fallbacks.
 */
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { Plus, Shuffle, Trash2, Pencil, ArrowRight } from 'lucide-react';
import { api, fmtDateTime, type AliasRecord, type ProviderApi } from '../api';
import { Badge, EmptyState, ErrorNote, Field, JsonBlock, Loading, Modal, Panel, Toggle } from '../ui';

interface AliasForm {
  alias: string;
  providerId: string;
  model: string;
  enabled: boolean;
  notes: string;
  temperature: string;
  top_p: string;
  max_tokens: string;
  stop: string;
  fallbacks: { providerId: string; model: string }[];
}

const EMPTY_FORM: AliasForm = {
  alias: '',
  providerId: '',
  model: '',
  enabled: true,
  notes: '',
  temperature: '',
  top_p: '',
  max_tokens: '',
  stop: '',
  fallbacks: [],
};

function buildParams(form: AliasForm): Record<string, unknown> | null {
  const p: Record<string, unknown> = {};
  if (form.temperature.trim()) {
    const n = Number(form.temperature);
    if (Number.isFinite(n) && n >= 0 && n <= 2) p['temperature'] = n;
  }
  if (form.top_p.trim()) {
    const n = Number(form.top_p);
    if (Number.isFinite(n) && n >= 0 && n <= 1) p['top_p'] = n;
  }
  if (form.max_tokens.trim()) {
    const n = Number(form.max_tokens);
    if (Number.isInteger(n) && n >= 1) p['max_tokens'] = n;
  }
  const stopRaw = form.stop.trim();
  if (stopRaw) {
    const parts = stopRaw.split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length === 1 && parts[0]) p['stop'] = parts[0];
    else if (parts.length > 1) p['stop'] = parts.slice(0, 4);
  }
  return Object.keys(p).length > 0 ? p : null;
}

const ALIAS_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,63}$/;

export function AliasesPage() {
  const [aliases, setAliases] = useState<AliasRecord[] | null>(null);
  const [providers, setProviders] = useState<ProviderApi[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [showForm, setShowForm] = useState(false);
  const [editTarget, setEditTarget] = useState<AliasRecord | null>(null);
  const [form, setForm] = useState<AliasForm>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AliasRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [modelChoices, setModelChoices] = useState<Record<string, string[]>>({});

  const load = useCallback(() => {
    setError(null);
    Promise.all([api.aliases(), api.providers()])
      .then(([a, p]) => {
        setAliases(a.aliases);
        setProviders(p.providers);
      })
      .catch((e: unknown) => setError(e));
  }, []);
  useEffect(load, [load]);

  /** Lazily register models for a chosen provider so the datalist fills in. */
  const ensureModelChoices = useCallback((providerId: string) => {
    if (!providerId || modelChoices[providerId] !== undefined) return;
    api
      .providerModels(providerId)
      .then((r) => setModelChoices((prev) => ({ ...prev, [providerId]: r.models.map((m) => m.upstream_id) })))
      .catch(() => setModelChoices((prev) => ({ ...prev, [providerId]: [] })));
  }, [modelChoices]);

  useEffect(() => {
    if (showForm && form.providerId) ensureModelChoices(form.providerId);
  }, [showForm, form.providerId, ensureModelChoices]);

  const openCreate = () => {
    setForm({ ...EMPTY_FORM, providerId: providers[0]?.id ?? '' });
    setEditTarget(null);
    setFormError(null);
    setShowForm(true);
  };

  const openEdit = (a: AliasRecord) => {
    const params = a.params ?? {};
    const stop = params['stop'];
    setForm({
      alias: a.alias,
      providerId: a.provider_id,
      model: a.model,
      enabled: a.enabled,
      notes: a.notes ?? '',
      temperature: typeof params['temperature'] === 'number' ? String(params['temperature']) : '',
      top_p: typeof params['top_p'] === 'number' ? String(params['top_p']) : '',
      max_tokens: typeof params['max_tokens'] === 'number' ? String(params['max_tokens']) : '',
      stop: Array.isArray(stop) ? stop.join(', ') : typeof stop === 'string' ? stop : '',
      fallbacks: (a.fallbacks ?? []).map((f) => ({ providerId: f.provider_id, model: f.model })),
    });
    setEditTarget(a);
    setFormError(null);
    setShowForm(true);
  };

  const submitForm = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    if (!ALIAS_RE.test(form.alias.trim())) {
      setFormError('Alias must match ^[a-zA-Z0-9][a-zA-Z0-9._-]{1,63}$ (no “/”).');
      return;
    }
    const fb = form.fallbacks.filter((f) => f.providerId.trim() && f.model.trim());
    const body: Record<string, unknown> = {
      provider_id: form.providerId.trim(),
      model: form.model.trim(),
      enabled: form.enabled,
      fallbacks: fb.length > 0 ? fb.map((f) => ({ provider_id: f.providerId.trim(), model: f.model.trim() })) : null,
    };
    const params = buildParams(form);
    if (params) body['params'] = params;
    if (form.notes.trim()) body['notes'] = form.notes.trim();
    setBusy(true);
    try {
      await api.upsertAlias(form.alias.trim(), body);
      setShowForm(false);
      load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const doDelete = async (a: AliasRecord) => {
    setBusy(true);
    try {
      await api.deleteAlias(a.alias);
      setDeleteTarget(null);
      load();
    } catch (err) {
      setDeleteTarget(null);
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <Panel
        title={
          <span className="flex items-center gap-2">
            <Shuffle size={15} className="text-amber" /> Aliases
          </span>
        }
        actions={
          <button type="button" className="zr-btn zr-btn-accent" onClick={openCreate} disabled={providers.length === 0}>
            <Plus size={14} /> New alias
          </button>
        }
        dense
      >
        {error !== null && <div className="p-4"><ErrorNote error={error} onRetry={load} /></div>}
        {error === null && aliases === null && <Loading label="Loading aliases" />}
        {error === null && aliases !== null && aliases.length === 0 && (
          <EmptyState>
            No aliases. Clients always call <span className="font-mono text-ink-dim">provider/model</span> — register
            an alias to shorten that to a stable name.
          </EmptyState>
        )}
        {error === null && aliases !== null && aliases.length > 0 && (
          <table className="zr-table">
            <thead>
              <tr>
                <th>Alias</th>
                <th>Target</th>
                <th>Status</th>
                <th>Params</th>
                <th>Fallbacks</th>
                <th>Notes</th>
                <th>Updated</th>
                <th className="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {aliases.map((a) => (
                <tr key={a.alias}>
                  <td className="font-mono text-cyan">{a.alias}</td>
                  <td>
                    <div className="flex items-center gap-1.5 font-mono text-[12.5px]">
                      <span className="text-ink-dim">{a.provider_id}</span>
                      <ArrowRight size={11} className="text-ink-faint" />
                      <span>{a.model}</span>
                    </div>
                  </td>
                  <td><Badge tone={a.enabled ? 'ok' : 'neutral'}>{a.enabled ? 'enabled' : 'paused'}</Badge></td>
                  <td>
                    {a.params && Object.keys(a.params).length > 0 ? (
                      <span className="font-mono text-[11.5px] text-amber">
                        {Object.entries(a.params).map(([k, v]) => `${k}=${String(v)}`).join(' ')}
                      </span>
                    ) : (
                      <span className="text-ink-faint">—</span>
                    )}
                  </td>
                  <td>
                    {a.fallbacks && a.fallbacks.length > 0 ? (
                      <div className="space-y-0.5 font-mono text-[11.5px] text-ink-dim">
                        {a.fallbacks.map((f, i) => (
                          <div key={`${f.provider_id}:${f.model}:${i}`} className="break-all">
                            {i + 1}. {f.provider_id}/{f.model}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <span className="text-ink-faint">—</span>
                    )}
                  </td>
                  <td className="max-w-[220px] text-[12.5px] text-ink-dim">{a.notes ?? <span className="text-ink-faint">—</span>}</td>
                  <td className="zr-num text-[12px] text-ink-dim">{fmtDateTime(a.updated_at)}</td>
                  <td className="text-right">
                    <div className="flex justify-end gap-1.5">
                      <button type="button" className="zr-btn" onClick={() => openEdit(a)} title="Edit">
                        <Pencil size={13} />
                      </button>
                      <button
                        type="button"
                        className="zr-btn zr-btn-danger"
                        onClick={() => setDeleteTarget(a)}
                        title="Delete"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel title="Routing semantics">
        <ul className="space-y-1.5 text-[13px] text-ink-dim">
          <li>• A request for <span className="font-mono text-cyan">model = alias</span> resolves to the target before any upstream call; the response carries the concrete <span className="font-mono text-ink">provider/model</span> in <span className="font-mono text-ink">provider_meta</span>.</li>
          <li>• Params are merged under the caller's own values — the request always wins.</li>
          <li>• Fallbacks apply in order: target first, then fallback 1, 2… (blocking requests only).</li>
          <li>• Aliases referencing a disabled provider are rejected by the gateway with a clear 404/409.</li>
        </ul>
      </Panel>

      <Modal
        open={showForm}
        onClose={() => setShowForm(false)}
        title={editTarget ? `Edit alias ${editTarget.alias}` : 'New alias'}
      >
        <form onSubmit={submitForm} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Alias name" hint="2–64 chars: letters, digits, . _ -">
              <input
                className="zr-input font-mono"
                value={form.alias}
                onChange={(e) => setForm((f) => ({ ...f, alias: e.target.value }))}
                placeholder="fast-test"
                autoFocus={!editTarget}
                readOnly={Boolean(editTarget)}
                disabled={Boolean(editTarget)}
              />
            </Field>
            <Field label="Enabled">
              <div className="zr-input flex items-center" style={{ height: 'fit-content', padding: '8px 10px' }}>
                <Toggle checked={form.enabled} onChange={(v) => setForm((f) => ({ ...f, enabled: v }))} label={form.enabled ? 'live' : 'paused'} />
              </div>
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Provider">
              <select
                className="zr-select"
                value={form.providerId}
                onChange={(e) => setForm((f) => ({ ...f, providerId: e.target.value }))}
              >
                <option value="">— select —</option>
                {providers.map((p) => (
                  <option key={p.id} value={p.id} disabled={!p.enabled}>
                    {p.id}{p.enabled ? '' : ' (disabled)'}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Model" hint="Exactly the upstream model id registered on the provider.">
              <input
                className="zr-input font-mono"
                value={form.model}
                onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
                placeholder="mock-small-1"
                list={`models-${form.providerId}`}
              />
              <datalist id={`models-${form.providerId}`}>
                {(modelChoices[form.providerId] ?? []).map((id) => (
                  <option key={id} value={id} />
                ))}
              </datalist>
            </Field>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Temperature">
              <input className="zr-input" inputMode="decimal" value={form.temperature} onChange={(e) => setForm((f) => ({ ...f, temperature: e.target.value }))} placeholder="0.7" />
            </Field>
            <Field label="Top-p">
              <input className="zr-input" inputMode="decimal" value={form.top_p} onChange={(e) => setForm((f) => ({ ...f, top_p: e.target.value }))} placeholder="1" />
            </Field>
            <Field label="Max tokens">
              <input className="zr-input" inputMode="numeric" value={form.max_tokens} onChange={(e) => setForm((f) => ({ ...f, max_tokens: e.target.value }))} placeholder="1024" />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Stop sequences" hint="Comma-separated, up to 4.">
              <input className="zr-input" value={form.stop} onChange={(e) => setForm((f) => ({ ...f, stop: e.target.value }))} placeholder="END, <stop>" />
            </Field>
            <Field label="Notes" hint="Displayed in the table.">
              <input className="zr-input" value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} maxLength={500} />
            </Field>
          </div>

          <div className="rounded-md border border-hairline bg-panel-raised p-3">
            <div className="flex items-center justify-between">
              <span className="zr-label">Fallbacks ({form.fallbacks.length}/4)</span>
              <button
                type="button"
                className="zr-btn"
                onClick={() => setForm((f) => ({ ...f, fallbacks: [...f.fallbacks, { providerId: '', model: '' }] }))}
                disabled={form.fallbacks.length >= 4}
              >
                <Plus size={13} /> Add fallback
              </button>
            </div>
            {form.fallbacks.length > 0 && (
              <div className="mt-2 space-y-2">
                {form.fallbacks.map((fb, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <input
                      className="zr-input font-mono text-[12px]"
                      value={fb.providerId}
                      placeholder="provider-id"
                      onChange={(e) => {
                        const v = e.target.value;
                        setForm((f) => ({ ...f, fallbacks: f.fallbacks.map((x, j) => (j === i ? { ...x, providerId: v } : x)) }));
                      }}
                    />
                    <input
                      className="zr-input font-mono text-[12px]"
                      value={fb.model}
                      placeholder="model"
                      onChange={(e) => {
                        const v = e.target.value;
                        setForm((f) => ({ ...f, fallbacks: f.fallbacks.map((x, j) => (j === i ? { ...x, model: v } : x)) }));
                      }}
                    />
                    <button
                      type="button"
                      className="zr-btn zr-btn-danger shrink-0"
                      onClick={() => setForm((f) => ({ ...f, fallbacks: f.fallbacks.filter((_, j) => j !== i) }))}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {formError && <ErrorNote error={formError} />}
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" className="zr-btn" onClick={() => setShowForm(false)}>Cancel</button>
            <button type="submit" className="zr-btn zr-btn-accent" disabled={busy || !form.providerId || !form.model.trim()}>
              {editTarget ? 'Save alias' : 'Create alias'}
            </button>
          </div>
        </form>
      </Modal>

      <Modal
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title="Delete alias?"
      >
        {deleteTarget && (
          <div className="space-y-3">
            <p className="text-[13px] text-ink-dim">
              Clients sending <span className="font-mono text-cyan">{deleteTarget.alias}</span> will receive a
              <span className="font-mono text-ink"> 404 model_not_found</span> immediately.
            </p>
            {deleteTarget.fallbacks && deleteTarget.fallbacks.length > 0 && (
              <JsonBlock value={deleteTarget.fallbacks} max={300} />
            )}
            <div className="flex justify-end gap-2">
              <button type="button" className="zr-btn" onClick={() => setDeleteTarget(null)}>Cancel</button>
              <button type="button" className="zr-btn zr-btn-danger" onClick={() => doDelete(deleteTarget)} disabled={busy}>
                Delete alias
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
