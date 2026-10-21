/**
 * End-to-end HTTP integration: bootstraps the REAL app (config, DB, middleware,
 * routes) on an ephemeral loopback port and drives the gateway against a real
 * in-process mock upstream. This encodes the manual smoke verification as a
 * repeatable test: key lifecycle, non-streaming charts, streaming SSE with
 * usage + [DONE], mid-stream failure semantics, auth failures, and request logs.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo, Server } from 'node:net';

import { bootstrap, type RunningServer } from '../index.js';

/* ─── in-process OpenAI-compatible mock upstream ─── */

const MOCK_SECRET = 'mock-secret-e2e';

function createMockUpstream(): Promise<Server> {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.headers.authorization !== `Bearer ${MOCK_SECRET}`) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'bad key', type: 'auth' } }));
        return;
      }
      let parsed: { messages?: { role: string; content: unknown }[]; model?: string } = {};
      try {
        parsed = JSON.parse(body);
      } catch {
        /* empty body */
      }
      const prompt = JSON.stringify(parsed.messages ?? []);
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            object: 'list',
            data: [
              { id: 'mock-small-1', object: 'model', created: 1, owned_by: 'mock', supported_parameters: ['stream', 'tools'] },
              { id: 'mock-small-2', object: 'model', created: 1, owned_by: 'mock' },
            ],
          }),
        );
        return;
      }
      if (req.url === '/v1/chat/completions') {
        if (prompt.includes('FORCE_UPSTREAM_FAIL')) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: null }] })}\n\n`);
          setTimeout(() => {
            res.write(`data: ${JSON.stringify({ error: { message: 'upstream exploded mid-stream', code: 500 } })}\n\n`);
            res.end();
          }, 20);
          return;
        }
        if (prompt.includes('FORCE_UPSTREAM_401')) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'expired credential' } }));
          return;
        }
        if (JSON.stringify(parsed).includes('"stream":true')) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          const parts = ['Hel', 'lo ', 'wor', 'ld!'];
          let i = 0;
          const emit = () => {
            if (i < parts.length) {
              res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: parts[i] }, finish_reason: null }] })}\n\n`);
              i += 1;
              setTimeout(emit, 5);
            } else {
              res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
              res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 } })}\n\n`);
              res.write('data: [DONE]\n\n');
              res.end();
            }
          };
          emit();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-mock',
            object: 'chat.completion',
            created: 1234,
            model: parsed.model ?? 'mock-small-1',
            choices: [{ index: 0, message: { role: 'assistant', content: 'MOCK REPLY' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 },
          }),
        );
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found' } }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/* ─── tiny client ─── */

interface HttpResponse {
  status: number;
  body: string;
  headers: Record<string, string>;
}

async function call(server: RunningServer, method: string, urlPath: string, opts: { key?: string | null; headers?: Record<string, string>; body?: unknown } = {}): Promise<HttpResponse> {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...opts.headers };
  if (opts.key) headers.authorization = `Bearer ${opts.key}`;
  const res = await fetch(`http://127.0.0.1:${server.config.port}${urlPath}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const respHeaders: Record<string, string> = {};
  res.headers.forEach((v, k) => (respHeaders[k] = v));
  return { status: res.status, body: await res.text(), headers: respHeaders };
}

/* ─── suite ─── */

describe('gateway end-to-end (real bootstrap)', () => {
  let zr: RunningServer;
  let mock: Server;
  let mockPort = 0;
  let gatewayKey = '';
  const cleanupDirs: string[] = [];

  beforeAll(async () => {
    mock = await createMockUpstream();
    mockPort = (mock.address() as AddressInfo).port;

    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'zr-test-'));
    cleanupDirs.push(dataDir);
    const env: NodeJS.ProcessEnv = {
      // Loopback bind, random-ish ephemeral port, test env (no password required)
      NODE_ENV: 'test',
      ZEROROUTER_DATA_DIR: dataDir,
      ZEROROUTER_PORT: String(21000 + (process.pid % 4096)),
      ZEROROUTER_LOG_LEVEL: 'error',
    };
    zr = await bootstrap(env);
  }, 30_000);

  afterAll(async () => {
    await zr?.stop();
    await new Promise<void>((r) => mock.close(() => r()));
  });

  it('boots on loopback and serves health', async () => {
    expect(zr.config.host).toBe('127.0.0.1');
    const res = await call(zr, 'GET', '/healthz');
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body) as { ok: boolean; service: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.service).toBe('zerorouter');
  });

  it('rejects unauthenticated gateway calls', async () => {
    const res = await call(zr, 'POST', '/v1/chat/completions', { body: { model: 'x', messages: [] } });
    expect(res.status).toBe(401);
    const parsed = JSON.parse(res.body) as { error: { code: string; message: string } };
    expect(parsed.error.code).toBe('auth_required');
    expect(parsed.error.message).toMatch(/Authorization: Bearer zr_/);

    const wrong = await call(zr, 'POST', '/v1/chat/completions', { key: 'zr_definitely-not-valid', body: { model: 'x', messages: [] } });
    expect(wrong.status).toBe(401);
  });

  it('admin rejects mutations without the CSRF header', async () => {
    const res = await call(zr, 'POST', '/admin/keys', { body: { label: 'x' } });
    expect(res.status).toBe(403);
    expect((JSON.parse(res.body) as { error: { code: string } }).error.code).toBe('auth_required');
  });

  it('registers a provider through the admin API without leaking credentials', async () => {
    const res = await call(zr, 'POST', '/admin/providers', {
      headers: { 'x-requested-with': 'zerorouter' },
      body: {
        id: 'local-test',
        name: 'Local Test',
        adapter: 'openai-compatible',
        base_url: `http://127.0.0.1:${mockPort}`,
        api_key: MOCK_SECRET,
      },
    });
    expect(res.status).toBe(201);
    const parsed = JSON.parse(res.body) as { provider: Record<string, unknown> };
    expect(parsed.provider.has_credentials).toBe(true);
    expect(res.body).not.toContain(MOCK_SECRET);
    expect(res.body).not.toContain('credentials_enc');
  });

  it('discovers models from the mock upstream', async () => {
    const res = await call(zr, 'POST', '/admin/providers/local-test/discover', {
      headers: { 'x-requested-with': 'zerorouter' },
      body: {},
    });
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body) as { discovery: { found: number; added: number } };
    expect(parsed.discovery.found).toBe(2);
    expect(parsed.discovery.added).toBe(2);
  });

  it('creates a gateway key via /admin/keys (regression: scrypt maxmem on Node 24)', async () => {
    const res = await call(zr, 'POST', '/admin/keys', {
      headers: { 'x-requested-with': 'zerorouter' },
      body: { label: 'e2e' },
    });
    expect(res.status).toBe(201);
    const parsed = JSON.parse(res.body) as { key: { id: string }; plaintext: string };
    expect(parsed.plaintext.startsWith('zr_')).toBe(true);
    gatewayKey = parsed.plaintext;
  });

  it('performs non-streaming chat completions through the gateway', async () => {
    const res = await call(zr, 'POST', '/v1/chat/completions', {
      key: gatewayKey,
      body: { model: 'local-test/mock-small-2', messages: [{ role: 'user', content: 'hey' }] },
    });
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body) as {
      object: string;
      model: string;
      provider: string;
      choices: { index: number; message: { role: string; content: string }; finish_reason: string }[];
      usage: { total_tokens: number } | null;
      provider_meta: { requested: string; upstream_model: string };
    };
    expect(parsed.object).toBe('chat.completion');
    expect(parsed.model).toBe('local-test/mock-small-2');
    expect(parsed.choices[0]!.message.content).toBe('MOCK REPLY');
    expect(parsed.choices[0]!.finish_reason).toBe('stop');
    expect(parsed.usage!.total_tokens).toBe(33);
    expect(parsed.provider_meta.upstream_model).toBe('mock-small-2');
  });

  it('streams SSE deltas, a stop frame, usage chunk, and [DONE] (regression: event dropping)', async () => {
    const res = await fetch(`http://127.0.0.1:${zr.config.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${gatewayKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'local-test/mock-small-1', messages: [{ role: 'user', content: 'stream me' }], stream: true }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('cache-control')).toContain('no-transform');
    const text = await res.text();
    const frames = text.split('\n\n').filter((f) => f.startsWith('data: '));
    const payloads = frames.map((f) => f.slice(6));
    expect(payloads.at(-1)).toBe('[DONE]');
    const chunks = payloads.slice(0, -1).map((p) => JSON.parse(p) as { choices: { delta: { content?: string }; finish_reason: string | null }[]; usage?: unknown });
    // every upstream delta arrived — nothing dropped
    expect(chunks.filter((c) => c.choices[0]?.delta.content).map((c) => c.choices[0]!.delta.content).join('')).toBe('Hello world!');
    expect(chunks.some((c) => c.choices[0]?.finish_reason === 'stop' && !c.choices[0]?.delta.content)).toBe(true);
    const usageFrame = chunks.find((c) => c.choices.length === 0);
    expect(usageFrame?.usage).toEqual({ prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 });
  });

  it('relays mid-stream upstream failures as error frames with finish_reason error', async () => {
    const res = await fetch(`http://127.0.0.1:${zr.config.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${gatewayKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'local-test/mock-small-1', messages: [{ role: 'user', content: 'FORCE_UPSTREAM_FAIL' }], stream: true }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    const payloads = text.split('\n\n').filter((f) => f.startsWith('data: ')).map((f) => f.slice(6));
    expect(payloads.at(-1)).toBe('[DONE]');
    const parts = payloads.slice(0, -1).map((p) => JSON.parse(p) as { error?: { message: string; code: string }; choices: { delta: { content?: string }; finish_reason: string | null }[] });
    expect(parts[0]!.choices[0]!.delta.content).toBe('partial'); // streamed prefix survives
    const errFrame = parts.find((p) => p.error);
    expect(errFrame!.error!.message).toBe('upstream exploded mid-stream');
    expect(errFrame!.choices[0]!.finish_reason).toBe('error');
  });

  it('maps upstream 401 into a mapped provider_auth failure envelope', async () => {
    const res = await call(zr, 'POST', '/v1/chat/completions', {
      key: gatewayKey,
      body: { model: 'local-test/mock-small-1', messages: [{ role: 'user', content: 'FORCE_UPSTREAM_401 x' }] },
    });
    expect(res.status).toBe(401);
    const parsed = JSON.parse(res.body) as { error: { code: string; message: string } };
    expect(parsed.error.code).toBe('provider_auth_failed');
    expect(parsed.error.message).toContain('credential');
  });

  it('404s unknown models with a helpful not-found envelope', async () => {
    const res = await call(zr, 'POST', '/v1/chat/completions', {
      key: gatewayKey,
      body: { model: 'ghost/nothing', messages: [{ role: 'user', content: 'x' }] },
    });
    expect(res.status).toBe(404);
    const parsed = JSON.parse(res.body) as { error: { code: string; message: string } };
    expect(parsed.error.code).toBe('not_found');
    expect(parsed.error.message).toMatch(/"provider\/model"|alias/i);
  });

  it('routes aliases created via the admin API (params override, provider_meta consistency)', async () => {
    const create = await call(zr, 'PUT', '/admin/aliases/quick', {
      headers: { 'x-requested-with': 'zerorouter' },
      body: { provider_id: 'local-test', model: 'mock-small-2', enabled: true, params: { temperature: 0.3 } },
    });
    expect(create.status).toBe(200);

    const res = await call(zr, 'POST', '/v1/chat/completions', {
      key: gatewayKey,
      body: { model: 'quick', messages: [{ role: 'user', content: 'via alias' }] },
    });
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body) as { model: string; provider_meta: { requested: string; upstream_model: string } };
    expect(parsed.model).toBe('local-test/mock-small-2');
    expect(parsed.provider_meta.requested).toBe('quick');
    expect(parsed.provider_meta.upstream_model).toBe('mock-small-2');
  });

  it('exposes /v1/models with provider-scoped and alias ids', async () => {
    const res = await call(zr, 'GET', '/v1/models', { key: gatewayKey });
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body) as { object: string; data: { id: string; object: string }[] };
    const ids = parsed.data.map((m) => m.id);
    expect(ids).toContain('local-test/mock-small-1');
    expect(ids).toContain('local-test/mock-small-2');
    expect(ids).toContain('quick');
  });

  it('recorded request logs include statuses, tokens and error codes', async () => {
    const res = await call(zr, 'GET', '/admin/logs?per_page=50', { headers: { 'x-requested-with': 'zerorouter' } });
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body) as { total: number; rows: Array<{ model: string | null; stream: boolean; status: number; error_code: string | null; prompt_tokens: number | null; completion_tokens: number | null }> };
    expect(parsed.total).toBeGreaterThanOrEqual(6);
    const chat = parsed.rows.find((r) => r.model === 'local-test/mock-small-2' && !r.stream && r.status === 200);
    expect(chat?.prompt_tokens).toBe(11);
    expect(chat?.completion_tokens).toBe(22);
    expect(parsed.rows.some((r) => r.status === 404 && r.error_code === 'not_found')).toBe(true);
    expect(parsed.rows.some((r) => r.stream && r.status === 200 && r.error_code === '500')).toBe(true);
  });

  it('keeps security headers on API responses', async () => {
    const res = await call(zr, 'GET', '/v1/models', { key: gatewayKey });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['x-request-id']).toMatch(/^req/);
  });

  it('blocks non-loopback SSRF provider targets at registration', async () => {
    const res = await call(zr, 'POST', '/admin/providers', {
      headers: { 'x-requested-with': 'zerorouter' },
      body: {
        id: 'metadata-try',
        name: 'Metadata Try',
        adapter: 'openai-compatible',
        base_url: 'http://169.254.169.254/latest',
        api_key: 'k',
      },
    });
    expect([400, 422]).toContain(res.status);
    const parsed = JSON.parse(res.body) as { error: { message: string } };
    expect(parsed.error.message).toMatch(/metadata|HTTP 4/i);
  });
});
