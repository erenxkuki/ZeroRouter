import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { ArrowRight } from 'lucide-react';
import {
  api,
  fmtDateTime,
  type ActivityBucket,
  type ProviderApi,
  type ProviderEvent,
  type Stats,
  type OverviewResponse,
} from '../api';
import { Badge, EmptyState, Panel, StatusDot, Stat, ErrorNote } from '../ui';
import { Sparkbars } from '../components/Sparkbars';

function pct(n: number | null): string {
  if (n === null) return '—';
  return `${(n * 100).toFixed(1)}%`;
}

function eventTone(kind: string, status: string | null): 'ok' | 'warn' | 'danger' | 'neutral' {
  if (status === 'failed' || kind === 'auth_issue') return 'danger';
  if (status === 'ok') return 'ok';
  return 'neutral';
}

export function OverviewPage() {
  const [data, setData] = useState<OverviewResponse | null>(null);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(() => {
    setError(null);
    api
      .overview()
      .then(setData)
      .catch((e: unknown) => setError(e));
  }, []);
  useEffect(load, [load]);

  const stats: Stats | null = data?.stats ?? null;
  const activity: ActivityBucket[] = data?.activity ?? [];
  const providers: ProviderApi[] = data?.providers ?? [];
  const events: ProviderEvent[] = data?.events ?? [];

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Stat label="requests · 24h" value={stats ? stats.requests_24h : '—'} sub={stats ? `7d: ${stats.requests_7d}` : ''} />
        <Stat
          label="success rate · 24h"
          value={stats ? pct(stats.success_rate_24h) : '—'}
          sub={stats && stats.p95_latency_ms_24h !== null ? `p95 ${stats.p95_latency_ms_24h} ms` : ''}
          tone={stats && stats.success_rate_24h !== null && stats.success_rate_24h < 0.9 ? 'amber' : undefined}
        />
        <Stat
          label="tokens · 24h"
          value={stats?.tokens_24h ? (stats.tokens_24h.prompt + stats.tokens_24h.completion).toLocaleString() : '—'}
          sub={stats?.tokens_24h ? `prompt ${stats.tokens_24h.prompt.toLocaleString()} · completion ${stats.tokens_24h.completion.toLocaleString()}` : 'no usage recorded'}
          tone="cyan"
        />
        <Stat
          label="stack"
          value={stats ? `${stats.providers_enabled}/${stats.providers_configured}` : '—'}
          sub="providers online"
        />
      </div>

      {error !== null && <ErrorNote error={error} onRetry={load} />}

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
        <Panel title={<span className="zr-label">activity — last 24h</span>} className="xl:col-span-2">
          {activity.length === 0 ? <EmptyState>No requests in the window yet.</EmptyState> : <Sparkbars buckets={activity} />}
          {stats && (
            <div className="mt-3 flex gap-4 border-t border-hairline pt-3 font-mono text-[11px] text-ink-faint">
              <span>avg {stats.avg_latency_ms_24h !== null ? `${stats.avg_latency_ms_24h} ms` : '—'}</span>
              <span>streamed {pct(stats.streaming_share_24h)}</span>
              <span>models {stats.models_total}</span>
            </div>
          )}
        </Panel>

        <Panel
          title={<span className="zr-label">providers</span>}
          actions={
            <Link to="/providers" className="zr-label flex items-center gap-1 hover:text-cyan">
              manage <ArrowRight size={11} />
            </Link>
          }
        >
          {providers.length === 0 ? (
            <EmptyState>
              No providers yet. <Link to="/providers" className="text-cyan hover:underline">Add the first one.</Link>
            </EmptyState>
          ) : (
            <ul className="space-y-2">
              {providers.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-2 rounded-md border border-hairline px-3 py-2">
                  <div className="min-w-0">
                    <div className="truncate text-[13px]">{p.name}</div>
                    <div className="flex items-center gap-2 pt-0.5">
                      <StatusDot ok={p.enabled} />
                      <span className="zr-label truncate">{p.adapter} · {p.model_count} models</span>
                    </div>
                  </div>
                  <Badge tone={p.test_status === 'ok' ? 'ok' : p.test_status === 'failed' ? 'danger' : 'neutral'}>
                    {p.test_status}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <Panel title={<span className="zr-label">recent system events</span>}>
        {events.length === 0 ? (
          <EmptyState>No provider events recorded yet.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="zr-table zr-rowsIn">
              <thead>
                <tr>
                  <th>time</th>
                  <th>provider</th>
                  <th>kind</th>
                  <th>status</th>
                  <th>detail</th>
                </tr>
              </thead>
              <tbody>
                {events.map((ev, i) => (
                  <tr key={`${ev.id ?? i}`}>
                    <td className="whitespace-nowrap font-mono text-[12px] text-ink-dim">{fmtDateTime(ev.ts)}</td>
                    <td className="font-mono text-[12px]">{ev.provider_id}</td>
                    <td className="zr-label">{ev.kind.replace(/_/g, ' ')}</td>
                    <td>
                      <Badge tone={eventTone(ev.kind, ev.status)}>{ev.status ?? 'info'}</Badge>
                    </td>
                    <td className="text-[12.5px] text-ink-dim">
                      {ev.message}
                      {ev.latency_ms !== null ? <span className="font-mono text-ink-faint"> · {ev.latency_ms} ms</span> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
