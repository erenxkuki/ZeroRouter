# ZeroRouter HTTP API

Two surfaces, authenticated differently:

| Surface | Auth | Served by |
| --- | --- | --- |
| `/v1/*` — gateway | `Authorization: Bearer zr_…` gateway key | deployment |
| `/admin/*` — management | dashboard session cookie (or loopback in unlocked mode) + CSRF header on mutations | same process |
| `/healthz` | none | liveness probe |

All responses are JSON (`content-type: application/json`). Errors use one envelope:

```json
{ "error": { "message": "...", "code": "not_found", "status": 404, "details": null } }
```

`code` is a stable machine string (`invalid_api_key`, `model_not_found`,
`rate_limited`, `metadata_forbidden`, `private_forbidden`, `upstream_status`, …).

---

## Gateway endpoints

### `POST /v1/chat/completions`

OpenAI-compatible body:

```json
{
  "model": "my-openai/gpt-4o-mini",   // required: provider/model or alias
  "messages": [ { "role": "user", "content": "Hi" } ],
  "stream": false,                     // SSE when true
  "temperature": 0.7,                  // optional
  "top_p": 1, "max_tokens": 1024,      // optional
  "stop": ["END"],                     // string or up to 4 strings
  "tools": [...]                       // optional tool specs
}
```

Non-streaming response (success):

```json
{
  "id": "chatcmpl-…", "object": "chat.completion", "created": 1770000000,
  "model": "my-openai/gpt-4o-mini",            // concrete provider/model used
  "provider": "my-openai",
  "choices": [ { "index": 0, "message": { "role": "assistant", "content": "…" }, "finish_reason": "stop" } ],
  "usage": { "prompt_tokens": 9, "completion_tokens": 12, "total_tokens": 21 },
  "request_id": "req_…",
  "provider_meta": { "requested": "my-openai/gpt-4o-mini", "upstream_model": "gpt-4o-mini" }
}
```

Notes:

- `model` in the response is always the **resolved** target — alias callers
  learn which provider/model served them via `provider_meta.requested`.
- Alias `params` are defaults: the caller's own values win on conflict.
- Aliases carry ordered `fallbacks` for blocking requests; a fallback is tried
  when the target fails to complete.

Rate limiting: per key (`rate_limit_per_minute` sustained, `rate_limit_burst`
bucket cap) → `429 rate_limited` with `Retry-After` seconds header.

Common errors: `401 invalid_api_key` (missing/unknown/revoked/expired key),
`404 model_not_found` (unknown route: no such alias or `provider/model`), `429`,
`502`-class (`upstream_status`, `ssrf_blocked`, …) on provider failures.

### Streaming (`"stream": true`)

Response is `text/event-stream`; each frame is a standard OpenAI chunk with two
extra top-level fields (`provider`, `request_id`):

```
data: {"id":"chatcmpl-…","object":"chat.completion.chunk","created":…,
       "model":"provider/model","provider":"provider","request_id":"req_…",
       "choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}

data: {"…","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}

data: {"…","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: {"…","choices":[],"usage":{"prompt_tokens":9,"completion_tokens":12,"total_tokens":21}}

data: [DONE]
```

- Delta kinds: `role` → `delta:{role}`, `assistant_text` → `delta:{content}`,
  `tool_call_delta` → `delta:{tool_calls:[…]}` (index-aligned, args streamed),
  `finish` → empty delta + `finish_reason`.
- `usage` arrives as its own chunk with empty `choices` (OpenAI `include_usage`
  style), before `[DONE]`.
- **Mid-stream error:** the stream emits one frame carrying a top-level
  `error` object and `choices[].finish_reason:"error"`, then closes. Clients
  that already streamed partial content MUST treat this as a failed response
  and MUST NOT retry blindly (retries mark the request as failed).
- Hard caps: `stream_max_events` relays at most N chunks (default 20 000) and
  then ends the stream with an error frame.

### `GET /v1/models`

Lists addressable routes (enabled providers only). Each entry includes the
gateway-facing resource name plus metadata discovered from the provider.

---

## Admin endpoints

Mounted under `/admin`. When `ZEROROUTER_DASHBOARD_PASSWORD` is unset, only
loopback clients are accepted (`403` otherwise). With a password set, requests
require the session cookie set by `POST /admin/session/login`; every mutating
request must also carry the header `x-requested-with: zerorouter` (CSRF guard).

| Method + path | Purpose |
| --- | --- |
| `GET /session` | auth state (`password_required`, `authenticated`, `mode`, `secure_context`) |
| `POST /session/login` | password → HttpOnly session cookie (12 h) |
| `POST /session/logout` | clears session server-side + cookie |
| `GET /overview` | stats, 24 h activity series, recent provider events, providers |
| `GET /stats` | stats + activity only |
| `GET /providers` | providers + adapter summaries |
| `POST /providers` | create (base_url is validated against the SSRF gate at registration) |
| `GET /providers/:id` | detail incl. events + resolved URL policy |
| `PUT /providers/:id` | update (also validates any new `base_url`) |
| `DELETE /providers/:id?force=1` | delete; without `force=1` removal is blocked while aliases reference the provider |
| `POST /providers/:id/test` | connection test (latency + message) |
| `POST /providers/:id/discover` | model discovery run; returns `last_discovery` |  |
| `GET /providers/:id/events` | per-provider event feed |
| `GET /providers/:id/models` | registered models for provider |
| `POST /providers/:id/models` | manually add a model (`{ "upstream_id": "…", "display_name": "…" }`) |
| `PATCH /providers/:id/models/:upstreamId` | rename (`{ "display_name": "…" }`) |
| `DELETE /providers/:id/models/:upstreamId` | remove model entry |
| `GET /models?q&provider_id&sort&page&per_page` | paginated catalog |
| `GET /aliases` | all alias records |
| `PUT /aliases/:alias` | upsert (`provider_id`, `model`, `enabled`, `params?`, `fallbacks?` ≤ 4, `notes?`) |
| `DELETE /aliases/:alias` | delete |
| `GET /keys` | gateway keys (metadata only — never plaintext) |
| `POST /keys` | create (`label`, `expires_in_days null|int`) → **plaintext returned once** |
| `POST /keys/:id/revoke` | revoke (row kept for audit) |
| `DELETE /keys/:id` | delete row + audit trace |
| `GET /logs?provider_id&status=ok\|error&limit&offset` | request logs |
| `GET /logs/:id` | one entry incl. stored body (only when body logging is on) |
| `DELETE /logs` | clear all |
| `GET /events?limit` | recent provider events |
| `GET /adapters` | adapter list + capabilities |
| `POST /adapters/custom` | load custom adapter module (`{ "module_path": "/abs/path.mjs" }`) |
| `GET /settings` / `PUT /settings` | runtime settings (validated server-side) |
| `POST /playground/chat` | session-authed chat used by the console playground; accepts the same UnifiedChatRequest, streams SSE like `/v1` when `"stream": true` |
| `GET /diagnostics` | server config + store counts + limits |

Settings fields and allowed ranges:

| Field | Default | Range |
| --- | --- | --- |
| `debug_log_request_bodies` | `false` | on/off (privacy-sensitive) |
| `log_retention_days` | 14 | 1–365 |
| `max_inflight_requests` | 8 | 1–512 |
| `rate_limit_per_minute` | 120 | 1–10 000 |
| `rate_limit_burst` | 30 | ≥ `rate_limit_per_minute / 60` |
| `stream_max_events` | 20 000 | 1–100 000 |

Settings persist in the SQLite store and take effect immediately.
