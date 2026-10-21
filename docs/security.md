# Security model

ZeroRouter is personal infrastructure, so the threat model is concrete:
untrusted web requests, hostile network paths that can reach the process,
other processes on the same machine, and upstreams that misbehave (outages,
oversized responses, malicious SSE floods).

## 1. Network exposure

- Default bind is `127.0.0.1:8787`; nothing is reachable from the network
  unless you explicitly set `ZEROROUTER_ALLOW_REMOTE=true`.
- That flag **requires** a dashboard credential (startup refuses otherwise):
  either a provisioned owner credential (database) or
  `ZEROROUTER_DASHBOARD_PASSWORD` (environment fallback). A console
  reachable from other machines must be authenticated.
- `/healthz` is the single unauthenticated endpoint (liveness only).

## 2. Admin console auth

Three mutually exclusive auth modes (resolved at startup, visible in
`GET /admin/session` as `mode`):

- `loopback_only` — no credential configured: admin endpoints accept
  **loopback clients only**. This is the "local personal console" posture.
- `environment` — `ZEROROUTER_DASHBOARD_PASSWORD` is set: password-only
  login (legacy fallback shape).
- `database` — the owner credential lives in the gateway database — SQLite
  (`gateway.db`) by default, or the configured Postgres instance when
  `ZEROROUTER_DATABASE_URL` is set (e.g. Supabase)
  (`owner_credential` table, scrypt `v1$` hash; created by the owner CLI
  only): login is **username + password**.

Login (`POST /admin/session/login`, CSRF header required):

- minimizes latency-leak enumeration — a wrong username still costs one full
  scrypt evaluation, so the two failure kinds are not time-distinguishable;
- returns the same generic `401 Incorrect owner credentials.` for a wrong
  username and a wrong password;
- mints a **fresh session id on every login** (no fixation), HttpOnly,
  `SameSite=Strict` cookie, 12 h TTL validated server-side on every request;
- the cookie gets `Secure` when the deployment binds remote (TLS is
  documented as required) or when `ZEROROUTER_TRUST_PROXY=true` and the
  trusted proxy reports `x-forwarded-proto: https`.
- Logout deletes the session row server-side and clears the cookie;
  rotating the credential revokes **all** sessions.
- All mutating admin requests (login included) must carry
  `x-requested-with: zerorouter` plus a matching Origin/host when present
  (CSRF defense: SameSite cookie + custom header).
- Deep links to console pages cannot leak data: the SPA gate renders the
  login screen without even projecting authed data (no prerendered cards).

Login abuse protection (database-backed — survives restarts):

- max 12 attempts/min per client address (hashed with SHA-256 — no raw IPs
  at rest), each attempt counted before verification;
- the 3rd and each further consecutive failure doubles a cooldown
  (0.5 s → cap 5 min); the cooldown applies **before** password verification
  and includes even the correct password (with a `Retry-After` header);
- a successful login clears that client's counters; cooldowns are always
  temporary — there is no permanent lockout.

## 2a. Owner provisioning & recovery (CLI only)

There is no `/setup` endpoint, no public registration, and no default
owner account. Ownership is established by shell access to the machine
hosting the data directory:

```bash
npm -w packages/server run owner -- set-owner          # interactive, or:
npm -w packages/server run owner -- set-owner --username owner --password-stdin < pw.txt
npm -w packages/server run owner -- status
npm -w packages/server run owner -- rotate-password    # verifies current password
npm -w packages/server run owner -- rotate-password --recovery   # locked-out owner
npm -w packages/server run owner -- unlock             # clears login throttles
npm -w packages/server run owner -- revoke-sessions    # invalidates all sessions
```

The CLI operates on the same storage the server uses: set
`ZEROROUTER_DATABASE_URL` in the shell to provision on Postgres (this is
also how the credential is created for a Vercel deployment — there is no
HTTP path to provisioning, see docs/vercel-deploy.md).

- Creating or rotating the credential always revokes every dashboard
  session and clears login throttles (rotation = session invalidation).
- `rotate-password` normally requires the current password; `--recovery`
  is the documented escape hatch when the password is lost. It is safe
  because whoever can run it can already read the database and master key
  (the same authority the owner has) — and it never runs over HTTP; there
  is no remote path to it.
- Password policy: ≥ 10 chars (12+ recommended), ≤ 1024, NFKC-normalized.
  Usernames: 3–32 chars of `[a-z0-9._@-]`.
- Secrets are never printed; the confirm-prompt path keeps the password out
  of shell history, and `--password-stdin` keeps it out of argv.

## 3. Gateway keys

- `zr_` tokens are 40+ chars of base64url entropy. The server stores only a
  **scrypt hash** plus a 12-char prefix for identification in logs.
- Plaintext is returned exactly once at creation (never re-listed, never
  logged, never stored by the console).
- Verification uses `crypto.timingSafeEqual`; expired (`expires_at`) and
  revoked keys pass/unpass the same constant-time check.
- Revoked rows stay visible for audit unless hard-deleted.
- Rate limits are enforced per key **before** any upstream call.

## 4. Provider credentials at rest

- Credentials (`api_key`, custom headers) are encrypted with AES-256-GCM
  using a 32-byte master key.
- The master key comes from (in order): `ZEROROUTER_MASTER_KEY` — a platform
  secret on hosted platforms like Vercel — or `data/.master_key`
  (mode 0600 on POSIX; on Windows the profile directory ACL applies). It is
  **never** stored in the database, so DB access alone does not yield
  plaintexts.
- Decrypted credentials exist only in memory for the duration of an upstream
  call. They are never sent to the browser: the admin API exposes only
  `has_credentials: true/false`.
- Changing the master key without re-encrypting makes stored credentials
  undecryptable (fail-closed: provider calls report missing credentials).

## 5. SSRF transport guard

Every upstream request — and every redirect hop — goes through one transport
(`packages/server/src/transport.ts`) with a fixed policy per provider:

| Destination (as `base_url`) | Default | With provider flag `allow_insecure_http: true` | Override possible? |
| --- | --- | --- | --- |
| Public host over `https` | allowed | — | n/a |
| Public host over plain `http` | blocked | still blocked (public http is never permitted) | no |
| Loopback (`127/8`, `::1`, `localhost`) over `http`/`https` | allowed | allowed | no |
| Private networks (`RFC1918`, ULA `fc00::/7`) over `http`/`https` | blocked | **allowed** (explicit per-provider opt-in, IP literals and resolved names alike) | per provider |
| Link-local metadata `169.254/16` incl. metadata hostnames | blocked | **still blocked** | **never** |

- Validation happens on the URL (before DNS) and on every resolved address
  (after DNS); `connect` sockets must match a validated address or the
  connection is destroyed ("DNS divergence" kills rebinding tricks).
- Hostname targets are resolved and filtered; a candidate that resolves only
  to non-permitted addresses fails with a precise error
  (`private_forbidden` / `metadata_forbidden` / `ssrf_blocked`).
- Plain `http://` is accepted only for loopback model servers (localhost /
  loopback IP literals / `.local` names) — public http is refused regardless
  of opt-ins. The per-provider `allow_insecure_http` opt-in exists to reach
  LAN (RFC1918/ULA) model servers, and never unlocks metadata ranges.
- The same gate runs at **registration**: a provider whose `base_url` points
  at a metadata address (or an unapproved private network) is rejected at
  creation, not merely at first call.

## 6. Upstream misbehavior

- Response bodies are capped at 16 MiB.
- SSE relays have a hard `stream_max_events` cap (default 20 000 chunks) — a
  malicious or runaway stream ends with an error frame instead of growing
  without bound.
- Provider timeout default 120 s (per-provider `timeout_ms`, max 600 s) and
  bounded retries (`retry_max`).
- In-flight concurrency cap protects memory (`max_inflight_requests`).
- Inbound request bodies are capped at 2 MiB.

## 7. Logs and privacy

- Request logs store: timestamps, key **id** (never the token), model, alias,
  status, latency, token usage, error code/message.
- Bodies are logged **only** when `debug_log_request_bodies` is enabled and
  are stored verbatim (they contain prompts) — off by default; the settings
  page labels this privacy-sensitive.
- Log retention: `log_retention_days` (default 14); `DELETE /admin/logs`
  clears immediately.
- Server log files under `data/logs` contain no credentials; upstream
  authorization failures are recorded as provider events, not key material.

## 8. Dashboard is server-free by design

Every secret-bearing operation happens server-side:

- gateway key generation + hashing — server;
- provider credential encryption/decryption — server;
- session minting + CSRF validation — server;
- streaming relay with caps — server.

The console code contains no secret persistence anywhere — no tokens,
passwords, session ids or key material in web storage. The only
`sessionStorage` key is a non-sensitive one-shot status notice ("Signed
out." / "Your session has expired.") consumed and cleared by the login
page; only per-component state exists for the one-time key reveal.

## 9. Known trade-offs

- The gateway trusts its own process; a local attacker on the same machine
  (same user) can read the master key file, the DB, and process memory.
  This is the accepted model for a personal tool — and it is exactly why
  owner provisioning/recovery is CLI-based: shell access already implies
  owner authority.
- `AllowRemote` + password mode relies on cookie integrity at the client;
  for mixed-machine LANs, TLS must be provided by a fronting reverse proxy
  (ZeroRouter deliberately does not terminate TLS itself). Set
  `ZEROROUTER_TRUST_PROXY=true` ONLY when such a proxy actually fronts the
  process: forwarding headers are otherwise client-forgeable (they feed the
  login-throttle key and the `Secure` cookie decision).
- The login attempt/cooldown state is per client address when no trusted
  proxy is present, all remote clients may share the proxy's address as a
  bucket; successful logins still clear it, and cooldowns cap at 5 minutes,
  so an attacker cannot permanently lock the owner out.
- Model status transitions (`verified`/`error`) exist in the schema but are
  not yet driven automatically by chat outcomes.

## 10. Cloud deployment (Vercel)

The serverless mode (docs/vercel-deploy.md) keeps every invariant above and
changes only the runtime shape:

- `ZEROROUTER_DATABASE_URL` + `ZEROROUTER_MASTER_KEY` are **required**
  (the function refuses to boot without them — an ephemeral filesystem can
  hold neither SQLite state nor a generated master key).
- `ZEROROUTER_ALLOW_REMOTE=true` + `ZEROROUTER_TRUST_PROXY=true` are the
  documented posture: Vercel is the only TLS front and the only source of
  `x-forwarded-*` values.
- The rate limiter stays in-memory and therefore applies per warm function
  instance, not globally; login throttles, sessions and key checks are all
  database-backed and unaffected.
- Streaming responses pass through unchanged; the platform caps request
  duration (60 s on Hobby).
- Maintenance (log retention, session pruning) runs once per cold start
  instead of on an interval.
