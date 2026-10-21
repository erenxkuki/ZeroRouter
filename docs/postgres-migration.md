# ZeroRouter — Postgres/Supabase storage migration plan

> Honest planning document — not yet implemented. Read the **Decision** section
> first: this is a viable path with a real cost, and it does **not** unlock
> serverless hosting by itself for the streaming parts of the product.
> Rewards and risks are listed so the choice can be made with numbers.

## 0. Decision summary

| | Today (node:sqlite) | After migration (Postgres via Supabase) |
|---|---|---|
| Data location | this machine only | Supabase region (any device/instance can serve) |
| Storage cost | free, included | free tier (500 MB DB) → $25/mo when growing |
| Hot-path latency | ~µs (in-process) | +1 network RTT per query (~5–30 ms same-region) |
| Gateway request overhead | 0 | **3+ RTTs per `/v1` request** (key auth, throttle read, log write) |
| Multi-instance / multi-host | ✗ (files are local) | ✓ possible later |
| Backups | manual file copy | automatic (Supabase daily backup) |
| Codebase change | — | 55 repo methods + 13 consumer files + 3 transactions + test harness |
| Effort estimate | — | **~24–36 focused hours (3–5 days)** |
| Deploy hosts after | any (needs persistent disk) | still needs **always-on** for SSE (Railway/Fly/VPS); Vercel *possible* for the API with `maxDuration` limits (see §7) |

**Not** covered by this plan: serving the DB through `/rest/v1/` (PostgREST).
PostgREST is a table-CRUD surface with no transactions, no multi-step RPC
semantics and no server-side secret handling — it cannot express owner
provisioning, login throttling or key-hash auth safely. The migration uses a
real Postgres **driver** (`postgres.js`) with a direct connection string.

## 1. What stays untouched

Adapters (anthropic / openai-compatible / openrouter / generic-rest), the
unified `/v1` surface, the web console and landing, crypto (`hashSecret`,
`encryptCredentials`), rate limiting (stays **in-memory**, per instance),
SSE relay mechanics, admin routes, owner CLI — all unchanged.

Encryption at rest moves cleanly: `ZEROROUTER_MASTER_KEY` (32 bytes, base64)
is **already supported** by `config.ts` as an alternative to the `.master_key`
file — set it as a platform secret, provider credentials stay AES-256-GCM
encrypted *inside* Postgres rows.

## 2. Phase plan (with real counts)

### Phase 1 — Supabase setup + schema (≈2–3 h)
1. Create the Supabase project (pick the region you'll host nearest).
2. Paste `schema.postgres.sql` (shipped next to this document) into the SQL
   editor. It is the translated `0001_init` + `0002` + `0003` set:
   - `INTEGER` ms-epoch timestamps → `BIGINT` (keeps all `Date.now()` logic intact),
   - 0/1 `CHECK` booleans → `SMALLINT CHECK (… IN (0,1))` (keeps repo logic unchanged),
   - `INTEGER PRIMARY KEY AUTOINCREMENT` → `BIGINT GENERATED ALWAYS AS IDENTITY`,
   - JSON stays `TEXT` by design (repos parse it themselves; JSONB is a later nicety).
3. Copy the **Session pooler** connection string (port 5432,
   `aws-0-<region>.pooler.supabase.com`) — it gives IPv4 + persistence for
   always-on hosts. The **Transaction pooler** (port 6543, `prepare: false`)
   is the serverless-mode string.

### Phase 2 — `Db` becomes async Postgres (≈8–12 h)
Replace `db/database.ts` internals with `postgres.js` (`npm i postgres`):

```ts
import postgres from 'postgres';
const sql = postgres(url, { prepare: false /* 6543 only */, max: 10, ssl: 'require' });
```

- `prepare(sql).run/get/all` (55 call shapes across 853 lines) → tagged
  templates: `await sql\`…where id = ${id}\``; result shaping stays identical
  (`run` → `sql…` returns counts via `result.count`; `.get` → `[row] ?? null`;
  `.all` → rows array).
- **Wait on POSTGRES_TYPES**: `postgres.js` auto-coerces `BIGINT` to string by
  default — set `types: { bigint: { to: 20, from: [20], serialize: v => v.toString(), parse: v => Number(v) } }`
  so ms-timestamps stay JS numbers, or audit every `.ts`/`expires_at` parse.
- `migrate()` re-runs the same `MIGRATIONS` ids against a
  `schema_migrations (version TEXT PRIMARY KEY, applied_at BIGINT)` table —
  the Supabase schema should be created through this runner (not the SQL
  editor) when the code lands, so prod and code agree.

### Phase 3 — transactions + executor injection (≈2–3 h)
3 transaction call sites (owner provisioning, …) become:

```ts
await sql.begin(async (tx) => { …repo methods… });
```

**Pattern:** every repo method gains an optional trailing `exec = this.sql`
parameter; transaction bodies pass `tx` down. Without this, inner calls would
silently escape the transaction (postgres.js's scoped client is not global).
The 55 method signatures change for this reason even where the query doesn't.

### Phase 4 — the 13 consumer files (≈3–5 h)
Everything that `await`s nothing today starts to: `middleware.ts`
(gateway-key auth — now +1 RTT per `/v1` request), `ownerAuth`, `sessions`,
`requestLogs` (consider fire-and-forget post-response writes to hide the log
RTT), `chatRuntime` (resolveTarget inside the request path), admin routes,
bootstrap. `crypto`, logger, adapters, sseRelay untouched.

### Phase 5 — test harness (≈6–10 h)
176 server tests; suites construct `new Db(…path…)` directly
(`auth.test.ts`, `authUnit.test.ts`, `repos.test.ts`, `integration.test.ts`, …).

- DB-free suites keep working as-is: `crypto`, `schemas`, `rate-limit`,
  `ssrf`, `sse-relay`, `openai-adapter` (mocked transport).
- DB suites need `TEST_DATABASE_URL`. Two options:
  a. **Local/disk Postgres via Docker Compose** for tests + CI (fast, free,
     no Supabase dependency in CI), or
  b. a dedicated Supabase project/branch + `TRUNCATE … CASCADE` between tests.
- Refresh pattern: one ephemeral **schema** per test file
  (`search_path` per connection), or truncate-between; assert on async
  boundaries — several tests will surface "forgot to await" bugs, which is
  the point.

### Phase 6 — config, docs, deploy adapters (≈3–4 h)
- `ZEROROUTER_DATABASE_URL` env (replaces data-dir DB; `ZEROROUTER_DATA_DIR`
  remains only for `.master_key` fallback web-dist discovery).
- Update `docs/security.md` §data-at-rest and the **`/privacy` page copy**:
  "all data lives on this machine" → "relational state lives in your Supabase
  project; provider secrets remain AES-encrypted locally before insert".
- Deploy adapters: `fly.toml`/`railway.json` (always-on, recommended) or
  `vercel.json` + `@hono/vercel` (see §7 limits).

## 3. Hot-path cost, concretely

A `/v1/chat/completions` request does: rate-limit check (memory ✓ free),
gateway-key auth (1 query), model resolve (1–2 queries), request-log insert
(1 query). Postgres adds ~10–60 ms same-region per call → **~30–150 ms added
per request**, i.e. on a 2 s LLM call ≈ 1–7 % overhead; on `/v1/models`
listing it's the dominant cost. Mitigations (optional, later): short-TTL
cache for key-hash auth (30 s), batch log writes.

## 4. Risks register

| Risk | Impact | Mitigation |
|---|---|---|
| Forgotten `await` in 13 files | silent races (session check after response) | TS `Promise` return Types + tests |
| Transaction scope escape via `this.sql` | half-provisioned owner (no session revoke) | executor param, integration test for provision→old-session-invalid |
| BIGINT→string coercion bugs | ms-timestamps arrive as "1792…" strings | global `types` mapping (§2) |
| Transaction-pooler connection churn | connection errors under burst | max pool 10 + retry; or session mode on always-on hosts |
| Rate limits per-instance only | N instances ≈ N× limits | documented; irrelevant for single-owner |
| Vercel function limits | streams >60 s (Hobby) cut | Pro + `maxDuration` ≤800 s, or always-on host |
| Supabase outage/rate limit | gateway down w/ the host | acceptable for a personal gateway; status page exists |

## 5. Rollback story

Keep the `node:sqlite` `Db` implementation in the tree behind the same
interface (`ZEROROUTER_DATABASE_URL` unset → local mode). Both storage
backends can coexist via a tiny interface split (`DbLike`), so the SQLite
option never disappears — this also keeps the owner CLI's `--data-dir`
provisioning story working for the offline path (CLI writes the same Postgres
when `DATABASE_URL` is set).

## 6. What I need from you to start

1. A Supabase **connection string** (Session mode) — set as
   `ZEROROUTER_DATABASE_URL` locally / as a platform secret on deploy. It is a
   secret: don't paste long-lived service keys into chat; paste is fine for a
   short-lived password you reset after.
2. The call: **always-on host (Railway/Fly) — recommended**, or Vercel with
   the §7 limitations accepted.

## 7. Vercel appendix

> **Implemented.** The adapter now ships in the repo (`api/index.ts`,
> `packages/server/src/serverless.ts`, `vercel.json`); the operative runbook
> is **docs/vercel-deploy.md**. Summary of the shape (as designed here):

- Single function mounting the whole Hono app via the shared `runtime.ts`
  wiring (identical to the always-on server); static web served by Vercel's
  CDN from `packages/web/dist`.
- Env: `ZEROROUTER_DATABASE_URL` (Transaction pooler 6543, `prepare: false`),
  `ZEROROUTER_MASTER_KEY`, `ZEROROUTER_ALLOW_REMOTE=true`,
  `ZEROROUTER_TRUST_PROXY=true`, `NODE_ENV=production`.
- `maxDuration`: Hobby caps streams around 60 s → slow models break; Pro
  (fluid) up to 800 s makes chat streaming workable. First-token latency
  includes a cold start (~1–3 s) unless on fluid compute.
- Console admin writes (provider discovery, key creation) work fine — they're
  short requests. **Model discovery against slow catalogs may hit the cap.**
- Verdict: functional on Pro, compromised on Hobby; always-on hosts remove the
  asterisks for ~$5/mo.
