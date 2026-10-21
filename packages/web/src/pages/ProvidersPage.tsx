import { type FormEvent, useCallback, useEffect, useState } from 'react';
import {
  CircleAlert,
  Plus,
  Radar,
  Trash2,
  Pencil,
} from 'lucide-react';
import {
  api,
  fmtDateTime,
  type AdapterSummary,
  type ProviderApi,
  type ProviderEvent,
  type ProviderModel,
  type SessionInfo,
} from '../api';
import { Badge, EmptyState, ErrorNote, Field, JsonBlock, Loading, Modal, Panel, Spinner, Toggle } from '../ui';

const AUTH_TYPES = ['bearer', 'x_api_key', 'custom_header', 'none'] as const;

interface ProviderCreateState {
  id: string;
  name: string;
  adapter: string;
  base_url: string;
  auth_type: string;
  auth_header: string;
  api_key: string;
  timeout_ms: string;
  retry_max: string;
  models_path: string;
  chat_path: string;
  lanOptIn: boolean;
}

const EMPTY_FORM: ProviderCreateState = {
  id: '',
  name: '',
  adapter: 'openai-compatible',
  base_url: '',
  auth_type: 'bearer',
  auth_header: '',
  api_key: '',
  timeout_ms: '120000',
  retry_max: '1',
  models_path: '',
  chat_path: '',
  lanOptIn: false,
};

export function ProvidersPage({ session }: { session: SessionInfo | null }) {
  void session;
  return <ProvidersInner />;
}

function ProvidersInner() {
  const [providers, setProviders] = useState<ProviderApi[] | null>(null);
  const [adapters, setAdapters] = useState<AdapterSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [showForm, setShowForm] = useState(false);
  const [editTarget, setEditTarget] = useState<ProviderApi | null>(null);
  const [form, setForm] = useState<ProviderCreateState>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    api
      .providers()
      .then(({ providers: p, adapters: a }) => {
        setProviders(p);
        setAdapters(a);
      })
      .catch((e: unknown) => setError(e));
  }, []);
  useEffect(load, [load]);

  const set = (k: keyof ProviderCreateState) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const openCreate = () => {
    setForm(EMPTY_FORM);
    setEditTarget(null);
    setFormError(null);
    setShowForm(true);
  };

  const openEdit = (p: ProviderApi) => {
    const cfg = p.config ?? {};
    setForm({
      id: p.id,
      name: p.name,
      adapter: p.adapter,
      base_url: p.base_url ?? '',
      auth_type: p.auth_type,
      auth_header: p.auth_header ?? '',
      api_key: '', // credentials are write-only
      timeout_ms: String(p.timeout_ms),
      retry_max: String(p.retry_max),
      models_path: typeof cfg['models_path'] === 'string' ? cfg['models_path'] : '',
      chat_path: typeof cfg['chat_path'] === 'string' ? cfg['chat_path'] : '',
      lanOptIn: cfg['allow_insecure_http'] === true || cfg['allow_insecure_http'] === 'true',
    });
    setEditTarget(p);
    setFormError(null);
    setShowForm(true);
  };

  const submitForm = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const config: Record<string, unknown> = {};
    if (form.models_path.trim()) config['models_path'] = form.models_path.trim();
    if (form.chat_path.trim()) config['chat_path'] = form.chat_path.trim();
    if (form.lanOptIn) config['allow_insecure_http'] = true;
    const payload: Record<string, unknown> = {
      name: form.name.trim(),
      adapter: form.adapter,
      base_url: form.base_url.trim() || undefined,
      auth_type: form.auth_type,
      timeout_ms: Number.parseInt(form.timeout_ms, 10) || undefined,
      retry_max: Number.parseInt(form.retry_max, 10) || undefined,
    };
    if (form.auth_type === 'custom_header') {
      payload['auth_header'] = form.auth_header.trim() || undefined;
    }
    if (form.api_key.trim()) payload['api_key'] = form.api_key.trim();
    if (Object.keys(config).length > 0) payload['config'] = config;
    try {
      if (editTarget) {
        await api.updateProvider(editTarget.id, payload);
        setShowForm(false);
        load();
        setSelected(editTarget.id);
      } else {
        const { provider } = await api.createProvider({
          ...payload,
          ...(form.id.trim() ? { id: form.id.trim() } : {}),
        });
        setShowForm(false);
        load();
        setSelected(provider.id);
      }
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    }
  };

  const runAction = async (id: string, action: 'test' | 'discover' | 'toggle') => {
    setBusyId(`${action}:${id}`);
    setError(null);
    try {
      if (action === 'test') {
        const r = await api.testProvider(id);
        setNotice(`${r.message} (${r.latency_ms ?? '—'} ms)`);
      } else if (action === 'discover') {
        const { discovery } = await api.discoverProvider(id);
        setNotice(
          discovery
            ? `Discovery: ${discovery.found} found, ${discovery.added} added, ${discovery.updated} updated${discovery.note ? ` — ${discovery.note}` : ''}`
            : 'Discovery finished.',
        );
      } else {
        const p = providers?.find((x) => x.id === id);
        await api.updateProvider(id, { enabled: !(p?.enabled ?? true) });
      }
      load();
    } catch (err) {
      setError(err);
    } finally {
      setBusyId(null);
    }
  };

  const deleteProvider = async (p: ProviderApi) => {
    setNotice(null);
    if (!window.confirm(`Delete provider "${p.name}"? Config and registered models are removed.`)) return;
    setError(null);
    try {
      await api.deleteProvider(p.id, false);
      if (selected === p.id) setSelected(null);
      load();
    } catch (err) {
      // Blocked by alias references → ask about forced deletion
      if (err instanceof Error && (err as { status?: number }).status === 409) {
        const force = window.confirm(
          `${err.message}\n\nForce deletion? Aliases pointing at this provider will become unroutable (404) until they are re-pointed.`,
        );
        if (force) {
          try {
            await api.deleteProvider(p.id, true);
            if (selected === p.id) setSelected(null);
            load();
          } catch (err2) {
            setError(err2);
          }
        }
      } else {
        setError(err);
      }
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          {notice && <span className="text-[12.5px] text-cyan">{notice}</span>}
          {error !== null && !notice && <ErrorNote error={error} onRetry={load} />}
        </div>
        <button type="button" className="zr-btn zr-btn-accent" onClick={openCreate}>
          <Plus size={14} /> Add provider
        </button>
      </div>

      <div className="flex gap-5 max-lg:flex-col">
        <div className="min-w-0 flex-1 space-y-3">
          {providers === null ? (
            <Loading label="Loading providers" />
          ) : providers.length === 0 ? (
            <Panel>
              <EmptyState>
                No providers yet. Add an upstream (OpenAI-compatible, OpenRouter, Anthropic or generic REST) to start routing.
              </EmptyState>
            </Panel>
          ) : (
            providers.map((p) => (
              <ProviderCard
                key={p.id}
                provider={p}
                busy={busyId !== null}
                busyId={busyId}
                onSelect={() => setSelected(selected === p.id ? null : p.id)}
                selected={selected === p.id}
                onTest={() => runAction(p.id, 'test')}
                onDiscover={() => runAction(p.id, 'discover')}
                onToggle={() => runAction(p.id, 'toggle')}
                onEdit={() => openEdit(p)}
                onDelete={() => deleteProvider(p)}
              />
            ))
          )}
        </div>
        <aside className="w-full shrink-0 lg:w-[380px]">
          {selected && <ProviderDetail providerId={selected} adapters={adapters} onDeleted={() => { setSelected(null); load(); }} />}
        </aside>
      </div>

      <Modal open={showForm} onClose={() => setShowForm(false)} title={editTarget ? `Edit provider — ${editTarget.name}` : 'Add provider'} width="max-w-2xl">
        <form onSubmit={submitForm} className="space-y-4">
          {formError && <ErrorNote error={formError} />}
          <div className="grid grid-cols-2 gap-3">
            {!editTarget && (
              <Field label="provider id" hint="a-z, 0-9, - and _ — optional, derived from the name">
                <input className="zr-input" value={form.id} onChange={set('id')} placeholder="my-openai" autoComplete="off" />
              </Field>
            )}
            <Field label="display name" className={!editTarget ? '' : 'col-span-2'}>
              <input className="zr-input" value={form.name} onChange={set('name')} required maxLength={120} placeholder="My OpenAI" />
            </Field>
            <Field label="adapter" hint={adapters.find((a) => a.id === form.adapter)?.description}>
              <select className="zr-select" value={form.adapter} onChange={set('adapter')}>
                {adapters.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="base url" hint="https://… — http:// allowed for loopback servers">
              <input className="zr-input" value={form.base_url} onChange={set('base_url')} placeholder="https://api.openai.com" />
            </Field>
            <Field label="auth type">
              <select className="zr-select" value={form.auth_type} onChange={set('auth_type')}>
                {AUTH_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="auth header name" hint={form.auth_type === 'custom_header' ? 'required for custom_header auth' : 'only used with custom_header'}>
              <input className="zr-input" value={form.auth_header} onChange={set('auth_header')} placeholder="X-API-Key" disabled={form.auth_type !== 'custom_header'} />
            </Field>
          </div>
          <Field
            label="api credential"
            hint={editTarget ? 'leave empty to keep the stored credential — write-only, never returned by the API' : 'stored encrypted (AES-256-GCM); never displayed again'}
          >
            <input className="zr-input" type="password" value={form.api_key} onChange={set('api_key')} placeholder={editTarget ? 'unchanged' : 'sk-…'} autoComplete="new-password" />
          </Field>
          <div className="grid grid-cols-3 gap-3">
            <Field label="timeout (ms)">
              <input className="zr-input zr-num" type="number" value={form.timeout_ms} onChange={set('timeout_ms')} min={1000} max={600000} />
            </Field>
            <Field label="retries">
              <input className="zr-input zr-num" type="number" value={form.retry_max} onChange={set('retry_max')} min={0} max={3} />
            </Field>
            <Field label="lan opt-in" hint="allow insecure http/https to private LAN addresses (not metadata)">
              <div className="pt-1.5">
                <Toggle checked={form.lanOptIn} onChange={(v) => setForm((f) => ({ ...f, lanOptIn: v }))} label="allow_insecure_http" />
              </div>
            </Field>
          </div>
          {form.adapter === 'openai-compatible' && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="models path override" hint="default /v1/models">
                <input className="zr-input" value={form.models_path} onChange={set('models_path')} placeholder="/v1/models" />
              </Field>
              <Field label="chat path override" hint="default /v1/chat/completions">
                <input className="zr-input" value={form.chat_path} onChange={set('chat_path')} placeholder="/v1/chat/completions" />
              </Field>
            </div>
          )}
          <div className="flex justify-end gap-2 border-t border-hairline pt-4">
            <button type="button" className="zr-btn" onClick={() => setShowForm(false)}>
              Cancel
            </button>
            <button type="submit" className="zr-btn zr-btn-accent">
              {editTarget ? 'Save changes' : 'Create provider'}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

function ProviderCard({
  provider: p,
  selected,
  onSelect,
  onTest,
  onDiscover,
  onToggle,
  onEdit,
  onDelete,
  busy,
  busyId,
}: {
  provider: ProviderApi;
  selected: boolean;
  onSelect(): void;
  onTest(): void;
  onDiscover(): void;
  onToggle(): void;
  onEdit(): void;
  onDelete(): void;
  busy: boolean;
  busyId: string | null;
}) {
  const doing = (name: string) => busyId === `${name}:${p.id}`;
  return (
    <div
      className={`cursor-pointer rounded-[10px] border bg-panel transition-colors ${
        selected ? 'border-cyan/50' : 'border-hairline hover:border-hairline-strong'
      }`}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && onSelect()}
    >
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate font-display text-[14.5px] font-semibold">{p.name}</span>
            {p.enabled ? <Badge tone="ok">enabled</Badge> : <Badge tone="neutral">disabled</Badge>}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[11px] text-ink-faint">
            <span>{p.id}</span>
            <span className="text-amber/80">{p.adapter}</span>
            <span className="truncate">{p.base_url ?? 'no base url'}</span>
            <span>{p.model_count} models</span>
            {p.has_credentials ? <span className="text-ok">credentials stored</span> : <span className="text-danger">no credential</span>}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
          <Badge tone={p.test_status === 'ok' ? 'ok' : p.test_status === 'failed' ? 'danger' : 'neutral'}>{p.test_status}</Badge>
          <Badge tone={p.discovery_status === 'completed' ? 'cyan' : p.discovery_status === 'failed' ? 'danger' : 'neutral'}>
            {p.discovery_status.replace(/_/g, ' ')}
          </Badge>
          <button type="button" className="zr-btn" disabled={busy} onClick={onTest} title="Test connection">
            {doing('test') ? <Spinner /> : <CircleAlert size={13} />} Test
          </button>
          <button type="button" className="zr-btn zr-btn-cyan" disabled={busy} onClick={onDiscover} title="Discover models">
            {doing('discover') ? <Spinner /> : <Radar size={13} />} Discover
          </button>
          <button type="button" className="zr-btn" disabled={busy} onClick={onToggle} title={p.enabled ? 'Disable' : 'Enable'}>
            {doing('toggle') ? <Spinner /> : <Pencil size={13} />} {p.enabled ? 'Disable' : 'Enable'}
          </button>
          <button type="button" className="zr-btn" disabled={busy} onClick={onEdit}>
            <Pencil size={13} /> Edit
          </button>
          <button type="button" className="zr-btn zr-btn-danger" disabled={busy} onClick={onDelete}>
            <Trash2 size={13} />
          </button>
        </div>
      </div>
      {(p.test_message || p.last_discovery) && (
        <div className="border-t border-hairline px-4 py-2 font-mono text-[11px] text-ink-faint">
          {p.test_message ? <div>test · {p.test_message}</div> : null}
          {p.last_discovery ? (
            <div>
              discovery · {fmtDateTime(p.last_discovery.ts)} — {p.last_discovery.found} found, {p.last_discovery.added} added,{' '}
              {p.last_discovery.updated} updated{p.last_discovery.note ? ` — ${p.last_discovery.note}` : ''}
              {p.last_discovery.error ? ` — ${p.last_discovery.error}` : ''}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function ProviderDetail({ providerId, adapters, onDeleted }: { providerId: string; adapters: AdapterSummary[]; onDeleted(): void }) {
  const [data, setData] = useState<{
    provider: ProviderApi;
    adapter_capabilities: AdapterSummary['capabilities'] | null;
    events: ProviderEvent[];
    resolved_url_policy: { allowInsecureHttp?: boolean; allowInsecurePrivateHttp?: boolean };
  } | null>(null);
  const [models, setModels] = useState<ProviderModel[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [newModelName, setNewModelName] = useState('');
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);

  const load = useCallback(() => {
    setError(null);
    Promise.all([api.provider(providerId), api.providerModels(providerId)])
      .then(([d, m]) => {
        setData(d);
        setModels(m.models);
      })
      .catch((e: unknown) => setError(e));
  }, [providerId]);
  useEffect(load, [load]);

  void adapters;
  if (error) {
    return <Panel title={<span className="zr-label">provider · {providerId}</span>}><ErrorNote error={error} onRetry={load} /></Panel>;
  }
  if (!data) return <Loading label="Loading provider" />;
  const p = data.provider;

  const addModel = async () => {
    const id = newModelName.trim();
    if (!id) return;
    try {
      await api.addManualModel(providerId, { upstream_id: id });
      setNewModelName('');
      load();
    } catch (e) {
      setError(e);
    }
  };
  const removeModel = async (m: ProviderModel) => {
    if (!window.confirm(`Remove model "${m.upstream_id}" from ${p.id}? Aliases pointing at it will break.`)) return;
    try {
      await api.deleteModel(providerId, m.upstream_id);
      load();
    } catch (e) {
      setError(e);
    }
  };
  const renameModel = async () => {
    if (!renaming) return;
    try {
      await api.renameModel(providerId, renaming.id, renaming.value.trim());
      setRenaming(null);
      load();
    } catch (e) {
      setError(e);
    }
  };

  return (
    <div className="space-y-3">
      <Panel title={<span className="zr-label">provider · {p.id}</span>} dense>
        <div className="grid grid-cols-2 gap-x-4 gap-y-2 p-4 text-[12.5px]">
          <FieldRow k="auth type" v={p.auth_type} />
          <FieldRow k="credential" v={p.has_credentials ? 'stored (encrypted)' : 'none'} />
          <FieldRow k="timeout" v={`${p.timeout_ms} ms`} />
          <FieldRow k="retries" v={String(p.retry_max)} />
          <FieldRow
            k="url policy"
            v={`http loopback${data.resolved_url_policy.allowInsecurePrivateHttp ? ' + LAN opt-in' : ' only'}`}
          />
          <FieldRow k="streaming" v={data.adapter_capabilities?.streaming ? 'supported' : 'unsupported'} />
        </div>
        {Object.keys(p.config ?? {}).length > 0 && (
          <div className="px-4 pb-4">
            <JsonBlock value={p.config} />
          </div>
        )}
      </Panel>

      <Panel
        title={<span className="zr-label">registered models · {models?.length ?? '…'}</span>}
        actions={
          <div className="flex items-center gap-1.5">
            <input
              className="zr-input h-8 w-44 py-1"
              placeholder="add upstream model id"
              value={newModelName}
              onChange={(e) => setNewModelName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addModel()}
            />
            <button type="button" className="zr-btn" onClick={addModel} disabled={!newModelName.trim()}>
              <Plus size={13} />
            </button>
          </div>
        }
        dense
      >
        {models === null ? (
          <Loading />
        ) : models.length === 0 ? (
          <EmptyState>No models registered. Run discovery or add manually.</EmptyState>
        ) : (
          <table className="zr-table">
            <thead>
              <tr>
                <th>model id</th>
                <th>display name</th>
                <th>stream</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {models.map((m) => (
                <tr key={m.upstream_id}>
                  <td className="font-mono text-[12px]">
                    {p.id}/{m.upstream_id}
                  </td>
                  <td className="text-[12.5px]">
                    {renaming?.id === m.upstream_id ? (
                      <span className="flex items-center gap-1.5">
                        <input className="zr-input h-7 py-0.5" defaultValue={m.display_name} onChange={(e) => setRenaming({ id: m.upstream_id, value: e.target.value })} />
                        <button type="button" className="zr-btn h-7 py-0.5" onClick={renameModel}>✓</button>
                        <button type="button" className="zr-btn h-7 py-0.5" onClick={() => setRenaming(null)}>×</button>
                      </span>
                    ) : (
                      <button type="button" className="hover:text-cyan" onClick={() => setRenaming({ id: m.upstream_id, value: m.display_name })} title="Click to rename">
                        {m.display_name}
                      </button>
                    )}
                  </td>
                  <td>{m.streaming === true ? <Badge tone="cyan">yes</Badge> : m.streaming === false ? 'no' : '—'}</td>
                  <td className="text-right">
                    <button type="button" className="zr-btn zr-btn-danger h-7 py-0.5" onClick={() => removeModel(m)} title="Remove model">
                      <Trash2 size={12} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel title={<span className="zr-label">provider events</span>} dense>
        {data.events.length === 0 ? (
          <EmptyState>No events yet.</EmptyState>
        ) : (
          <ul className="divide-y divide-hairline">
            {data.events.map((ev, i) => (
              <li key={ev.id ?? i} className="flex items-center justify-between gap-2 px-4 py-2 text-[12.5px]">
                <span className="font-mono text-[11px] text-ink-faint">{fmtDateTime(ev.ts)}</span>
                <Badge tone={eventTone(ev)}>{ev.kind.replace(/_/g, ' ')}</Badge>
                <span className="min-w-0 flex-1 truncate text-ink-dim" title={ev.message ?? undefined}>{ev.message}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <button type="button" className="zr-btn w-full justify-center" onClick={onDeleted}>
        Refresh details
      </button>
    </div>
  );
}

function eventTone(ev: ProviderEvent): 'ok' | 'warn' | 'danger' | 'neutral' {
  if (ev.status === 'failed' || ev.kind === 'auth_issue') return 'danger';
  if (ev.status === 'ok') return 'ok';
  return 'neutral';
}

function FieldRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 border-b border-hairline pb-1.5">
      <span className="zr-label">{k}</span>
      <span className="font-mono text-[11.5px] text-ink-dim">{v}</span>
    </div>
  );
}
