/**
 * ZeroRouter public landing page. Charcoal canvas + amber/cyan accents, fully
 * animated but CSS-driven: aurora hero field, dual-track capability marquee,
 * IntersectionObserver scroll reveals, animated gateway flow (providers →
 * zerorouter → clients) and a demo request trace. Everything on this page is
 * public-safe — model rows on the explorer teaser are synthetic and clearly
 * labeled "demo"; the real registry is only ever rendered inside the
 * authenticated console.
 */
import { useCallback, useState } from 'react';
import { Link } from 'react-router';
import {
  ArrowRight,
  Check,
  Copy,
  Cpu,
  KeyRound,
  Lock,
  PlugZap,
  ShieldCheck,
  Shuffle,
  Waves,
} from 'lucide-react';
import { PublicShell } from '../components/PublicShell';
import { useReveal } from '../lib/reveal';
import type { SessionInfo } from '../api';

/* ─── hero status chips ─── */

function HealthChip({ ok }: { ok: boolean | null }) {
  const dot = ok === null ? 'bg-ink-faint' : ok ? 'bg-ok' : 'bg-danger';
  const label = ok === null ? 'checking gateway' : ok ? 'gateway online' : 'gateway offline';
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-hairline bg-panel/80 px-3 py-1 font-mono text-[10.5px] uppercase tracking-[0.14em] text-ink-dim">
      <span className={`size-1.5 rounded-full ${dot} ${ok === null ? '' : 'animate-pulse'}`} />
      {label}
    </span>
  );
}

function Chip({ tone, children }: { tone: 'amber' | 'cyan'; children: string }) {
  const map = {
    amber: 'border-amber/40 bg-amber/10 text-amber',
    cyan: 'border-cyan/40 bg-cyan/10 text-cyan',
  } as const;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 font-mono text-[10.5px] uppercase tracking-[0.14em] ${map[tone]}`}
    >
      {children}
    </span>
  );
}

/* ─── animated gateway flow (pure SVG + CSS packets) ─── */

function FlowViz() {
  const providers = ['anthropic', 'openai-compatible', 'openrouter'];
  const rows = [56, 120, 184];
  return (
    <svg viewBox="0 0 660 240" className="w-full max-w-2xl" role="img" aria-label="Requests flow from provider adapters through the ZeroRouter gateway to your apps">
      {/* providers */}
      {rows.map((y, i) => (
        <g key={`p${i}`}>
          <rect x={24} y={y - 20} width={112} height={40} rx={9} fill="#111418" stroke="#2a313a" />
          <text x={80} y={y + 4} textAnchor="middle" fontSize={11} fill="#9aa3ad" fontFamily="JetBrains Mono Variable, monospace">
            {providers[i]}
          </text>
          <line x1={136} y1={y} x2={252} y2={y} stroke="#2a313a" strokeDasharray="3 5" />
          <circle className={`zr-land-packet pin-${i + 1}`} cx={136} cy={y} r={3.5} fill="#35d0e0" />
        </g>
      ))}

      {/* gateway */}
      <circle className="zr-land-ring" cx={300} cy={120} r={54} fill="none" stroke="rgba(245,178,60,0.4)" strokeWidth={1.5} />
      <rect x={252} y={54} width={96} height={132} rx={12} fill="#161a20" stroke="rgba(245,178,60,0.5)" style={{ filter: 'drop-shadow(0 0 14px rgba(245,178,60,0.18))' }} />
      <text x={300} y={126} textAnchor="middle" fontSize={13} fontWeight={620} fill="#e8eaed" fontFamily="Archivo Variable, sans-serif">
        ZeroRouter
      </text>
      <text x={300} y={205} textAnchor="middle" fontSize={9.5} fill="#5c6672" fontFamily="JetBrains Mono Variable, monospace" letterSpacing={2}>
        GATEWAY
      </text>

      {/* clients */}
      {[76, 164].map((y, i) => (
        <g key={`c${i}`}>
          <line x1={348} y1={y} x2={520} y2={y} stroke="#2a313a" strokeDasharray="3 5" />
          <rect x={520} y={y - 20} width={112} height={40} rx={9} fill="#111418" stroke="#2a313a" />
          <text x={576} y={y + 4} textAnchor="middle" fontSize={11} fill="#9aa3ad" fontFamily="JetBrains Mono Variable, monospace">
            {i === 0 ? 'your app' : 'your script'}
          </text>
        </g>
      ))}
      {/* replies: amber packets leaving the gateway toward clients */}
      <circle className="zr-land-packet pout-1" cx={136} cy={76} r={3.5} fill="#f5b23c" />
      <circle className="zr-land-packet pout-2" cx={136} cy={164} r={3.5} fill="#f5b23c" />
      <circle className="zr-land-packet pout-3" cx={136} cy={76} r={3.5} fill="#f5b23c" opacity={0.7} />
    </svg>
  );
}

/* ─── demo request trace ─── */

function TraceCard() {
  return (
    <div className="zr-tracebox w-full max-w-2xl overflow-hidden rounded-[10px] border border-hairline bg-[#0a0c0e] text-left">
      <div className="flex items-center justify-between border-b border-hairline px-3.5 py-2">
        <span className="zr-label">request trace</span>
        <span className="rounded border border-cyan/40 bg-cyan/10 px-1.5 py-0.5 font-mono text-[9.5px] uppercase tracking-wider text-cyan">
          demo
        </span>
      </div>
      <div className="space-y-1.5 px-3.5 py-3 font-mono text-[11.5px] leading-relaxed">
        <div className="zr-trace text-ink-dim" style={{ ['--td' as string]: '80ms' }}>
          <span className="text-ink-faint">$ </span>POST /v1/chat/completions
        </div>
        <div className="zr-trace text-ink-dim" style={{ ['--td' as string]: '620ms' }}>
          <span className="text-cyan">→ </span>model: provider/model
          <span className="text-ink-faint"> — or an alias, e.g. fast-chat</span>
        </div>
        <div className="zr-trace text-ink-dim" style={{ ['--td' as string]: '1160ms' }}>
          <span className="text-amber">← </span>200 OK · stream · 1.82s · logged locally
        </div>
        <div className="zr-trace" style={{ ['--td' as string]: '1700ms' }}>
          <span className="zr-caret text-cyan">▌</span>
        </div>
      </div>
    </div>
  );
}

/* ─── capability marquee ─── */

const MARQUEE = [
  'Unified OpenAI-compatible API',
  'Model discovery',
  'SSE streaming',
  'SSRF-hardened transport',
  'Aliases & explicit fallbacks',
  'Credentials encrypted at rest',
  'Per-key rate limits',
  'Local request logs',
  'Private owner-only access',
];

function Marquee() {
  const items = [...MARQUEE, ...MARQUEE];
  return (
    <div className="zr-marquee border-y border-hairline bg-panel/40 py-3.5" aria-hidden>
      <div className="zr-marquee-track">
        {items.map((m, i) => (
          <span key={i} className="flex items-center gap-2 whitespace-nowrap font-mono text-[10.5px] uppercase tracking-[0.22em] text-ink-dim">
            {m}
            <span className="text-amber/60">✦</span>
          </span>
        ))}
      </div>
    </div>
  );
}

/* ─── features ─── */

const FEATURES = [
  {
    icon: PlugZap,
    title: 'One unified API',
    body: 'Add any provider, call any model from one OpenAI-compatible endpoint. GET /v1/models is your live registry — newly discovered models appear without touching your app.',
    points: ['/v1/chat/completions + /v1/models', 'provider/model ids and aliases', 'stream: true → SSE'],
  },
  {
    icon: Cpu,
    title: 'Providers & discovery',
    body: 'Built-in adapters for OpenAI-compatible APIs, Anthropic, OpenRouter and generic REST. Discovery pulls the real model list straight from the upstream catalog.',
    points: ['automatic model discovery', 'manual registration for oddballs', 'connection test + event history'],
  },
  {
    icon: Shuffle,
    title: 'Routing without surprises',
    body: 'Aliases resolve to one provider/model. Fallbacks exist only where you configure them explicitly — unknown, disabled or conflicting routes fail loudly with helpful errors.',
    points: ['alias → provider/model', 'explicitly configured fallbacks', 'rate limits per gateway key'],
  },
  {
    icon: ShieldCheck,
    title: 'Private, owner-only',
    body: 'No sign-up, no shared tenancy. The dashboard is gated by your scrypt-verified owner credential; gateway keys are separate bearer credentials for your programs.',
    points: ['dashboard session ≠ gateway key', 'upstream secrets encrypted at rest', 'logs stay on this machine'],
  },
];

/* ─── one-api section (multi-language, real base URL at runtime) ─── */

type Snippet = { id: string; label: string; text: string };

function buildSnippets(origin: string): Snippet[] {
  const base = `${origin}/v1/chat/completions`;
  return [
    {
      id: 'curl',
      label: 'curl',
      text:
        `curl ${base} \\\n` +
        `  -H "Authorization: Bearer zr_YOUR_GATEWAY_KEY" \\\n` +
        `  -H "Content-Type: application/json" \\\n` +
        `  -d '{\n` +
        `    "model": "provider/model",\n` +
        `    "messages": [{"role": "user", "content": "Hello!"}],\n` +
        `    "stream": true\n` +
        `  }'`,
    },
    {
      id: 'python',
      label: 'Python',
      text:
        `import os\nimport requests\n\nr = requests.post(\n    "${base}",\n    headers={"Authorization": f"Bearer {os.environ['ZEROROUTER_KEY']}"},\n    json={\n        "model": "provider/model",\n        "messages": [{"role": "user", "content": "Hello!"}],\n        "stream": False,\n    },\n    timeout=120,\n)\nprint(r.json()["choices"][0]["message"]["content"])`,
    },
    {
      id: 'ts',
      label: 'TypeScript',
      text:
        `// One API for every provider you saved in the console.\nconst res = await fetch(\n  "${base}",\n  {\n    method: "POST",\n    headers: {\n      Authorization: \`Bearer \${gatewayKey}\`, // zr_… · separate from console login\n      "Content-Type": "application/json",\n    },\n    body: JSON.stringify({\n      model: "provider/model", // or a configured alias\n      messages: [{ role: "user", content: "Hello!" }],\n      stream: true,             // SSE\n    }),\n  },\n);\nconsole.log(await res.text()); // or consume the SSE stream`,
    },
  ];
}

function CodeTabs() {
  // The deployed base URL is injected at runtime — the same page shows the
  // right origin whether it runs on localhost, a LAN box, or a public deploy.
  const [origin] = useState(() => (typeof window === 'undefined' ? 'http://localhost:8787' : window.location.origin));
  const [tab, setTab] = useState('curl');
  const [copied, setCopied] = useState(false);
  const snippets = buildSnippets(origin);
  const snippet = snippets.find((s) => s.id === tab) ?? snippets[0];

  const copy = useCallback(() => {
    void navigator.clipboard?.writeText(snippet.text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    });
  }, [snippet.text]);

  return (
    <div className="zr-reveal" style={{ ['--d' as string]: '120ms' }}>
      <div className="flex flex-wrap items-center justify-between gap-2 pb-2">
        <div className="flex gap-1.5" role="tablist" aria-label="API example language">
          {snippets.map((s) => (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={tab === s.id}
              className={`zr-btn !px-3 ${tab === s.id ? 'zr-btn-accent' : ''}`}
              onClick={() => setTab(s.id)}
            >
              {s.label}
            </button>
          ))}
        </div>
        <button type="button" className="zr-btn zr-btn-cyan" onClick={copy}>
          {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="zr-code m-0 max-h-[380px] overflow-auto px-4 py-3.5 text-[12px]">
        <code>{snippet.text}</code>
      </pre>
      <p className="mt-2.5 text-[12px] leading-relaxed text-ink-faint">
        <span className="font-mono uppercase tracking-wider text-amber/80">model</span> uses the registry
        id <code className="text-ink-dim">provider/model</code> — or an alias you configured. Keys are
        bearer credentials (<span className="font-mono">zr_…</span>) created in{' '}
        <Link to="/console/keys" className="text-cyan underline-offset-2 hover:underline">
          Gateway keys
        </Link>
        ; they are separate from your console sign-in.
      </p>
    </div>
  );
}

/* ─── demo model explorer teaser (synthetic, labeled) ─── */

const DEMO_MODELS = [
  { id: 'demo/router-fast', provider: 'demo', status: 'verified', caps: ['stream', 'tools'], ctx: '200k', alias: 'fast-chat' },
  { id: 'demo/router-reason', provider: 'demo', status: 'verified', caps: ['stream', 'reasoning'], ctx: '128k', alias: 'deep-think' },
  { id: 'demo/router-sqlite', provider: 'demo', status: 'untested', caps: ['stream'], ctx: '32k', alias: '—' },
];

function DemoExplorer() {
  return (
    <div className="zr-reveal relative" style={{ ['--d' as string]: '120ms' }}>
      <div className="overflow-hidden rounded-[10px] border border-hairline bg-panel">
        <div className="flex items-center justify-between gap-2 border-b border-hairline px-3.5 py-2.5">
          <span className="zr-label">model explorer — your live registry</span>
          <span className="rounded border border-amber/40 bg-amber/10 px-1.5 py-0.5 font-mono text-[9.5px] uppercase tracking-wider text-amber">
            demo data
          </span>
        </div>
        <table className="zr-table text-[12.5px]">
          <thead>
            <tr>
              <th>Status</th>
              <th>Model id</th>
              <th>Provider</th>
              <th>Capabilities</th>
              <th>Context</th>
              <th>Alias</th>
            </tr>
          </thead>
          <tbody>
            {DEMO_MODELS.map((m) => (
              <tr key={m.id}>
                <td>
                  <span
                    className={`inline-block size-1.5 rounded-full ${m.status === 'verified' ? 'bg-ok' : 'bg-ink-faint'}`}
                  />
                </td>
                <td className="font-mono">{m.id}</td>
                <td className="text-ink-dim">{m.provider}</td>
                <td>
                  <span className="flex flex-wrap gap-1">
                    {m.caps.map((c) => (
                      <span
                        key={c}
                        className="rounded border border-cyan/30 bg-cyan/10 px-1.5 py-0.5 font-mono text-[9.5px] uppercase tracking-wider text-cyan"
                      >
                        {c}
                      </span>
                    ))}
                  </span>
                </td>
                <td className="zr-num text-ink-dim">{m.ctx}</td>
                <td className="font-mono text-[11.5px] text-amber/90">{m.alias}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2.5 text-[12px] leading-relaxed text-ink-faint">
        Synthetic rows, shown for layout only. <span className="text-ink-dim">Your real provider inventory,
        registry and configuration are never rendered on this public page</span> — the live explorer lives
        inside the authenticated console.
      </p>
    </div>
  );
}

/* ─── page ─── */

export function LandingPage({ session, healthOk }: { session: SessionInfo | null; healthOk: boolean | null }) {
  useReveal();
  const authed = session?.authenticated === true;
  const consoleHref = authed ? '/console' : '/login?from=%2Fconsole';

  return (
    <PublicShell session={session}>
      {/* ── hero ── */}
      <section className="relative overflow-hidden">
        <div className="zr-aurora">
          <span className="zr-aurora-blob b1" />
          <span className="zr-aurora-blob b2" />
          <span className="zr-aurora-blob b3" />
        </div>
        <div className="relative z-10 mx-auto flex max-w-6xl flex-col items-center px-6 pb-16 pt-20 text-center md:pt-28">
          <div className="zr-reveal flex flex-wrap items-center justify-center gap-2">
            <HealthChip ok={healthOk} />
            <Chip tone="amber">Owner-only access</Chip>
            <Chip tone="cyan">OpenAI-compatible</Chip>
          </div>
          <h1
            className="zr-reveal mt-7 max-w-4xl font-display font-[620] leading-[1.04] tracking-[-0.035em]"
            style={{ ['--d' as string]: '60ms', fontSize: 'clamp(2.6rem, 6.5vw, 4.6rem)' }}
          >
            Your models. Your gateway.
            <br />
            <span className="zr-gradient-text">One API.</span>
          </h1>
          <p
            className="zr-reveal mt-6 max-w-2xl text-[15.5px] leading-relaxed text-ink-dim"
            style={{ ['--d' as string]: '140ms' }}
          >
            ZeroRouter is a private AI gateway you run yourself. Add the providers
            you already have, and every model they carry becomes reachable through a
            single OpenAI-compatible endpoint — discovered automatically, scoped by
            your aliases, logged locally, visible to nobody else.
          </p>
          <div className="zr-reveal mt-8 flex flex-wrap items-center justify-center gap-3" style={{ ['--d' as string]: '220ms' }}>
            <Link to={consoleHref} className="zr-cta" aria-label="Open the owner console">
              {authed ? 'Open the console' : 'Enter the console'}
              <ArrowRight size={15} />
            </Link>
            <a href="/#one-api" className="zr-cta-ghost">
              <Waves size={15} className="text-cyan" />
              See the API
            </a>
          </div>

          <div className="zr-reveal mt-14 flex w-full flex-col items-center gap-5" style={{ ['--d' as string]: '300ms' }}>
            <div className="zr-floaty flex w-full justify-center">
              <FlowViz />
            </div>
            <TraceCard />
          </div>
        </div>
      </section>

      <Marquee />

      {/* ── features ── */}
      <section id="features" className="mx-auto max-w-6xl scroll-mt-20 px-6 py-20">
        <div className="zr-reveal max-w-2xl">
          <div className="zr-label mb-3">Features</div>
          <h2 className="font-display text-[clamp(1.7rem,3.6vw,2.4rem)] font-[620] leading-[1.1] tracking-[-0.03em]">
            The gateway does the boring parts<span className="text-amber">.</span>
          </h2>
        </div>
        <div className="mt-10 grid gap-4 sm:grid-cols-2">
          {FEATURES.map((f, i) => (
            <article key={f.title} className="zr-reveal zr-land-card p-6 text-left" style={{ ['--d' as string]: `${i * 90}ms` }}>
              <div className="mb-4 inline-grid size-9 place-items-center rounded-lg border border-amber/25 bg-amber/10">
                <f.icon size={17} className="text-amber" />
              </div>
              <h3 className="font-display text-[16.5px] font-[620] tracking-[-0.015em]">{f.title}</h3>
              <p className="mt-2 text-[13.5px] leading-relaxed text-ink-dim">{f.body}</p>
              <ul className="mt-4 space-y-1.5">
                {f.points.map((p) => (
                  <li key={p} className="flex items-center gap-2 font-mono text-[10.5px] uppercase tracking-[0.12em] text-cyan/90">
                    <span className="text-amber/70">▸</span>
                    {p}
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </section>

      {/* ── one api ── */}
      <section id="one-api" className="relative scroll-mt-20 overflow-hidden border-y border-hairline bg-panel/50 py-20">
        <div className="mx-auto grid max-w-6xl items-start gap-12 px-6 lg:grid-cols-[1fr_1.25fr]">
          <div className="zr-reveal">
            <div className="zr-label mb-3">One API</div>
            <h2 className="font-display text-[clamp(1.7rem,3.6vw,2.4rem)] font-[620] leading-[1.1] tracking-[-0.03em]">
              Save a key once.
              <br />
              <span className="text-cyan">Call everything</span> after.
            </h2>
            <p className="mt-5 text-[14.5px] leading-relaxed text-ink-dim">
              Point any OpenAI-compatible tool at your ZeroRouter and it stops
              caring where the model actually lives. Switch a model behind a
              favorite alias or move a provider upstream — your app code doesn't
              change.
            </p>
            <ul className="mt-6 space-y-3.5">
              {[
                { icon: KeyRound, text: 'Gateway keys are bearer credentials; browser sessions never mix into API calls' },
                { icon: Lock, text: 'Upstream provider secrets stay server-side, encrypted at rest' },
                { icon: Waves, text: 'Streaming Server-Sent Events, normalized errors, explicit fallbacks' },
              ].map(({ icon: Icon, text }) => (
                <li key={text} className="flex items-start gap-3 text-[13.5px] leading-relaxed text-ink-dim">
                  <span className="mt-0.5 inline-grid size-6 shrink-0 place-items-center rounded-md border border-hairline-strong bg-panel-raised">
                    <Icon size={12.5} className="text-amber" />
                  </span>
                  {text}
                </li>
              ))}
            </ul>
          </div>
          <CodeTabs />
        </div>
      </section>

      {/* ── models ── */}
      <section id="models" className="mx-auto max-w-6xl scroll-mt-20 px-6 py-20">
        <div className="grid items-start gap-12 lg:grid-cols-[1fr_1.25fr]">
          <div className="zr-reveal">
            <div className="zr-label mb-3">Model explorer</div>
            <h2 className="font-display text-[clamp(1.7rem,3.6vw,2.4rem)] font-[620] leading-[1.1] tracking-[-0.03em]">
              Your registry, <span className="text-amber">searchable</span>.
            </h2>
            <p className="mt-5 text-[14.5px] leading-relaxed text-ink-dim">
              Every discovered or manually registered model lands in the explorer
              with what was actually verified against the upstream: streaming, tool
              support, reasoning, context size and pricing. Aliases are shown next
              to the routes they serve. Search, filter by provider, refresh after
              discovery.
            </p>
            <div className="mt-7 flex flex-wrap gap-2.5">
              <Link to={consoleHref} className="zr-cta-ghost">
                <ArrowRight size={14} />
                {authed ? 'Explore your models' : 'Sign in to explore'}
              </Link>
            </div>
          </div>
          <DemoExplorer />
        </div>
      </section>
    </PublicShell>
  );
}
