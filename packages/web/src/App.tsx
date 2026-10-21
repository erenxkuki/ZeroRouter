/**
 * App shell: public landing + terms/privacy pages, the session-gated console
 * under /console, and the login route. Session state is fetched once and
 * refreshed on demand (login, logout, "zr:unauthorized"). With a dashboard
 * credential configured, every /console route requires an authenticated
 * session; loopback-only mode needs none. Public pages never render private
 * data — the landing shows clearly-labeled demo rows only.
 */
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation } from 'react-router';
import { Activity } from 'lucide-react';
import { api, type Health, type SessionInfo } from './api';
import { Layout } from './components/Layout';
import { OverviewPage } from './pages/OverviewPage';
import { ProvidersPage } from './pages/ProvidersPage';
import { ModelsPage } from './pages/ModelsPage';
import { AliasesPage } from './pages/AliasesPage';
import { KeysPage } from './pages/KeysPage';
import { LogsPage } from './pages/LogsPage';
import { PlaygroundPage } from './pages/PlaygroundPage';
import { DiagnosticsPage } from './pages/DiagnosticsPage';
import { SettingsPage } from './pages/SettingsPage';
import { LoginPage } from './pages/LoginPage';
import { LandingPage } from './pages/LandingPage';
import { TermsPage } from './pages/TermsPage';
import { PrivacyPage } from './pages/PrivacyPage';

const TITLES: Record<string, string> = {
  '/console': 'Overview',
  '/console/providers': 'Providers',
  '/console/models': 'Model explorer',
  '/console/aliases': 'Aliases',
  '/console/keys': 'Gateway keys',
  '/console/logs': 'Request logs',
  '/console/playground': 'Playground',
  '/console/diagnostics': 'Diagnostics',
  '/console/settings': 'Settings',
};

function Splash({ note = 'Connecting to gateway' }: { note?: string }) {
  return (
    <div className="grid min-h-screen place-items-center bg-canvas">
      <div className="flex items-center gap-3 text-[13px] text-ink-dim">
        <span className="grid size-8 place-items-center rounded-md border border-amber/40 bg-amber/10">
          <Activity size={15} className="animate-pulse text-amber" />
        </span>
        {note}…
      </div>
    </div>
  );
}

/** Wraps console routes; unauthenticated visitors are sent to login with a
 *  validated (safe-redirect) return target. */
function RequireSession({ session, children }: { session: SessionInfo | null; children: ReactNode }) {
  const location = useLocation();
  if (session && session.authenticated) return <>{children}</>;
  const from = `${location.pathname}${location.search}`;
  return <Navigate to={`/login?from=${encodeURIComponent(from)}`} replace />;
}

/** Console layout route: resolves the page title from the path and renders the
 *  shared shell around the nested <Outlet/>. */
function ConsoleLayout({ session, healthOk }: { session: SessionInfo | null; healthOk: boolean | null }) {
  const location = useLocation();
  return (
    <Layout session={session} healthOk={healthOk} title={TITLES[location.pathname] ?? 'ZeroRouter'}>
      <Outlet />
    </Layout>
  );
}

/** The session probe never returned a status (server unreachable). The login
 *  page needs the auth mode, so offer a stateful retry instead of guessing. */
function BootRefused({ onRetry }: { onRetry: () => Promise<void> }) {
  return (
    <div className="grid min-h-screen place-items-center bg-canvas">
      <div className="flex flex-col items-center gap-3 text-center">
        <span className="grid size-8 place-items-center rounded-md border border-danger/40 bg-danger/10">
          <Activity size={15} className="text-danger" />
        </span>
        <p className="text-[13.5px] text-ink-dim">
          Gateway unreachable — is the ZeroRouter server running?
        </p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="zr-btn zr-btn-cyan"
            onClick={() => void onRetry()}
          >
            Retry
          </button>
        </div>
      </div>
    </div>
  );
}

export function App() {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [bootDone, setBootDone] = useState(false);
  const [health, setHealth] = useState<Health | null>(null);

  const reloadSession = useCallback((): Promise<void> => {
    return api
      .session()
      .then(setSession)
      .catch(() => {
        // Gateway unreachable (or transient abort): keep whatever we know.
        setSession((s) => s);
      })
      .finally(() => {
        setBootDone(true);
      });
  }, []);

  useEffect(() => {
    void reloadSession();
    const onUnauthorized = () => {
      // A session-eating 401 arrived: surface an honest notice on the login
      // page, then re-read the session; the gate re-renders. An explicitly
      // signed-out 401 already wrote its own notice — don't overwrite it.
      let intentional = false;
      try {
        intentional = sessionStorage.getItem('zr_logout_intentional') === '1';
        if (intentional) sessionStorage.removeItem('zr_logout_intentional');
      } catch {
        /* storage unavailable */
      }
      if (!intentional) {
        try {
          sessionStorage.setItem('zr_login_notice', 'Your session has expired. Sign in again.');
        } catch {
          /* storage unavailable — the notice is a nicety, not state */
        }
      }
      void api
        .session()
        .then(setSession)
        .catch(() => undefined);
    };
    window.addEventListener('zr:unauthorized', onUnauthorized);
    return () => window.removeEventListener('zr:unauthorized', onUnauthorized);
  }, [reloadSession]);

  useEffect(() => {
    let stop = false;
    const tick = () => {
      api
        .health()
        .then((h) => {
          if (!stop) setHealth(h);
        })
        .catch(() => {
          if (!stop) setHealth(null);
        });
    };
    tick();
    const t = window.setInterval(tick, 15_000);
    return () => {
      stop = true;
      window.clearInterval(t);
    };
  }, []);

  const healthOk = health === null ? null : health.ok === true;

  return (
    <BrowserRouter>
      {!bootDone ? (
        <Splash />
      ) : (
        <Routes>
          {/* public face — no private data, demo models only */}
          <Route path="/" element={<LandingPage session={session} healthOk={healthOk} />} />
          <Route
            path="/login"
            element={
              session ? (
                <LoginPage session={session} healthOk={healthOk} reloadSession={reloadSession} />
              ) : (
                <BootRefused onRetry={reloadSession} />
              )
            }
          />
          <Route path="/terms" element={<TermsPage session={session} />} />
          <Route path="/privacy" element={<PrivacyPage session={session} />} />
          {/* owner console — session-guarded; unauthenticated visitors get a
              safe-redirect login link back to the exact console page */}
          <Route
            path="/console"
            element={
              <RequireSession session={session}>
                <ConsoleLayout session={session} healthOk={healthOk} />
              </RequireSession>
            }
          >
            <Route index element={<OverviewPage />} />
            <Route path="providers" element={<ProvidersPage session={session} />} />
            <Route path="models" element={<ModelsPage />} />
            <Route path="aliases" element={<AliasesPage />} />
            <Route path="keys" element={<KeysPage />} />
            <Route path="logs" element={<LogsPage />} />
            <Route path="playground" element={<PlaygroundPage />} />
            <Route path="diagnostics" element={<DiagnosticsPage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/console" replace />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      )}
    </BrowserRouter>
  );
}

export default App;
