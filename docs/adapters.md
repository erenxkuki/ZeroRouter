# Adapter engine

Providers talk to wildly different APIs; ZeroRouter clients see exactly one
OpenAI-compatible surface. Adapters own that translation in both directions.

```
gateway request (UnifiedChatRequest)
        │
        ▼
 adapter.chat / adapter.chatStream      (provider credentials, guarded transport)
        │
        ├── mapToProviderBody()          → upstream HTTP request
        ├── upstream SSE/JSON            → unified stream events
        └── normalized response shape    → OpenAI wire format
```

## Built-in adapters

| id | label | Discovery | Streaming | Tools | Notes |
| --- | --- | --- | --- | --- | --- |
| `openai-compatible` | OpenAI-compatible | ✓ `GET {base}/models` | ✓ | full | Any OpenAI-style API. Config knobs: `models_path`, `chat_path` path overrides. |
| `openrouter` | OpenRouter | ✓ `/models` | ✓ | full | Same wire as OpenAI + OpenRouter's rich model metadata (context lengths, modalities, pricing, supported params). |
| `anthropic` | Anthropic | — | ✓ | full | Messages API `POST /v1/messages`; requests are transformed (system prompt is a top-level field, `max_tokens` is required); SSE re-normalized to `chat.completion.chunk` events. |
| `generic-rest` | Generic REST | — | ✗ (by design) | ✗ | Declarative mapping for custom non-OpenAI HTTP APIs: `request_template` body, `json_fields` response extraction. Non-streaming — declared in capabilities and enforced. |

### What discovery records

`DiscoveryOutcome` stores per-model: `upstream_id`, `display_name`,
`context_length`, input/output modalities, `supported_parameters`,
`streaming`, `tools`, `reasoning`, and pricing (per-token strings), plus
`last_seen_at`. All metadata is optional — missing fields render as `—`
in the console rather than invented values.

## Adapter contract

An adapter implements (`packages/server/src/adapters/base.ts`):

```ts
interface Adapter {
  id: string; label: string; description: string;
  capabilities: {
    discovery: boolean; streaming: boolean;
    tools: boolean | 'full';   // 'full' = tool specs + streamed tool-call deltas
    multimodalTextImage: boolean;
  };

  validateConfig(config, baseUrl): { ok: true; config } | { ok: false; error };

  discover(ctx): Promise<DiscoveryOutcome>;      // optional (capability-gated)
  testConnection(ctx): Promise<ConnectionTestResult>;
  chat(ctx, req, resolvedModel): Promise<ChatOutcome>;            // blocking
  chatStream(ctx, req, resolvedModel): Promise<ChatStreamOutcome>;// SSE
  errorFromUpstream(status, bodyText): ApiError;  // upstream error → API error
}
```

`ctx` carries the provider record, **decrypted credentials** (memory only),
and the guarded transport hooks every upstream call must go through.

## Shared transport (security relevant)

All adapter HTTP traffic flows through `performHttp`
(`packages/server/src/transport.ts`), which enforces the SSRF policy for every
request **and every redirect hop** (redirect targets are re-validated):

- URL/`hostname` gate before DNS, resolved-IP gate after DNS (TOCTOU-safe:
  connecting sockets must match the validated address or are aborted).
- Loopback HTTP allowed (personal gateway use case, `allowInsecureHttp: true`).
- Private/LAN addresses only when the provider opts in via config
  `allow_insecure_http: true` (`allowInsecurePrivateHttp`).
- Link-local metadata addresses (`169.254/16`, incl. HTTP forms) are **always**
  forbidden regardless of flags.
- Response size cap (16 MiB), non-OK statuses mapped through
  `errorFromUpstream`, `TransportError` kinds surfaced as gateway errors.

## Adding a custom adapter at runtime

`POST /admin/adapters/custom` loads a local module and registers it:

```js
// /opt/zerorouter/adapters/my-adapter.mjs
export default {
  id: 'my-adapter',
  label: 'My Adapter',
  description: '…',
  capabilities: { discovery: false, streaming: false, tools: false, multimodalTextImage: false },
  validateConfig(config, baseUrl) { /* sanitize knobs, return config */ },
  async testConnection(ctx) { /* HTTP via ctx.transport.perform → { ok, message, latencyMs } */ },
  async chat(ctx, req, resolvedModel) { /* build body, call, normalize */ },
  async chatStream() { throw new Error('not supported'); },
  errorFromUpstream(status, bodyText) { /* map provider errors */ },
};
```

Rules enforced by the loader:

- the module path must be an explicit, operator-provided filesystem path —
  no remote downloads, no code from untrusted bodies, no eval;
- the module must export the adapter as its `default`;
- `chat` and `validateConfig` are required;
- the `id` must not collide with a built-in adapter.

Custom registrations live for the process lifetime and appear in
`GET /admin/adapters` like built-ins.
