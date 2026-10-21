/** Runtime diagnostics: server config, store counts, adapters, hard limits. */
import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Scale } from 'lucide-react';
import { api, type Diagnostics } from '../api';
import { Badge, ErrorNote, Loading, Panel, StatusDot } from '../ui';

export function DiagnosticsPage() {
  const [diag, setDiag] = useState<Diagnostics | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [reloadTick, setReloadTick] = useState(0);

  const load = useCallback(() => {
    setError(null);
    api
      .diagnostics()
      .then(setDiag)
      .catch((e: unknown) => setError(e));
  }, []);
  useEffect(load, [load, reloadTick]);

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button type="button" className="zr-btn" onClick={() => setReloadTick((t) => t + 1)}>
          <RefreshCw size={13} /> Refresh
        </button>
      </div>
      {error !== null && <ErrorNote error={error} onRetry={load} />}
      {error === null && diag === null && <Loading label="Loading diagnostics" />}
      {error === null && diag !== null && (
        <>
          <div className="grid gap-4 md:grid-cols-2">
            <Panel
              title={
                <span className="flex items-center gap-2">
                  <Scale size={15} className="text-cyan" /> Server
                </span>
              }
            >
              <table className="w-full text-[12.5px]">
                <tbody>
                  {[
                    ['Environment', diag.server.env],
                    ['Bind address', `${diag.server.host}:${diag.server.port}`],
                    ['Remote access', diag.server.allow_remote ? 'enabled (bind 0.0.0.0)' : 'disabled (loopback only)'],
                    ['Dashboard password', diag.server.dashboard_password ? 'configured' : 'not set — loopback-only auth'],
                    ['Data directory', diag.server.data_dir],
                    ['Dev CORS origin', diag.server.dev_cors_origin ?? 'none'],
                  ].map(([k, v]) => (
                    <tr key={k}>
                      <td className="zr-label py-1.5 pr-4 align-top">{k}</td>
                      <td className="py-1.5 break-all font-mono text-[12px] text-ink-dim">{v}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>

            <Panel title="Store counts">
              <div className="grid grid-cols-2 gap-3">
                {[
                  ['Providers', diag.counts.providers, `${diag.counts.providers_enabled} enabled`],
                  ['Models', diag.counts.models, 'across providers'],
                  ['Aliases', diag.counts.aliases, 'routing entries'],
                  ['Gateway keys', diag.counts.gateway_keys, `${diag.counts.gateway_keys_active} active`],
                ].map(([label, count, sub]) => (
                  <div key={String(label)} className="rounded-md border border-hairline bg-panel-raised px-3 py-2.5">
                    <div className="zr-label pb-1">{String(label)}</div>
                    <div className="font-display text-[22px] font-semibold leading-6 tabular-nums">{count}</div>
                    <div className="pt-0.5 text-[11px] text-ink-faint">{String(sub)}</div>
                  </div>
                ))}
              </div>
            </Panel>
          </div>

          <Panel title="Adapters">
            <table className="zr-table">
              <thead>
                <tr>
                  <th>Adapter</th>
                  <th>Status</th>
                  <th>Discovery</th>
                  <th>Streaming</th>
                  <th>Tools</th>
                  <th>Text+image</th>
                </tr>
              </thead>
              <tbody>
                {diag.adapters.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <div className="flex items-center gap-2">
                        <StatusDot ok={true} />
                        <span className="font-mono text-[12.5px]">{a.id}</span>
                      </div>
                    </td>
                    <td><Badge tone="ok">loaded</Badge></td>
                    <td><Badge tone={a.capabilities.discovery ? 'cyan' : 'neutral'}>{a.capabilities.discovery ? 'yes' : 'manual'}</Badge></td>
                    <td><Badge tone={a.capabilities.streaming ? 'cyan' : 'neutral'}>{a.capabilities.streaming ? 'yes' : 'no'}</Badge></td>
                    <td><Badge tone="neutral">{String(a.capabilities.tools)}</Badge></td>
                    <td><Badge tone={a.capabilities.multimodalTextImage ? 'cyan' : 'neutral'}>{a.capabilities.multimodalTextImage ? 'yes' : 'no'}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>

          <div className="grid gap-4 md:grid-cols-2">
            <Panel title="Active settings (live sensor)">
              <table className="w-full text-[12.5px]">
                <tbody>
                  {Object.entries(diag.settings).map(([k, v]) => (
                    <tr key={k}>
                      <td className="zr-label py-1.5 pr-4 align-top" style={{ textTransform: 'none' }}>{k}</td>
                      <td className="py-1.5 font-mono text-[12px] text-ink-dim">{String(v)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
            <Panel title="Hard limits">
              <table className="w-full text-[12.5px]">
                <tbody>
                  {Object.entries(diag.limits).map(([k, v]) => (
                    <tr key={k}>
                      <td className="zr-label py-1.5 pr-4 align-top" style={{ textTransform: 'none' }}>{k}</td>
                      <td className="py-1.5 break-all text-[12px] text-ink-dim">{v}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
          </div>
        </>
      )}
    </div>
  );
}
