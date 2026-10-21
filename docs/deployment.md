# Running ZeroRouter in production

ZeroRouter ships as two npm workspace packages; `npm run build` compiles the
dashboard into `packages/web/dist` and the server into
`packages/server/dist`. The server serves the dashboard itself — deploy a
single Node process.

## 1. Build

```bash
npm install
npm run build          # web (vite) + server (tsc)
```

## 2. Configure

Copy `.env.example` → `.env` (or export the variables directly). Two ways
to give the dashboard a credential — prefer the CLI (hashed at rest, with
rotation + automatic session revocation):

```bash
NODE_ENV=production
ZEROROUTER_DATA_DIR=/var/lib/zerorouter/data

# Option 1 (preferred): provision the owner credential into the database.
npm -w packages/server run owner -- set-owner            # interactive username+password
#   ... or fully scripted (no TTY, no argv secrets):
#   printf '%s' "$OWNER_PASSWORD" | npm -w packages/server run owner -- \
#     set-owner --data-dir /var/lib/zerorouter/data --username owner --password-stdin

# Option 2 (fallback): environment password (password-only login).
ZEROROUTER_DASHBOARD_PASSWORD=$(openssl rand -base64 24)

ZEROROUTER_WEB_DIST=packages/web/dist
```

| Variable | Notes |
| --- | --- |
| `ZEROROUTER_HOST` | Keep `127.0.0.1`. Remote access is opt-in and requires a dashboard credential. |
| `ZEROROUTER_PORT` | Default 8787. |
| `ZEROROUTER_DATA_DIR` | Where `gateway.db`, `.master_key` and boot logs live. Back this up. |
| `ZEROROUTER_MASTER_KEY` | Optional stable base64 (32 raw bytes). Use when `data/` is ephemeral — otherwise the server generates + persists one on first boot. |
| `ZEROROUTER_DASHBOARD_PASSWORD` | Optional fallback credential; a provisioned owner credential takes priority. |
| `ZEROROUTER_ALLOW_REMOTE` | Set `true` **only** together with a dashboard credential (CLI-provisioned or env password). |
| `ZEROROUTER_TRUST_PROXY` | `true` only behind a real TLS-terminating reverse proxy: supplies client addresses for login throttling and the `Secure` cookie decision (`x-forwarded-for`/`-proto` are client-forgeable otherwise). |
| `ZEROROUTER_WEB_DIST` | Path of the built dashboard. In production builds (`NODE_ENV=production`) the default `packages/web/dist` is picked up automatically when present. |
| `ZEROROUTER_LOG_LEVEL` | `info` by default; `warn`/`error` reduce noise. |

## 3. Run

```bash
npm start                      # node packages/server/dist/index.js
```

or keep it alive with a service manager (Windows):

```powershell
# Register as a scheduled task / NSSM service pointing at:
#   node packages\server\dist\index.js
# with the desired ZEROROUTER_* environment.
```

Or with systemd (Linux):

```ini
[Unit]
Description=ZeroRouter gateway
After=network.target

[Service]
WorkingDirectory=/opt/zerorouter
EnvironmentFile=/etc/zerorouter/env
ExecStart=/usr/bin/node packages/server/dist/index.js
Restart=on-failure
User=zerorouter
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

## 4. Remote access posture

- By default, ZeroRouter is a loopback service: access the console on the
  same machine, or tunnel (`ssh -L 8787:127.0.0.1:8787`).
- `ZEROROUTER_ALLOW_REMOTE=true` requires a dashboard credential — a
  provisioned owner credential (`owner` CLI) or `ZEROROUTER_DASHBOARD_PASSWORD`;
  server startup refuses anything else.
- ZeroRouter does not terminate TLS. Put it behind a reverse proxy (Caddy,
  nginx) for HTTPS on a LAN; restrict `/admin` to trusted origins at the
  proxy if you expose `/v1` publicly. Set `ZEROROUTER_TRUST_PROXY=true` on
  that deployment so login throttling keys on the real client address and
  the session cookie is marked `Secure`.
- Session cookies are HttpOnly, `SameSite=Strict`, 12 h, server-side
  validated (fresh id per login); CSRF protection additionally requires the
  `x-requested-with: zerorouter` header on all mutations, login included.

## 5. Data layout

```
data/
  gateway.db        SQLite store (providers, models, aliases, keys, logs, sessions, settings)
  gateway.db-wal    SQLite write-ahead log
  .master_key       generated AES-256-GCM master key (base64, mode 0600)
  logs/             server boot/error logs
```

Back up `gateway.db` + `.master_key` together. Losing the master key makes
stored provider credentials undecryptable (by design); register providers
again with fresh credentials in that case.

## 6. Operations notes

- **Settings** persist in the DB and apply immediately (rate limits,
  caps, retention). No restart needed.
- **Sessions** survive restarts (in the DB). To force re-login for every
  client: `npm -w packages/server run owner -- revoke-sessions`, or rotate
  the credential (`rotate-password` — revokes sessions automatically).
- **Login lockout**: cooldowns cap at 5 minutes and clear on a successful
  login; for immediate relief run `npm -w packages/server run owner -- unlock`.
- **Log pruning** removes request logs older than `log_retention_days`.
- **Custom adapters** are loaded per-session via
  `POST /admin/adapters/custom` from a local file path — they are not
  persisted across restarts; re-register them after restart (or via your
  boot script).
- **Upgrades**: stop the server (`nssm`/`systemctl`), `git pull && npm run build`,
  start again. Migrations run automatically on boot; the DB format number is
  checked at startup — restore a backup if a migration is rejected.
