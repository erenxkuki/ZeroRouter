/**
 * Shared chrome for the public pages (landing, terms, privacy): fixed glass
 * nav with scrolled state, and the footer carrying the terms/privacy links,
 * dynamic-year copyright and the private-project notice. Auth-aware: the
 * console CTA offers the dashboard to a signed-in owner and a safe-redirect
 * login link to everyone else. Public pages render no private data.
 *
 * A repository link is intentionally absent until a real repository URL is
 * configured — the footer never invents one.
 */
import { type ReactNode, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Activity, ArrowUpRight } from 'lucide-react';
import type { SessionInfo } from '../api';

export function useScrolledNav(): boolean {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  return scrolled;
}

export const YEAR = new Date().getFullYear();

export function PublicFooter() {
  return (
    <footer className="border-t border-hairline bg-panel/60">
      <div className="mx-auto grid max-w-6xl gap-10 px-6 py-12 md:grid-cols-[1.4fr_1fr_1.2fr]">
        <div>
          <div className="flex items-center gap-2.5">
            <span className="grid size-8 place-items-center rounded-md border border-amber/40 bg-amber/10">
              <Activity size={15} className="text-amber" />
            </span>
            <span className="font-display text-[16px] font-semibold tracking-tight">
              Zero<span className="text-amber">Router</span>
            </span>
          </div>
          <p className="mt-3 max-w-[300px] text-[13px] leading-relaxed text-ink-dim">
            A private, single-gateway AI router. Your providers, your keys, one
            OpenAI-compatible endpoint.
          </p>
        </div>
        <nav aria-label="Footer">
          <div className="zr-label mb-3">Site</div>
          <ul className="space-y-2 text-[13.5px]">
            <li>
              <Link className="text-ink-dim transition-colors hover:text-ink" to="/">
                Home
              </Link>
            </li>
            <li>
              <Link className="text-ink-dim transition-colors hover:text-ink" to="/terms">
                Terms of Service
              </Link>
            </li>
            <li>
              <Link className="text-ink-dim transition-colors hover:text-ink" to="/privacy">
                Privacy Policy
              </Link>
            </li>
            <li>
              <Link className="inline-flex items-center gap-1 text-ink-dim transition-colors hover:text-ink" to="/console">
                Console
                <ArrowUpRight size={13} className="text-ink-faint" />
              </Link>
            </li>
          </ul>
        </nav>
        <div>
          <div className="zr-label mb-3">Ownership</div>
          <p className="text-[13px] leading-relaxed text-ink-dim">
            ZeroRouter is a private, personal project. Access is restricted to
            its authorized owner.
          </p>
          <p className="mt-3 text-[12.5px] text-ink-faint">
            © {YEAR} ZeroRouter. All rights reserved.
          </p>
        </div>
      </div>
    </footer>
  );
}

export function PublicShell({ session, children }: { session: SessionInfo | null; children: ReactNode }) {
  const scrolled = useScrolledNav();
  const authed = session?.authenticated === true;
  return (
    <div className="flex min-h-screen flex-col bg-canvas text-ink">
      <header
        className={`zr-land-nav fixed inset-x-0 top-0 z-40 border-b border-transparent ${scrolled ? 'scrolled' : ''}`}
      >
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-6">
          <Link to="/" className="flex items-center gap-2.5" aria-label="ZeroRouter home">
            <span className="grid size-8 place-items-center rounded-md border border-amber/40 bg-amber/10">
              <Activity size={15} className="text-amber" />
            </span>
            <span className="font-display text-[15.5px] font-semibold tracking-tight">
              Zero<span className="text-amber">Router</span>
            </span>
          </Link>
          <nav aria-label="Primary" className="hidden items-center gap-7 text-[13.5px] text-ink-dim md:flex">
            <a className="transition-colors hover:text-ink" href="/#features">
              Features
            </a>
            <a className="transition-colors hover:text-ink" href="/#one-api">
              One API
            </a>
            <a className="transition-colors hover:text-ink" href="/#models">
              Models
            </a>
            <a className="transition-colors hover:text-ink" href="/terms">
              Terms
            </a>
          </nav>
          <div className="flex items-center gap-2.5">
            {authed ? (
              <Link to="/console" className="zr-cta !px-4 !py-2 !text-[12.5px]">
                Open console
              </Link>
            ) : (
              <Link
                to="/login?from=%2Fconsole"
                className="zr-cta !px-4 !py-2 !text-[12.5px]"
                aria-label="Sign in to open the console"
              >
                Sign in
              </Link>
            )}
          </div>
        </div>
      </header>
      <div className="flex-1 pt-14">{children}</div>
      <PublicFooter />
    </div>
  );
}
