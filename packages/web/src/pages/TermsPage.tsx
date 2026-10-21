/**
 * Terms of Service — honest, owner-shaped terms for a private personal
 * project. No company, pricing or partnership claims that this software does
 * not make.
 */
import { Link } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import { PublicShell } from '../components/PublicShell';
import type { SessionInfo } from '../api';

export function TermsPage({ session }: { session: SessionInfo | null }) {
  return (
    <PublicShell session={session}>
      <main className="mx-auto max-w-3xl px-6 py-14">
        <Link to="/" className="inline-flex items-center gap-1.5 text-[13px] text-ink-dim transition-colors hover:text-ink">
          <ArrowLeft size={14} /> Back to home
        </Link>
        <article className="zr-doc mt-6">
          <h1 className="font-display text-[clamp(1.8rem,4vw,2.6rem)] font-[620] tracking-[-0.03em]">Terms of Service</h1>
          <p className="mt-2 text-ink-faint">Last reviewed: {new Date().getFullYear()}</p>

          <h2>1. What this service is</h2>
          <p>
            ZeroRouter is a private, self-hosted AI gateway. It is the personal
            tool of its operator ("the owner") and access is restricted to that
            authorized owner. It is not offered to third parties, no accounts can
            be created by visitors, and there is no commercial service, subscription or
            organization behind it.
          </p>

          <h2>2. Authorized use</h2>
          <ul>
            <li>The owner configures providers, aliases, models and gateway keys, and uses them for the owner's own requests.</li>
            <li>Gateway keys (<code>zr_…</code>) grant programmatic access to this gateway. They are secrets: treat them like passwords, revoke them when leaked and rotate them regularly.</li>
            <li>The gateway must not be used to attack, overload or bypass the terms of any upstream provider.</li>
          </ul>

          <h2>3. Upstream providers, their terms and quotas</h2>
          <p>
            Every AI provider that ZeroRouter routes to was added — and is paid
            for — by the owner, under that provider's own account, terms of
            service, quotas and rate limits. ZeroRouter does not resell,
            redistribute or re-bill anyone's access. If an upstream provider
            restricts, changes or terminates access, its decision governs and
            ZeroRouter will surface the upstream error.
          </p>

          <h2>4. Model availability</h2>
            <ul>
            <li>The model list is whatever the owner's configured providers report — discovered live or registered manually. ZeroRouter does not fabricate availability.</li>
            <li>Upstream catalogs change without notice; a model that existed at discovery time may later fail. Routing errors for unknown, disabled or conflicting models are intentional and explicit.</li>
            <li>Fallbacks only exist where the owner configured them explicitly. Nothing switches silently.</li>
          </ul>

          <h2>5. Service limitations</h2>
          <ul>
            <li>ZeroRouter is provided as-is, with no uptime or performance guarantee, no SLA and no support desk.</li>
            <li>Features, defaults and configuration may change at any time as the owner develops the project.</li>
            <li>Protective built-in rate limits exist per gateway key; errors resulting from upstream provider limits are clearly labeled.</li>
          </ul>

          <h2>6. Liability and changes</h2>
          <p>
            To the fullest extent permitted by law, the software is provided
            without warranties, and the author's liability is limited to nothing
            beyond what applicable law requires. These terms are updated as the
            project evolves; the version in the repository at the time of your
            access is the version that applies.
          </p>
          <p className="!mt-8 text-ink-faint">
            Questions about this document belong to the owner only. See also the{' '}
            <Link to="/privacy" className="text-cyan underline-offset-2 hover:underline">
              Privacy Policy
            </Link>
            .
          </p>
        </article>
      </main>
    </PublicShell>
  );
}
