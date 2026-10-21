/**
 * Private owner login — split-layout sign-in for the gateway console.
 *
 * Design contract: the left showcase is decorative but its status labels
 * reflect REAL application state (gateway health from /healthz, auth mode and
 * TLS context from /admin/session). The form renders a username field only in
 * `database` auth (provisioned owner credential) — never a decorative control.
 * Post-login navigation runs through isSafeInternalPath (open-redirect
 * prevention). All motion is CSS-only and disabled under
 * `prefers-reduced-motion`; the success state only appears after a real 2xx
 * from /admin/session/login.
 */
import { type FormEvent, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { Activity, Check, Eye, EyeOff, LogIn, X } from 'lucide-react';
import { api, type SessionInfo } from '../api';
import { normalizeLoginReturn } from '../lib/safeRedirect';
import { ErrorNote, Field, Spinner } from '../ui';

function StatusChip({ label, state }: { label: string; state: 'ok' | 'warn' | 'danger' }) {
  const dot: Record<typeof state, string> = {
    ok: 'bg-cyan',
    warn: 'bg-amber',
    danger: 'bg-danger',
  };
  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider text-ink-faint">
      <span className={`size-1.5 rounded-full ${dot[state]}`} aria-hidden />
      {label}
    </span>
  );
}

/** Original animated flow diagram: providers → gateway → API clients.
 *  Pure SVG + CSS keyframes (see styles.css); static dots under reduced motion. */
function GatewayFlow({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 360 208" fill="none" className={className} aria-hidden="true" focusable="false">
      {/* structure: hairline wiring */}
      <g stroke="var(--color-hairline-strong)" strokeWidth="1">
        <path d="M70 52 H104" />
        <path d="M70 104 H104" />
        <path d="M70 156 H104" />
        <path d="M104 52 V156" />
        <path d="M104 104 H128" />
        <path d="M196 104 H296" />
      </g>

      {/* provider nodes */}
      {[52, 104, 156].map((y) => (
        <g key={y}>
          <rect x={44} y={y - 9} width={26} height={18} rx={4} fill="var(--color-panel-raised)" stroke="var(--color-hairline-strong)" />
          <circle cx={57} cy={y} r={2.4} fill="var(--color-ink-faint)" />
        </g>
      ))}
      <text x={44} y={186} className="zr-label" style={{ fontSize: 8 }}>providers</text>

      {/* inbound packets (CSS-animated) */}
      <g className="zr-motion" fill="var(--color-cyan)">
        <circle className="zr-packet zin-1" r={2.4} cx={70} cy={52} />
        <circle className="zr-packet zin-2" r={2.4} cx={70} cy={104} />
        <circle className="zr-packet zin-3" r={2.4} cx={70} cy={156} />
      </g>

      {/* gateway node with pulse ring */}
      <circle cx={162} cy={104} r={30} stroke="rgba(245,178,60,0.35)" className="zr-gateway-ring" style={{ transformBox: 'fill-box', transformOrigin: 'center' }} />
      <rect x={136} y={80} width={52} height={48} rx={10} fill="var(--color-panel-raised)" stroke="rgba(245,178,60,0.5)" />
      <path d="M162 92 L170 98 V110 L162 116 L154 110 V98 Z" stroke="var(--color-amber)" strokeWidth="1.2" fill="rgba(245,178,60,0.12)" />
      <text x={162} y={186} textAnchor="middle" className="zr-label" style={{ fontSize: 8 }}>zerorouter</text>

      {/* outbound packets (CSS-animated) */}
      <g className="zr-motion" fill="var(--color-amber)">
        <circle className="zr-packet zout-1" r={2.6} cx={196} cy={104} />
        <circle className="zr-packet zout-2" r={2.6} cx={196} cy={104} />
        <circle className="zr-packet zout-3" r={2.6} cx={196} cy={104} />
      </g>

      {/* API clients */}
      <rect x={296} y={78} width={26} height={18} rx={4} fill="var(--color-panel-raised)" stroke="var(--color-hairline-strong)" />
      <circle cx={309} cy={87} r={2.4} fill="var(--color-ink-faint)" />
      <rect x={296} y={112} width={26} height={18} rx={4} fill="var(--color-panel-raised)" stroke="var(--color-hairline-strong)" />
      <rect x={302} y={119} width={14} height={4} rx={2} fill="var(--color-ink-faint)" />
      <text x={296} y={186} className="zr-label" style={{ fontSize: 8 }}>clients</text>
    </svg>
  );
}

export function LoginPage({
  session,
  healthOk,
  reloadSession,
}: {
  session: SessionInfo;
  healthOk: boolean | null;
  reloadSession: () => Promise<void>;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  // Validated internal return path. Sources: the `from` query parameter written
  // by the console guard, or the navigation `state` transfer (default /console).
  const fromRaw =
    (location.state as { from?: unknown } | null)?.from ??
    (new URLSearchParams(location.search).get('from') ?? undefined);
  const from = normalizeLoginReturn(fromRaw);

  const [notice, setNotice] = useState<string | null>(() => {
    try {
      const n = sessionStorage.getItem('zr_login_notice');
      if (n) sessionStorage.removeItem('zr_login_notice');
      return n;
    } catch {
      return null;
    }
  });
  const [status, setStatus] = useState<'idle' | 'verifying' | 'success'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);

  const usernameRequired = session.mode === 'database';
  const canSubmit = password.length > 0 && (!usernameRequired || username.trim().length > 0);

  // Stale authenticated state (or loopback mode) → straight to the console.
  // Gated on an idle form: right after a successful sign-in the session reload
  // must not clobber the validated `from` return-path navigation.
  useEffect(() => {
    if (status !== 'idle') return;
    if (session.authenticated || !session.password_required) navigate('/console', { replace: true });
  }, [session, navigate, status]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (status !== 'idle' || !canSubmit) return;
    setStatus('verifying');
    setError(null);
    try {
      // Real authentication only — success state waits for the server 2xx.
      await api.login(usernameRequired ? { username: username.trim(), password } : { password });
      setPassword('');
      setShowPw(false);
      await reloadSession();
      setStatus('success');
      navigate(from, { replace: true });
    } catch (err) {
      setStatus('idle');
      setError(err instanceof Error ? err.message : 'Sign-in failed. Try again.');
    }
  };

  const authLabel = session.mode === 'database' ? 'owner credential' : 'environment password';

  return (
    <main className="min-h-screen bg-canvas text-ink">
      <div className="grid min-h-screen lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
        {/* ── left showcase (desktop; status from live app state) ── */}
        <section className="zr-login-panel zr-login-a relative hidden flex-col justify-between border-r border-hairline bg-panel px-10 py-10 lg:flex xl:px-14">
          <div className="flex items-center gap-2.5">
            <div className="grid size-8 place-items-center rounded-md border border-amber/40 bg-amber/10">
              <Activity size={15} className="text-amber" />
            </div>
            <div>
              <div className="font-display text-[15.5px] font-semibold leading-4 tracking-tight">ZeroRouter</div>
              <div className="zr-label mt-0.5">gateway console</div>
            </div>
          </div>

          <div className="max-w-md">
            <h1 className="font-display text-[30px] font-semibold leading-[1.15] tracking-tight">
              Your models.
              <br />
              <span className="text-ink-dim">Your gateway.</span>
            </h1>
            <p className="mt-4 text-[13.5px] leading-relaxed text-ink-dim">
              One private, OpenAI-compatible endpoint in front of every provider you use. Keys, aliases,
              logs and settings stay sealed inside this single-owner console.
            </p>

            <GatewayFlow className="zr-motion mt-8 h-[208px] w-[360px]" />

            <div className="mt-6 flex flex-wrap gap-x-6 gap-y-2">
              <StatusChip
                label={`gateway ${healthOk === null ? 'checking' : healthOk ? 'online' : 'offline'}`}
                state={healthOk === null ? 'warn' : healthOk ? 'ok' : 'danger'}
              />
              <StatusChip label={`auth ${authLabel}`} state="ok" />
              <StatusChip label={session.secure_context ? 'remote host' : 'local host'} state="warn" />
            </div>
          </div>

          <div className="zr-label">private project · authorized access only</div>
        </section>

        {/* ── right: sign-in form ── */}
        <section className="relative flex min-h-screen flex-col items-center justify-center px-5 py-10 sm:px-10">
          <div className="w-full max-w-[360px]">
            <div className="zr-login-panel zr-login-b">
              <div className="mb-9 flex items-center gap-2.5 lg:hidden">
                <div className="grid size-8 place-items-center rounded-md border border-amber/40 bg-amber/10">
                  <Activity size={15} className="text-amber" />
                </div>
                <div>
                  <div className="font-display text-[15.5px] font-semibold leading-4 tracking-tight">ZeroRouter</div>
                  <div className="zr-label mt-0.5">gateway console</div>
                </div>
              </div>

              <h2 className="font-display text-2xl font-semibold tracking-tight">Welcome back.</h2>
              <p className="mt-1.5 text-[13.5px] text-ink-dim">Sign in to your private ZeroRouter dashboard.</p>

              {notice && (
                <div className="mt-6 flex items-start justify-between gap-3 rounded-md border border-cyan/40 bg-cyan/10 px-3 py-2 text-[12.5px] leading-relaxed text-cyan" role="status">
                  <span className="min-w-0 flex-1">{notice}</span>
                  <button
                    type="button"
                    aria-label="Dismiss notice"
                    onClick={() => setNotice(null)}
                    className="shrink-0 rounded p-0.5 text-cyan/70 transition-colors hover:text-cyan"
                  >
                    <X size={13} />
                  </button>
                </div>
              )}
              {error && (
                <div className="mt-6" role="alert">
                  <ErrorNote error={error} />
                </div>
              )}

              <form onSubmit={submit} className="mt-7 space-y-4" noValidate>
                {usernameRequired && (
                  <Field label="Owner username" hint="Provisioned locally via the owner CLI.">
                    <input
                      type="text"
                      className="zr-input"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      placeholder="owner"
                      autoComplete="username"
                      autoCapitalize="none"
                      spellCheck={false}
                      autoFocus
                    />
                  </Field>
                )}
                <Field
                  label="Password"
                  hint={usernameRequired ? 'Verified against your scrypt-hashed credential.' : 'Set via the deployment environment.'}
                >
                  <div className="relative">
                    <input
                      type={showPw ? 'text' : 'password'}
                      className="zr-input pr-10"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="••••••••••••"
                      autoComplete="current-password"
                      autoFocus={!usernameRequired}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPw((v) => !v)}
                      aria-label={showPw ? 'Hide password' : 'Show password'}
                      aria-pressed={showPw}
                      className="absolute right-1.5 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded text-ink-faint transition-colors hover:text-ink"
                    >
                      {showPw ? <EyeOff size={14} className="transition-transform" /> : <Eye size={14} className="transition-transform" />}
                    </button>
                  </div>
                </Field>

                <button
                  type="submit"
                  disabled={status !== 'idle' || !canSubmit}
                  className={`zr-btn zr-btn-accent !h-9 w-full justify-center text-[13px] transition-transform active:translate-y-px ${status === 'success' ? 'border-ok/60 text-ok' : ''}`}
                >
                  {status === 'verifying' ? (
                    <>
                      <Spinner className="border-t-amber" />
                      Verifying…
                    </>
                  ) : status === 'success' ? (
                    <>
                      <Check size={14} />
                      Welcome back
                    </>
                  ) : (
                    <>
                      <LogIn size={13} />
                      Sign in
                    </>
                  )}
                </button>
              </form>

              <p className="zr-label mt-7">
                private project · authorized access only
              </p>
            </div>
          </div>

          <footer className="zr-login-panel zr-login-c absolute inset-x-0 bottom-6 text-center text-[11.5px] text-ink-faint">
            ZeroRouter · © {new Date().getFullYear()} · Private project. Authorized access only.
          </footer>
        </section>
      </div>
    </main>
  );
}
