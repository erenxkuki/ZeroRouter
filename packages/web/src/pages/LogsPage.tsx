/**
 * Request logs: filterable, paginated, with a per-row detail modal (request
 * body / error payload when body logging is enabled).
 */
import { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, ScrollText, Trash2, Info } from 'lucide-react';
import { api, fmtDateTime, type LogEntry, type LogRow, type ProviderApi } from '../api';
import { Badge, EmptyState, ErrorNote, JsonBlock, Loading, Modal, Panel } from '../ui';

const PAGE_SIZE = 50;

function statusTone(status: number): { tone: 'ok' | 'danger' | 'warn'; text: string } {
  if (status < 400) return { tone: 'ok', text: String(status) };
  if (status === 499) return { tone: 'warn', text: '499 abort' };
  return { tone: 'danger', text: String(status) };
}

export function LogsPage() {
  const [providerId, setProviderId] = useState('');
  const [status, setStatus] = useState<'' | 'ok' | 'error'>('');
  const [page, setPage] = useState(0);
  const [providers, setProviders] = useState<ProviderApi[]>([]);
  const [data, setData] = useState<{ total: number; rows: LogRow[] } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [detail, setDetail] = useState<{ entry: LogEntry } | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    api
      .providers()
      .then((r) => setProviders(r.providers))
      .catch(() => setProviders([]));
  }, []);

  const load = useCallback(() => {
    setError(null);
    api
      .logs({
        providerId: providerId || null,
        status: status === '' ? null : status,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      })
      .then(setData)
      .catch((e: unknown) => setError(e));
  }, [providerId, status, page]);
  useEffect(load, [load, reloadTick]);

  const openDetail = async (row: LogRow) => {
    setDetailLoading(true);
    try {
      const res = await api.logEntry(row.id);
      setDetail(res);
    } catch {
      // Fall back to the summary-only modal.
      setDetail({ entry: { ...row, body_json: null } });
    } finally {
      setDetailLoading(false);
    }
  };

  const clearLogs = async () => {
    setConfirmClear(false);
    try {
      await api.clearLogs();
      setPage(0);
      setReloadTick((t) => t + 1);
    } catch (err) {
      setError(err);
    }
  };

  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-4">
      <Panel
        title={
          <span className="flex items-center gap-2">
            <ScrollText size={15} className="text-cyan" /> Request logs
            {data && <span className="zr-label">{total} entries</span>}
          </span>
        }
        actions={
          <button type="button" className="zr-btn zr-btn-danger" onClick={() => setConfirmClear(true)} title="Delete all logs">
            <Trash2 size={13} /> Clear
          </button>
        }
        dense
      >
        <div className="flex flex-wrap items-center gap-2 border-b border-hairline px-4 py-3">
          <select className="zr-select w-auto min-w-[170px]" value={providerId} onChange={(e) => { setProviderId(e.target.value); setPage(0); }} aria-label="Filter by provider">
            <option value="">All providers</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <select
            className="zr-select w-auto min-w-[140px]"
            value={status}
            onChange={(e) => { setStatus(e.target.value as '' | 'ok' | 'error'); setPage(0); }}
            aria-label="Filter by status"
          >
            <option value="">Any outcome</option>
            <option value="ok">Success only</option>
            <option value="error">Errors only</option>
          </select>
          <button type="button" className="zr-btn" onClick={() => setReloadTick((t) => t + 1)} title="Refresh">
            Refresh
          </button>
        </div>

        {error !== null && <div className="p-4"><ErrorNote error={error} onRetry={() => { setError(null); load(); }} /></div>}
        {error === null && data === null && <Loading label="Loading logs" />}
        {error === null && data !== null && data.rows.length === 0 && (
          <EmptyState>No entries{data.total === 0 ? ' yet' : ' on this page — try clearing the filters'}.</EmptyState>
        )}
        {error === null && data !== null && data.rows.length > 0 && (
          <table className="zr-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Outcome</th>
                <th>Source</th>
                <th>Key</th>
                <th>Provider / model</th>
                <th>Stream</th>
                <th>Duration</th>
                <th>Tokens (p / c)</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => {
                const st = statusTone(r.status);
                return (
                  <tr key={r.id} className="cursor-pointer" onClick={() => void openDetail(r)}>
                    <td className="zr-num whitespace-nowrap text-[12px] text-ink-dim">{fmtDateTime(r.ts)}</td>
                    <td><Badge tone={st.tone}>{st.text}</Badge></td>
                    <td><span className="font-mono text-[11.5px]">{r.source}</span></td>
                    <td className="font-mono text-[12px] text-ink-dim">{r.client_key_id ?? '—'}</td>
                    <td className="max-w-[280px]">
                      {r.provider_id ? (
                        <div className="truncate font-mono text-[12px]">
                          <span className="text-ink-dim">{r.provider_id}</span>
                          <span className="text-ink-faint"> / {r.model ?? '?'}</span>
                          {r.alias && <span className="ml-1 text-amber">⇢ {r.alias}</span>}
                        </div>
                      ) : (
                        <span className="font-mono text-[12px] text-ink-dim">{r.model ?? '—'}</span>
                      )}
                    </td>
                    <td className="zr-label">{r.stream ? 'sse' : 'blocking'}</td>
                    <td className="zr-num text-ink-dim">{r.duration_ms !== null ? `${r.duration_ms} ms` : '—'}</td>
                    <td className="zr-num text-[12px] text-ink-dim">
                      {r.prompt_tokens !== null || r.completion_tokens !== null
                        ? `${r.prompt_tokens ?? '—'} / ${r.completion_tokens ?? '—'}`
                        : '—'}
                    </td>
                    <td className="max-w-[220px]">
                      {r.error_code ? (
                        <div className="truncate font-mono text-[11.5px] text-danger" title={r.error_message ?? undefined}>
                          {r.error_code}
                        </div>
                      ) : (
                        <span className="text-ink-faint">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {error === null && data !== null && data.rows.length > 0 && (
          <div className="flex items-center justify-between px-4 py-3">
            <span className="zr-label">
              Entries {page * PAGE_SIZE + 1}–{Math.min(total, (page + 1) * PAGE_SIZE)} of {total}
            </span>
            <div className="flex gap-2">
              <button type="button" className="zr-btn" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}>
                <ChevronLeft size={13} /> Prev
              </button>
              <button
                type="button"
                className="zr-btn"
                onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                disabled={(page + 1) * PAGE_SIZE >= total}
              >
                Next <ChevronRight size={13} />
              </button>
            </div>
          </div>
        )}
      </Panel>

      <Modal open={detail !== null && !detailLoading} onClose={() => setDetail(null)} title="Request detail" width="max-w-2xl">
        {detail && (
          <div className="space-y-3 text-[13px]">
            <table className="w-full text-[12.5px]">
              <tbody>
                {[
                  ['Request id', detail.entry.id],
                  ['Time', fmtDateTime(detail.entry.ts)],
                  ['Source', detail.entry.source],
                  ['Gateway key', detail.entry.client_key_id ?? '—'],
                  ['Provider', detail.entry.provider_id ? `${detail.entry.provider_id} (${detail.entry.provider_name})` : '—'],
                  ['Model', detail.entry.model ?? '—'],
                  ['Alias', detail.entry.alias ?? '—'],
                  ['Mode', detail.entry.stream ? 'streaming' : 'blocking'],
                  ['Status', String(detail.entry.status)],
                  ['Duration', detail.entry.duration_ms !== null ? `${detail.entry.duration_ms} ms` : '—'],
                  ['Tokens', detail.entry.prompt_tokens !== null || detail.entry.completion_tokens !== null ? `prompt ${detail.entry.prompt_tokens ?? '—'} · completion ${detail.entry.completion_tokens ?? '—'}` : '—'],
                ].map(([k, v]) => (
                  <tr key={k}>
                    <td className="zr-label py-1 pr-4 align-top">{k}</td>
                    <td className="py-1 font-mono text-[12px] text-ink-dim">{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {detail.entry.error_message && (
              <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 font-mono text-[12px] text-danger">
                {detail.entry.error_code}: {detail.entry.error_message}
              </div>
            )}
            {detail.entry.body_json ? (
              <>
                <div className="zr-label pt-1">Logged request body</div>
                <JsonBlock value={JSON.parse(detail.entry.body_json)} max={2000} />
              </>
            ) : (
              <div className="flex items-center gap-2 rounded-md border border-hairline bg-panel-raised px-3 py-2 text-[12px] text-ink-faint">
                <Info size={13} />
                No request body stored. Enable “debug_log_request_bodies” in Settings to persist bodies (privacy-sensitive).
              </div>
            )}
          </div>
        )}
      </Modal>

      <Modal open={confirmClear} onClose={() => setConfirmClear(false)} title="Clear all request logs?">
        <div className="space-y-3">
          <p className="text-[13px] text-ink-dim">
            Every log entry (including error traces) will be deleted. This cannot be undone. Provider event history is
            not affected.
          </p>
          <div className="flex justify-end gap-2">
            <button type="button" className="zr-btn" onClick={() => setConfirmClear(false)}>Cancel</button>
            <button type="button" className="zr-btn zr-btn-danger" onClick={clearLogs}>Clear logs</button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
