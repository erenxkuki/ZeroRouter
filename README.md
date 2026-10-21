# ZeroRouter

A personal AI API gateway. Connect model providers once, then serve every client
through one normalized OpenAI-compatible endpoint — `POST /v1/chat/completions` —
with streaming, stable aliases, per-key rate limits, request logs, and a local
management console.

ZeroRouter is designed as **personal infrastructure**: by default it listens on
`127.0.0.1` only, keeps secrets out of the browser, and refuses to call network
locations you did not authorize (SSRF-hardened transport).

```
                  ┌───────────────────────────────┐
  clients ───────▶│  ZeroRouter gateway (:8787)   │────▶ openai-compatible
                  │  /v1/*      (gateway keys)    │────▶ openrouter
  dashboard ─────▶│  /admin/*   (session+CSRF)    │────▶ anthropic
                  │  model routing · limits · logs│────▶ generic-rest
                  └───────────────────────────────┘
```

## Feature map

| Area | What you get |
| --- | --- |
| Providers | Register upstreams by adapter (`openai-compatible`, `openrouter`, `anthropic`, `generic-rest`); test connection, run model discovery, manage per-provider model lists |
| Model catalog | Cross-provider model index with search/filter/sort; models address as `provider_id/upstream_id`, or a stable alias |
| Aliases | Stable names with baked-in params (temperature, top_p, max_tokens, stop) and ordered fallback targets for blocking calls |
| Gateway keys | Create / revoke / expire `zr_…` bearer keys; plaintext shown exactly once; scrypt-hashed on the server |
| Streaming | SSE relay in OpenAI `chat.completion.chunk` format with usage frame, mid-stream error frames (`finish_reason: "error"`), and an event cap |
| Logs | Per-request log (gateway + playground) with status, latency, tokens, error codes; optional body capture |
| Console | Local web dashboard: overview with live stats, provider/model/alias/key management, logs, streaming playground, diagnostics, settings |
| Security | SSRF-guarded DNS resolution, AES-256-GCM credential storage, cookie sessions + CSRF header, request-size and stream-event caps |

## Quickstart

Requires Node.js ≥ 24.

```bash
npm install

# run API + dashboard from source with HMR
npm run dev

# or build everything and run the production server
npm run build
npm start
```

Open the console at <http://127.0.0.1:8787>. There is no public registration:
the single owner is provisioned with the CLI
(`npm -w packages/server run owner -- set-owner`, username + scrypt-hashed
password) or — as a fallback — via `ZEROROUTER_DASHBOARD_PASSWORD`.
Without any credential the admin API accepts only loopback clients; see
`docs/security.md` §2/§2a for the auth modes, login throttling and recovery.

Create a gateway key in the console (Gateway keys → New key) and call it:

```bash
curl -s http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer zr_xxxxxxxxxxxx" \
  -H "content-type: application/json" \
  -d '{"model":"my-openai/gpt-4o-mini","messages":[{"role":"user","content":"Hi"}]}'
```

A route is addressed exactly like `provider_id/upstream_id` (e.g.
`my-openai/gpt-4o-mini`) or an alias (e.g. `fast-chat`).

## Repository layout

```
packages/server   Hono-based gateway + admin API, adapters, SQLite store
packages/web      React 19 + Vite dashboard, served by the server in production
scripts/          mock_openai_upstream.mjs (local mock OpenAI API for testing)
docs/             api.md · adapters.md · security.md · deployment.md
                  design-research-artcraft.md (dashboard design language notes)
```

## Configuration

All behavior is controlled by environment variables (see `.env.example` and
`docs/deployment.md`):

| Variable | Default | Purpose |
| --- | --- | --- |
| `ZEROROUTER_HOST` | `127.0.0.1` | Bind address (loopback by default) |
| `ZEROROUTER_PORT` | `8787` | HTTP port |
| `ZEROROUTER_DATA_DIR` | `./data` | SQLite DB, master key, boot logs |
| `ZEROROUTER_MASTER_KEY` | auto-generated | Base64 32-byte AES-256-GCM key |
| `ZEROROUTER_DASHBOARD_PASSWORD` | unset | Fallback console credential (owner CLI is preferred), cookie sessions |
| `ZEROROUTER_TRUST_PROXY` | `false` | Trust `x-forwarded-for`/`-proto` from a TLS-terminating proxy (login throttle + Secure cookie) |
| `ZEROROUTER_ALLOW_REMOTE` | `false` | Required opt-in to bind a non-loopback host |
| `ZEROROUTER_WEB_DIST` | auto in prod build | Path of the built dashboard |
| `ZEROROUTER_LOG_LEVEL` | `info` | `debug`/`info`/`warn`/`error` |
| `ZEROROUTER_DEV_CORS_ORIGIN` | unset | Dev-only: allow the Vite dev server origin |

## Testing

181 automated checks cover crypto, SSRF transport, schemas, adapters, SSE
relay, rate limits, repositories, authentication & access control (15 end-to-end
scenarios plus unit coverage for the owner-credential service, login throttle
and cookie flags) and the safe-redirect open-redirect prevention in the web
package — including a full in-process integration suite that boots the real
server and exercises keys, streaming, mid-stream failures, aliases and request
logs end to end:

```bash
npm test
```

There is also a runnable mock upstream for manual experiments:
`node scripts/mock_openai_upstream.mjs` (listens on `127.0.0.1:18081`, auth
`Bearer mock-secret`; set `FORCE_UPSTREAM_FAIL=1` or `FORCE_UPSTREAM_401=1` to
test error paths).

## Documented limitations

- Model `status` transitions (`verified`/`error`) are stored in the schema but
  not yet driven by chat outcomes; a discovered model starts as `untested`.
- Fallback targets apply to blocking requests; mid-stream failures are
  surfaced as error chunks rather than re-routed.
- The `generic-rest` adapter is non-streaming by design (declared in its
  capabilities), and model discovery for it is manual.
