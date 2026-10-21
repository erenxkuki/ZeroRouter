/**
 * Privacy Policy — describes what the running implementation actually does:
 * storage on SQLite or the configured Postgres instance, scrypt-hashed
 * credentials, AES-encrypted upstream secrets, differential logging with
 * opt-in request bodies, and pruning. No invented guarantees beyond what the
 * code enforces.
 */
import { Link } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import { PublicShell } from '../components/PublicShell';
import type { SessionInfo } from '../api';

export function PrivacyPage({ session }: { session: SessionInfo | null }) {
  return (
    <PublicShell session={session}>
      <main className="mx-auto max-w-3xl px-6 py-14">
        <Link to="/" className="inline-flex items-center gap-1.5 text-[13px] text-ink-dim transition-colors hover:text-ink">
          <ArrowLeft size={14} /> Back to home
        </Link>
        <article className="zr-doc mt-6">
          <h1 className="font-display text-[clamp(1.8rem,4vw,2.6rem)] font-[620] tracking-[-0.03em]">Privacy Policy</h1>
          <p className="mt-2 text-ink-faint">Last reviewed: {new Date().getFullYear()}</p>

          <h2>1. Where data lives</h2>
          <p>
            ZeroRouter is self-hosted. Everything it stores lives in a database
            you control: an SQLite file under <code>ZEROROUTER_DATA_DIR</code>{' '}
            (default <code>./data</code>) by default, or the Postgres instance
            you configure via <code>ZEROROUTER_DATABASE_URL</code> — for
            example your own Supabase project. There is no third-party
            analytics, no telemetry and no account system. The only network
            calls the gateway makes are the ones you cause: routing chat
            requests to the upstream providers you configured, model discovery
            against them, and (in hosted deployments) talking to the database
            you pointed it at.
          </p>

          <h2>2. Credentials and how they are handled</h2>
          <ul>
            <li>
              <strong>Owner sign-in.</strong> A single owner credential is
              provisioned through the owner CLI (shell access to the machine
              that stores the data — there is no HTTP path to provisioning).
              Only the username and a scrypt salted hash are stored in the
              gateway database — the plaintext password is never persisted,
              logged or sent anywhere.
            </li>
            <li>
              <strong>Dashboard sessions.</strong> Sign-in creates a server-side
              session; the browser only receives an httpOnly cookie with
              SameSite=Strict. tokens are not kept in browser storage, and
              sessions can be revoked or expired server-side.
            </li>
            <li>
              <strong>Gateway API keys.</strong> Keys (<code>zr_…</code>) are
              displayed once at creation and stored as a scrypt hash plus a short
              prefix used for lookup. Plaintext keys cannot be recovered later —
              only revoked, deleted, expired or replaced.
            </li>
            <li>
              <strong>Upstream provider credentials.</strong> Secrets you enter
              for providers (API keys for Anthropic, OpenAI-compatible endpoints,
              etc.) are AES-encrypted at rest with a master key taken from the
              <code>ZEROROUTER_MASTER_KEY</code> secret or from the data
              directory — never from the database. They are decrypted only in
              memory when a request is routed.
            </li>
          </ul>

          <h2>3. Request routing to upstream providers</h2>
          <p>
            When the owner (or a program holding a gateway key) calls{' '}
            <code>/v1/chat/completions</code>, ZeroRouter validates the request,
            resolves the model, and forwards it server-side to the configured
            provider. The browser console is never in the request path. The
            upstream provider therefore sees the prompt you send it and its own
            normal response — under the owner's account and that provider's
            privacy policies, which govern their handling of your prompts.
          </p>

          <h2>4. Logging</h2>
          <ul>
            <li>
              The gateway writes request logs to its database: timestamp, model
              id, provider, status, latency and token usage.
            </li>
            <li>
              Full request and response bodies are recorded <em>only</em> when
              the owner explicitly enables <code>debug_log_request_bodies</code>.
            </li>
            <li>
              Logs are pruned automatically — by default after 14 days
              (configurable) — and can be cleared at any time from the console.
            </li>
          </ul>

          <h2>5. Deletion</h2>
          <p>
            Everything is deletable: request logs (immediately, from the
            console), individual keys, aliases, models or providers, sessions
            (sign-out or server-side revocation). Removing the owner credential
            is done through the owner CLI. Deleting the data directory removes
            all local state; in the Postgres mode, dropping the database (or
            the gateway's tables) removes all hosted state. Deleting upstream
            account data remains subject to the relevant provider's own
            process.
          </p>

          <h2>6. What this policy does not do</h2>
          <p>
            This is a personal project, not a data-processing service: there are
            no other users, no shared infrastructure and no cross-border
            transfer machinery operated by ZeroRouter. Details of what any
            upstream provider does with prompts are defined by that provider's
            own policies. See also the{' '}
            <Link to="/terms" className="text-cyan underline-offset-2 hover:underline">
              Terms of Service
            </Link>
            .
          </p>
        </article>
      </main>
    </PublicShell>
  );
}
