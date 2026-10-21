/**
 * Model catalog across all providers: search, filter, sort, paginate.
 * Mostly read-only; display-name rename and manual registration live on the
 * provider detail view. Model ids route gateway requests as "provider/model".
 */
import { useCallback, useEffect, useState } from 'react';
import { BrainCircuit, Check, ChevronLeft, ChevronRight, Copy, RefreshCw, Search } from 'lucide-react';
import { api, type AliasRecord, type ProviderModel, type ProviderApi } from '../api';
import { getRuntimeOrigin } from '../lib/origin';
import { Badge, EmptyState, ErrorNote, Loading, Panel, StatusDot } from '../ui';

const SORTS: { id: string; label: string }[] = [
  { id: 'newest', label: 'newest' },
  { id: 'name', label: 'name' },
  { id: 'context', label: 'context size' },
  { id: 'provider', label: 'provider' },
];
const PER_PAGE = 50;

function fmtContext(ctx: number | null): string {
  if (ctx === null || ctx === 0) return '—';
  return ctx >= 1_000_000 ? `${(ctx / 1_000_000).toFixed(1)}M` : `${Math.round(ctx / 1000)}k`;
}

function fmtPrice(perToken: string | undefined): string {
  if (perToken === undefined) return '—';
  const n = Number(perToken);
  if (!Number.isFinite(n) || n === 0) return n === 0 ? 'free' : '—';
  // per 1M tokens, standard display convention
  const perM = n * 1_000_000;
  return `$${perM < 0.1 ? perM.toFixed(3) : perM.toFixed(2)}/M`;
}

function modalityBadges(m: ProviderModel) {
  const out: { tone: 'cyan' | 'neutral' | 'ok'; text: string }[] = [];
  if (m.streaming !== null) out.push({ tone: 'cyan', text: m.streaming ? 'stream' : 'no-stream' });
  if (m.tools !== null) out.push({ tone: m.tools ? 'ok' : 'neutral', text: m.tools ? 'tools' : 'no-tools' });
  if (m.reasoning === true) out.push({ tone: 'cyan', text: 'reasoning' });
  return out;
}

export function ModelsPage() {
  const [q, setQ] = useState('');
  const [query, setQuery] = useState(''); // committed
  const [providerId, setProviderId] = useState('');
  const [sort, setSort] = useState('newest');
  const [page, setPage] = useState(1);
  const [providers, setProviders] = useState<ProviderApi[]>([]);
  const [data, setData] = useState<{ total: number; page: number; per_page: number; models: ProviderModel[] } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [aliases, setAliases] = useState<AliasRecord[]>([]);
  const [copiedRoute, setCopiedRoute] = useState<string | null>(null);

  useEffect(() => {
    api
      .providers()
      .then((r) => setProviders(r.providers))
      .catch(() => setProviders([]));
    api
      .aliases()
      .then((r) => setAliases(r.aliases))
      .catch(() => setAliases([]));
  }, []);

  // Alias chips per row: alias records point at one provider/model target.
  const aliasMap = new Map<string, string[]>();
  for (const a of aliases) {
    if (!a.enabled) continue;
    const route = `${a.provider_id}/${a.model}`;
    const list = aliasMap.get(route) ?? [];
    list.push(a.alias);
    aliasMap.set(route, list);
  }

  const load = useCallback(() => {
    setError(null);
    setBusy(true);
    api
      .models(query, providerId || null, sort, page, PER_PAGE)
      .then(setData)
      .catch((e: unknown) => setError(e))
      .finally(() => setBusy(false));
  }, [query, providerId, sort, page]);
  useEffect(load, [load, reloadTick]);

  useEffect(() => {
    const t = window.setTimeout(() => {
      setQuery(q);
      setPage(1);
    }, 250);
    return () => window.clearTimeout(t);
  }, [q]);

  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PER_PAGE));

  const commitProvider = (v: string) => {
    setProviderId(v);
    setPage(1);
  };
  const commitSort = (v: string) => {
    setSort(v);
    setPage(1);
  };

  return (
    <div className="space-y-4">
      <Panel
        title={
          <span className="flex items-center gap-2">
            <BrainCircuit size={15} className="text-cyan" /> Model explorer
            {data && <span className="zr-label">{total} models</span>}
          </span>
        }
        dense
      >
        <div className="flex flex-wrap items-center gap-2 border-b border-hairline px-4 py-3">
          <div className="relative min-w-[240px] flex-1">
            <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-faint" />
            <input
              className="zr-input pl-8"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search id or display name…"
              aria-label="Search models"
            />
          </div>
          <select className="zr-select w-auto min-w-[150px]" value={providerId} onChange={(e) => commitProvider(e.target.value)} aria-label="Filter by provider">
            <option value="">All providers</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.model_count})
              </option>
            ))}
          </select>
          <select className="zr-select w-auto min-w-[130px]" value={sort} onChange={(e) => commitSort(e.target.value)} aria-label="Sort">
            {SORTS.map((s) => (
              <option key={s.id} value={s.id}>
                Sort: {s.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="zr-btn"
            onClick={() => {
              setReloadTick((t) => t + 1);
              // re-read aliases too — discovery or alias edits may have changed both
              api.aliases().then((r) => setAliases(r.aliases)).catch(() => undefined);
            }}
            title="Refresh registry"
            aria-label="Refresh model registry"
          >
            <RefreshCw size={13} className={busy ? 'animate-spin' : ''} />
          </button>
        </div>

        {error !== null && <div className="p-4"><ErrorNote error={error} onRetry={load} /></div>}
        {error === null && data === null && <Loading label="Loading catalog" />}
        {error === null && data !== null && data.models.length === 0 && (
          <EmptyState>
            {data.total === 0
              ? 'No models match. Try running discovery on a provider.'
              : 'This page is empty — go back or narrow the filter.'}
          </EmptyState>
        )}
        {error === null && data !== null && data.models.length > 0 && (
          <table className="zr-table">
            <thead>
              <tr>
                <th>Availability</th>
                <th>Model id</th>
                <th>Display name</th>
                <th>Provider</th>
                <th>Context</th>
                <th>Pricing (in / out per 1M)</th>
                <th>Capabilities</th>
                <th>Aliases</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {data.models.map((m) => {
                const route = `${m.provider_id}/${m.upstream_id}`;
                const available = m.status === 'verified' && m.provider_enabled !== false;
                const rowAliases = aliasMap.get(route) ?? [];
                return (
                  <tr key={`${m.provider_id}:${m.upstream_id}`}>
                    <td>
                      <div className="flex items-center gap-1.5">
                        <StatusDot ok={m.status === 'verified' ? true : m.status === 'error' ? false : null} />
                        <span className="font-mono text-[11px] text-ink-dim">{m.status}</span>
                      </div>
                      {m.provider_enabled === false && <Badge tone="danger">unavailable · provider off</Badge>}
                      {available && <Badge tone="ok">routable</Badge>}
                    </td>
                    <td className="max-w-[280px]">
                      <div className="group/copy flex items-center gap-1.5">
                        <span className="truncate font-mono text-[12.5px]" title={`route: ${route}`}>
                          {m.upstream_id}
                        </span>
                        <button
                          type="button"
                          className="zr-btn !border-hairline !px-1.5 opacity-60 transition-opacity hover:opacity-100 group-hover/copy:opacity-100"
                          aria-label={`Copy route id ${route}`}
                          title={`Copy route id ${route}`}
                          onClick={() => {
                            void navigator.clipboard?.writeText(route).then(() => {
                              setCopiedRoute(route);
                              window.setTimeout(() => setCopiedRoute((cur) => (cur === route ? null : cur)), 1500);
                            });
                          }}
                        >
                          {copiedRoute === route ? <Check size={11} className="text-ok" /> : <Copy size={11} />}
                        </button>
                      </div>
                      {m.user_meta && <div className="truncate text-[11.5px] text-ink-faint" title={m.user_meta}>{m.user_meta}</div>}
                    </td>
                    <td className="max-w-[240px]">
                      <div className="truncate text-[13px]">{m.display_name}</div>
                    </td>
                    <td className="font-mono text-[12px] text-ink-dim">{m.provider_id}</td>
                    <td className="zr-num text-ink-dim">{fmtContext(m.context_length)}</td>
                    <td className="zr-num text-[12px] text-ink-dim">
                      {m.pricing ? `${fmtPrice(m.pricing.prompt_per_token)} · ${fmtPrice(m.pricing.completion_per_token)}` : '—'}
                    </td>
                    <td>
                      <div className="flex flex-wrap gap-1">
                        {m.input_modalities?.includes('image') && <Badge tone="cyan">image-in</Badge>}
                        {modalityBadges(m).map((b, i) => (
                          <Badge key={`${b.text}:${i}`} tone={b.tone}>{b.text}</Badge>
                        ))}
                      </div>
                    </td>
                    <td className="max-w-[140px]">
                      {rowAliases.length === 0 ? (
                        <span className="text-ink-faint">—</span>
                      ) : (
                        <span className="flex flex-wrap gap-1">
                          {rowAliases.map((a) => (
                            <Badge key={a} tone="warn">{a}</Badge>
                          ))}
                        </span>
                      )}
                    </td>
                    <td className="zr-label">{m.source}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {error === null && data !== null && data.models.length > 0 && (
          <div className="flex items-center justify-between px-4 py-3">
            <span className="zr-label">
              Page {Math.min(data.page, pageCount)} of {pageCount} · {total} total
            </span>
            <div className="flex gap-2">
              <button type="button" className="zr-btn" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}>
                <ChevronLeft size={13} /> Prev
              </button>
              <button type="button" className="zr-btn" onClick={() => setPage((p) => Math.min(pageCount, p + 1))} disabled={page >= pageCount}>
                Next <ChevronRight size={13} />
              </button>
            </div>
          </div>
        )}
      </Panel>

      <Panel title="API access">
        <p className="text-[13px] text-ink-dim">
          Route models by registry id <span className="font-mono text-cyan">{'<provider_id>/<upstream_id>'}</span> or
          by alias. Aliases (see the Aliases page) attach stable names and baked-in parameters over these targets,
          with fallbacks only where you explicitly configured them.
        </p>
        <ApiAccessCard />
      </Panel>
    </div>
  );
}

/** Live base-URL examples for the unified gateway API. The origin is derived
 *  at runtime via lib/origin, so the same console shows correct URLs on
 *  localhost, a LAN box, or a deployed domain — no hardcoded host anywhere. */
function ApiAccessCard() {
  const origin = getRuntimeOrigin();
  const [copied, setCopied] = useState<string | null>(null);
  const examples = [
    {
      id: 'models',
      label: 'GET /v1/models',
      text: `curl ${origin}/v1/models \\\n  -H "Authorization: Bearer zr_YOUR_GATEWAY_KEY"`,
    },
    {
      id: 'chat',
      label: 'POST /v1/chat/completions',
      text: `curl ${origin}/v1/chat/completions \\\n  -H "Authorization: Bearer zr_YOUR_GATEWAY_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model": "provider/model", "messages": [{"role": "user", "content": "Hello!"}]}'`,
    },
  ];
  return (
    <div className="mt-3 space-y-2.5">
      {examples.map((ex) => (
        <div key={ex.id} className="flex items-center justify-between gap-3 rounded-md border border-hairline bg-canvas px-3 py-2.5">
          <div className="min-w-0">
            <div className="zr-label">{ex.label}</div>
            <div className="mt-0.5 truncate font-mono text-[11.5px] text-ink-dim" title={ex.text}>
              {ex.text.split('\n')[0]}
            </div>
          </div>
          <button
            type="button"
            className="zr-btn shrink-0"
            onClick={() => {
              void navigator.clipboard?.writeText(ex.text).then(() => {
                setCopied(ex.id);
                window.setTimeout(() => setCopied((cur) => (cur === ex.id ? null : cur)), 1600);
              });
            }}
            aria-label={`Copy ${ex.label} example`}
          >
            {copied === ex.id ? (
              <>
                <Check size={12} className="text-ok" /> Copied
              </>
            ) : (
              <>
                <Copy size={12} /> Copy
              </>
            )}
          </button>
        </div>
      ))}
      <p className="text-[12px] leading-relaxed text-ink-faint">
        Gateway keys are separate from your browser session. Create one under{' '}
        <a href="/console/keys" className="text-cyan underline-offset-2 hover:underline">
          Gateway keys
        </a>
        , then address the API with <span className="font-mono">Authorization: Bearer zr_…</span>.
      </p>
    </div>
  );
}
