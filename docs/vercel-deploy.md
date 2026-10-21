# Deploying ZeroRouter on Vercel

ZeroRouter ships as **one serverless function** (the whole Hono API, wired
exactly like the always-on server via `runtime.ts`) plus the **static web
console** served from the CDN. With `ZEROROUTER_DATABASE_URL` pointed at
Postgres (Supabase), no local filesystem state is required, so serverless
works without caveats about ephemeral disks.

```
Browser ─┬─ /, /console/*, /assets/*, /favicon …  → static files (CDN)
         └─ /v1/*, /admin/*, /healthz             → api/index.ts (Node function)
                                                       └─ Postgres (Supabase)
```

What is already done in the repo — you only configure the platform:

- `vercel.json` — build (`npm run build`), static output
  (`packages/web/dist`), rewrites (`/v1/*`, `/admin/*`, `/healthz` → the
  function; everything else → the SPA), `maxDuration: 60`.
- `packages/server/src/serverless.ts` — cold-start wiring + hard guards:
  refuses to boot without `ZEROROUTER_DATABASE_URL` / `ZEROROUTER_MASTER_KEY`
  / a dashboard credential, so misconfiguration is a readable `boot_error`
  envelope instead of a broken stage.
- `api/index.ts` — caches the boot promise per warm instance and maps any
  boot failure into the gateway's error envelope.

## 1. Prerequisites

1. **A Supabase project** (or any Postgres). The migration runbook is
   `docs/postgres-migration.md`; the database must have been migrated (the
   serverless function applies pending migrations itself on cold start, so
   an empty database also self-settles).
2. **An owner credential provisioned in that database.** From your machine:

   ```powershell
   $env:ZEROROUTER_DATABASE_URL = "postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres"
   npm -w packages/server run owner -- set-owner
   ```

   Password policy: ≥ 10 chars (**12+ recommended**), NFKC-normalized; user
   names `3–32` chars of `[a-z0-9._@-]`. No public registration exists — this
   CLI step is the only way ownership is established.
3. **A fresh GitHub token** (fine-grained, Contents + Administration
   read/write, single repo) to push the project — and revoke it after the
   upload. `node scripts/github-upload.mjs`.

## 2. Vercel configuration

Import the GitHub repo as a new project, then set these **Environment
Variables** (Production + Preview):

| Variable | Required | Value |
| --- | --- | --- |
| `ZEROROUTER_DATABASE_URL` | ✅ | The **Transaction pooler** URL, port **6543**: `postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres`. Prepared statements are already disabled (`prepare: false`), which port 6543 requires. |
| `ZEROROUTER_MASTER_KEY` | ✅ | 32 raw bytes, base64 (44 chars): `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. Store it first in a password manager — **never regenerate it after provider credentials exist** (they would become undecryptable; fail-closed). |
| `ZEROROUTER_ALLOW_REMOTE` | ✅ | `true`. Also makes dashboard cookies `Secure` unconditionally. |
| `NODE_ENV` | ✅ | `production`. |
| `ZEROROUTER_TRUST_PROXY` | recommended | `true` — the login-throttle then keys on `x-forwarded-for` (Vercel is the trusted TLS front) and per-client cooldowns work per IP. |
| `ZEROROUTER_LOG_LEVEL` | optional | `info` (default), `error` for quieter logs. |

Never set `ZEROROUTER_WEB_DIST` — the CDN serves the console; the function
ignores it regardless.

**Region.** Project Settings → Functions → Region: pick the Supabase-adjacent
region (Supabase Mumbai `ap-south-1` → Vercel `bom1`). Single-region on all
plans.

Deploy. First build runs `npm run build` (web + server compile), then
`/v1/*`, `/admin/*`, `/healthz` are handled by the function and the rest by
the static console.

## 3. Verify

```bash
curl https://<your-app>.vercel.app/healthz
# {"ok":true,"service":"zerorouter","version":1,"env":"production","remote":true,...}
```

- Open `https://<your-app>.vercel.app/console` → login → owner session.
- The landing page and the console's model-explorer examples always show
  **your deployed origin** (they read `window.location` at runtime) — no
  configuration needed when the domain changes.
- Log in as the owner and run a playground request to exercise an upstream.

## 4. Honest limitations (serverless)

- **60 s request cap on Hobby** (`maxDuration` in `vercel.json`). Long
  generations streamed through `/v1/chat/completions` and slow provider
  discovery can be cut at the cap; Pro allows raising it.
- **The rate limiter is in-memory, per warm instance.** Limits are enforced
  per instance rather than globally; DB-backed parts (login throttle,
  sessions, keys) are unaffected.
- **No client IP without the proxy flag**: with `ZEROROUTER_TRUST_PROXY`
  unset, Vercel requests have no socket address, so throttling degrades to a
  shared bucket — set it.
- **Maintenance runs on cold start** (retention/pruning, best-effort). For
  strict retention, run the sweep locally against the same database, or just
  rely on the default 14-day retention.
- **Streams pass through unchanged** — the adapter returns the runtime's
  Response as-is; only platform caps apply.

## 5. Local verification of the serverless path

The exact function code is runnable locally without Vercel:

```powershell
$env:NODE_ENV = 'production'
$env:ZEROROUTER_ALLOW_REMOTE = 'true'
$env:ZEROROUTER_MASTER_KEY = '<44-char base64>'
$env:ZEROROUTER_DATABASE_URL = 'postgresql://…:6543/postgres'
node -e "import('./packages/server/dist/serverless.js').then(async m => {
  const rt = await m.createVercelHandler();
  const res = await rt.handle(new Request('http://localhost/healthz'));
  console.log(res.status, await res.text());
  await rt.db.close();
})"
```

(Requires `npm -w packages/server run build` first.)

## 6. Troubleshooting

- **`boot_error` envelope from `/healthz`** — read `error.message`: it names
  the missing variable (`ZEROROUTER_DATABASE_URL`, `ZEROROUTER_MASTER_KEY`,
  or no owner credential in the database).
- **403 `auth_required` on every admin mutation** — the CSRF cross-check
  compares the browser `Origin` with the request `Host`; both are preserved
  by Vercel. Only trigger: calling `/admin/*` cross-origin.
- **Cookie rejected / login loops** — `ZEROROUTER_ALLOW_REMOTE=true` must be
  set (it turns `Secure` on); the console must be opened over HTTPS (Vercel
  default).
</rfl:parameter> - **Provider credentials fail after re-deploy** — `ZEROROUTER_MASTER_KEY`
  changed after secrets were stored. Restore the original value; credentials
  are never re-encrypted automatically (fail-closed by design).
- **`ERR_REQUIRE_ESM` on cold start** — Vercel compiles `api/index.ts` to
  CommonJS, so a static `import` of the ES-module server build becomes an
  illegal `require()`. The loader must use native `import()` (already done in
  `api/index.ts`) and the root `package.json` must declare `"type": "module"`.
- **`/healthz` returning 504 / \"Connecting to gateway…\"** — the runtime
  must boot before the platform timeout. `/healthz` now answers with
  `{ ok, booting: true }` while the DB connect is in flight; if it stays
  `booting: true` past ~30 s, the function's network path to Supabase is
  stalled (check Supabase network restrictions and the function region).","oldString">- **Provider credentials fail after re-deploy** — `ZEROROUTER_MASTER_KEY`
  changed after secrets were stored. Restore the original value; credentials
  are never re-encrypted automatically (fail-closed by design).
