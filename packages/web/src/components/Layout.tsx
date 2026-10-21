/** Console shell: fixed sidebar, header with session state, content outlet. */
import { type ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router';
import {
  Activity,
  Boxes,
  Cpu,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Scale,
  Settings as SettingsIcon,
  Shuffle,
  Terminal,
  ScrollText,
} from 'lucide-react';
import { StatusDot } from '../ui';
import type { SessionInfo } from '../api';

const NAV = [
  { to: '/console', label: 'Overview', icon: LayoutDashboard },
  { to: '/console/providers', label: 'Providers', icon: Cpu },
  { to: '/console/models', label: 'Model explorer', icon: Boxes },
  { to: '/console/aliases', label: 'Aliases', icon: Shuffle },
  { to: '/console/keys', label: 'Gateway keys', icon: KeyRound },
  { to: '/console/logs', label: 'Request logs', icon: ScrollText },
  { to: '/console/playground', label: 'Playground', icon: Terminal },
  { to: '/console/diagnostics', label: 'Diagnostics', icon: Scale },
  { to: '/console/settings', label: 'Settings', icon: SettingsIcon },
] as const;

export function Layout({
  session,
  healthOk,
  title,
  children,
}: {
  session: SessionInfo | null;
  healthOk: boolean | null;
  title: string;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const logout = async () => {
    try {
      await fetch('/admin/session/logout', { method: 'POST', headers: { 'x-requested-with': 'zerorouter' } });
    } catch {
      /* best effort */
    }
    try {
      sessionStorage.setItem('zr_login_notice', 'Signed out. The server session was invalidated.');
      // Marks the following 401 as self-initiated so the App-level handler
      // does not overwrite the notice with the "expired" message.
      sessionStorage.setItem('zr_logout_intentional', '1');
    } catch {
      /* storage unavailable */
    }
    // Invalidate App-level session state so the gate actually locks the console.
    window.dispatchEvent(new CustomEvent('zr:unauthorized'));
    navigate('/login');
  };

  return (
    <div className="flex min-h-screen">
      <aside className="fixed inset-y-0 left-0 z-30 flex w-[218px] flex-col border-r border-hairline bg-panel">
        <div className="flex items-center gap-2.5 border-b border-hairline px-4 py-4">
          <div className="grid size-7 place-items-center rounded-md border border-amber/40 bg-amber/10">
            <Activity size={15} className="text-amber" />
          </div>
          <div>
            <div className="font-display text-[14.5px] font-semibold leading-4 tracking-tight">ZeroRouter</div>
            <div className="zr-label">gateway console</div>
          </div>
        </div>
        <nav className="flex-1 overflow-y-auto p-2">
          {NAV.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/console'}
              className={({ isActive }) =>
                `mb-0.5 flex items-center gap-2.5 rounded-md px-3 py-2 text-[13px] transition-colors ${
                  isActive
                    ? 'bg-panel-raised text-ink shadow-[inset_2px_0_0_0_var(--color-amber)]'
                    : 'text-ink-dim hover:bg-panel-raised/60 hover:text-ink'
                }`
              }
            >
              <Icon size={15} className="shrink-0 text-ink-faint" />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-hairline p-3">
          <div className="flex items-center justify-between rounded-md bg-panel-raised px-3 py-2">
            <div className="flex items-center gap-2 text-[12px] text-ink-dim">
              <StatusDot ok={healthOk} />
              {healthOk === null ? 'checking…' : healthOk ? 'online' : 'offline'}
            </div>
            <span className="zr-label">
              {session && session.mode !== 'loopback_only' ? 'session' : 'loopback'}
            </span>
          </div>
          {session && session.mode !== 'loopback_only' && (
            <button type="button" onClick={logout} className="zr-btn mt-2 w-full justify-center text-[12px]">
              <LogOut size={13} /> Sign out
            </button>
          )}
        </div>
      </aside>
      <main className="ml-[218px] flex-1">
        <header className="sticky top-0 z-20 flex h-12 items-center justify-between border-b border-hairline bg-canvas/85 px-6 backdrop-blur">
          <h1 className="font-display text-[15px] font-semibold tracking-tight text-ink">{title}</h1>
          <span className="zr-label">{session?.secure_context ? 'remote host' : 'local host'}</span>
        </header>
        <div className="p-6">{children}</div>
      </main>
    </div>
  );
}
