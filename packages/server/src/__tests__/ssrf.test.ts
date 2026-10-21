import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';

import {
  isForbiddenIp,
  parseTargetUrl,
  performHttp,
  resolveEndpoint,
  SseParser,
  type LookupFn,
  type UrlPolicy,
} from '../transport.js';

const LOOP_POLICY: UrlPolicy = { allowInsecureHttp: true };
const LAN_OPT_IN: UrlPolicy = { allowInsecureHttp: true, allowInsecurePrivateHttp: true };

function lookupReturns(map: Record<string, string[]>): LookupFn {
  return (hostname, _opts, cb) => {
    const addrs = map[hostname];
    if (!addrs) {
      const err = { code: 'ENOTFOUND', message: `no record for ${hostname}` } as NodeJS.ErrnoException;
      cb(err, []);
      return;
    }
    cb(null, addrs.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })));
  };
}

describe('isForbiddenIp — destination address classification', () => {
  const forbiddenPublic = [
    '0.0.0.0',
    '0.1.2.3',
    // cloud metadata
    '169.254.169.254',
    '169.254.0.1',
    // RFC1918
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    // CGNAT / benchmark / future ranges
    '100.64.0.1',
    '198.18.0.1',
    '240.0.0.1',
  ];
  const forbiddenV6 = ['::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1', '::ffff:192.168.0.1'];
  const allowed = ['8.8.8.8', '1.1.1.1', '93.184.216.34', '203.0.113.9', '2606:4700:4700::1111'];

  it.each(forbiddenPublic)('flags %s as forbidden', (ip) => expect(isForbiddenIp(ip)).toBe(true));
  it.each(forbiddenV6)('flags %s as forbidden', (ip) => expect(isForbiddenIp(ip)).toBe(true));
  it.each(allowed)('accepts public address %s', (ip) => expect(isForbiddenIp(ip)).toBe(false));
  it('rejects malformed input as unusable', () => {
    expect(isForbiddenIp('not-an-ip')).toBe(true);
  });
});

describe('parseTargetUrl — URL-level SSRF gates', () => {
  it('accepts https public URLs and http loopback URLs', () => {
    const p = parseTargetUrl('https://api.example.com/v1', LOOP_POLICY);
    expect(p.hostname).toBe('api.example.com');
    expect(p.port).toBe(443);
    expect(p.scheme).toBe('https');
    expect(p.isLoopbackHost).toBe(false);

    const loop = parseTargetUrl('http://localhost:8000', LOOP_POLICY);
    expect(loop.port).toBe(8000);
    expect(loop.isLoopbackHost).toBe(true);

    const literal = parseTargetUrl('http://127.0.0.1:18081', LOOP_POLICY);
    expect(literal.isLoopbackHost).toBe(true);
  });

  it('rejects embedded credentials and userinfo tricks', () => {
    expect(() => parseTargetUrl('https://user:pass@api.example.com', LOOP_POLICY)).toThrow(/embedded credentials/i);
    expect(() => parseTargetUrl('https://api.example.com@evil.example', LOOP_POLICY)).toThrow(/embedded credentials/i);
  });

  it('rejects non-http schemes', () => {
    expect(() => parseTargetUrl('file:///etc/passwd', LOOP_POLICY)).toThrow(/scheme/i);
    expect(() => parseTargetUrl('ftp://example.com', LOOP_POLICY)).toThrow(/scheme/i);
    expect(() => parseTargetUrl('gopher://example.com', LOOP_POLICY)).toThrow(/scheme/i);
  });

  it('always blocks explicit cloud metadata hosts', () => {
    for (const host of ['169.254.169.254', 'metadata', 'metadata.google.internal', 'metadata.goog', 'metadata.azure.internal']) {
      const raw = `http://${host}/`;
      expect(() => parseTargetUrl(raw, LAN_OPT_IN)).toThrow(/metadata/i);
    }
  });

  it('blocks private literals without the LAN opt-in and permits them with it (metadata never)', () => {
    expect(() => parseTargetUrl('http://192.168.1.10:8080', LOOP_POLICY)).toThrow(/private\/loopback/i);
    expect(() => parseTargetUrl('http://10.1.2.3:8080', LOOP_POLICY)).toThrow(/private\/loopback/i);
    // with the per-provider opt-in, RFC1918 http literals are accepted at the URL level
    const ok = parseTargetUrl('http://192.168.1.10:8080', LAN_OPT_IN);
    expect(ok.isLoopbackHost).toBe(false);
    // ... but link-local metadata stays forbidden even with the opt-in
    expect(() => parseTargetUrl('http://169.254.169.254/latest/meta-data', LAN_OPT_IN)).toThrow(/metadata/i);
    // and LAN literals over https:// are equally gated
    expect(() => parseTargetUrl('https://192.168.1.10:5443', LOOP_POLICY)).toThrow(/private\/loopback/i);
  });

  it('blocks plain http to hostnames that are not obviously loopback', () => {
    expect(() => parseTargetUrl('http://api.example.com', LOOP_POLICY)).toThrow(/loopback model servers/i);
    expect(() => parseTargetUrl('http://localhost', LOOP_POLICY)).not.toThrow();
    expect(() => parseTargetUrl('http://my-box.local:8080', LOOP_POLICY)).not.toThrow();
  });

  it('rejects invalid URLs and ports', () => {
    expect(() => parseTargetUrl('not a url', LOOP_POLICY)).toThrow(/invalid url/i);
    expect(() => parseTargetUrl('http://example.com:99999', LOOP_POLICY)).toThrow(/timestamp|port|Invalid/i);
    expect(() => parseTargetUrl('http://example.com:notaport/', LOOP_POLICY)).toThrow(/port/i);
  });
});

describe('resolveEndpoint — DNS-resolution time SSRF gate (rebinding defense)', () => {
  const specialLookup = lookupReturns({
    'public.example': ['93.184.216.34'],
    'to-loopback.example': ['127.0.0.1'],
    'dual-unsafe.example': ['93.184.216.34', '10.0.0.5'],
    'partial-safe.example': ['10.0.0.5'],
    'metadata.example': ['169.254.169.254'],
  });

  it('resolves public hostnames', async () => {
    const target = parseTargetUrl('https://public.example/v1', LOOP_POLICY);
    const ep = await resolveEndpoint(target, LOOP_POLICY, specialLookup);
    expect(ep.address).toBe('93.184.216.34');
    expect(ep.family).toBe(4);
  });

  it('permits loopback-resolving hostnames under the default loopback policy (https)', async () => {
    const target = parseTargetUrl('https://to-loopback.example', LOOP_POLICY);
    const ep = await resolveEndpoint(target, LOOP_POLICY, specialLookup);
    expect(ep.address).toBe('127.0.0.1');
  });

  it('allows a mixed LAN+public host under the LAN opt-in, contacting only validated IPs', async () => {
    // 10.0.0.5 is forbidden without opt-in; with opt-in it qualifies as LAN, and the
    // remaining public candidate is contacted. Public targets are always safe to reach.
    const target = parseTargetUrl('http://dual-unsafe.example', LAN_OPT_IN);
    const ep = await resolveEndpoint(target, LAN_OPT_IN, specialLookup);
    expect(ep.address).toBe('93.184.216.34');
  });

  it('permits RFC1918-only hosts under the LAN opt-in', async () => {
    const target = parseTargetUrl('http://partial-safe.example:8080', LAN_OPT_IN);
    const ep = await resolveEndpoint(target, LAN_OPT_IN, specialLookup);
    expect(ep.address).toBe('10.0.0.5');
  });

  it('rejects LAN-only hosts when the opt-in is missing (DNS-level gate)', async () => {
    // https:// so the URL-level plain-http hostname gate does not pre-empt DNS resolution.
    const target = parseTargetUrl('https://partial-safe.example:8443', LOOP_POLICY);
    await expect(resolveEndpoint(target, LOOP_POLICY, specialLookup)).rejects.toMatchObject({
      code: 'provider_blocked',
    });
  });

  it('keeps metadata link-local forbidden even with the LAN opt-in', async () => {
    const target = parseTargetUrl('http://metadata.example', LAN_OPT_IN);
    await expect(resolveEndpoint(target, LAN_OPT_IN, specialLookup)).rejects.toMatchObject({ code: 'provider_blocked' });
  });

  it('propagates DNS lookup failures (mapped later at transport level)', async () => {
    const target = parseTargetUrl('https://missing.example', LOOP_POLICY);
    await expect(resolveEndpoint(target, LOOP_POLICY, specialLookup)).rejects.toMatchObject({
      code: 'ENOTFOUND',
    });
  });

  it('handles IPv6 literals', async () => {
    // literal IPs skip DNS; a global IPv6 is acceptable per policy
    const target = parseTargetUrl('https://[2606:4700:4700::1111]', LOOP_POLICY);
    const ep = await resolveEndpoint(target, LOOP_POLICY, (_h, _o, cb) => cb(null, []));
    expect(ep.address).toBe('2606:4700:4700::1111');
    expect(ep.family).toBe(6);
  });
});

/* ── real transport: performHttp against an in-process loopback server ── */

describe('performHttp on loopback', () => {
  let server: http.Server;
  let base = '';
  let lastRequest = {
    headers: new Map<string, string | string[] | undefined>(),
  } as { headers: Map<string, string | string[] | undefined> };
  let seenBodies: string[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      for (const [k, v] of Object.entries(req.headers)) lastRequest.headers.set(k, v);
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seenBodies.push(body);
        if (req.url === '/json') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, method: req.method }));
          return;
        }
        if (req.url === '/sse') {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write('data: hello\n\n');
          res.write(': keepalive comment\n');
          setTimeout(() => {
            res.write('data: world\n\n');
            res.write('data: [DONE]\n\n');
            res.end();
          }, 20);
          return;
        }
        if (req.url === '/redirect') {
          res.writeHead(302, { location: '/json' });
          res.end();
          return;
        }
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('nope');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('performs a JSON POST with headers and body', async () => {
    const res = await performHttp({
      url: `${base}/json`,
      method: 'POST',
      headers: { authorization: 'Bearer test' },
      body: Buffer.from('{"x":1}'),
      timeoutMs: 5000,
      policy: LOOP_POLICY,
    });
    expect(res.status).toBe(200);
    expect((res.contentType ?? '').includes('application/json')).toBe(true);
    expect(JSON.parse(res.body!.toString('utf8'))).toEqual({ ok: true, method: 'POST' });
    expect(lastRequest.headers.get('authorization')).toBe('Bearer test');
    expect(seenBodies.at(-1)).toBe('{"x":1}');
  });

  it('streams responses when wantStream is set', async () => {
    const res = await performHttp({
      url: `${base}/sse`,
      method: 'GET',
      timeoutMs: 5000,
      wantStream: true,
      policy: LOOP_POLICY,
    });
    expect(res.stream).toBeDefined();
    const events: string[] = [];
    await new Promise<void>((done) => {
      SseParser.fromHttp(res.stream!, (ev) => events.push(ev.data), done);
    });
    expect(events).toEqual(['hello', 'world', '[DONE]']);
  });

  it('follows same-host redirects keeping credentials, cross-host stripping them', async () => {
    const res = await performHttp({
      url: `${base}/redirect`,
      method: 'GET',
      headers: { authorization: 'Bearer secret1' },
      timeoutMs: 5000,
      policy: LOOP_POLICY,
    });
    expect(res.status).toBe(200);
    expect(res.redirects).toBe(1);
    expect(res.finalUrl.endsWith('/json')).toBe(true);
    // Same-host redirect: the credential survives the hop.
    expect(lastRequest.headers.get('authorization')).toBe('Bearer secret1');
  });

  it('refuses method-changing redirects on POST (protocol smuggling guard)', async () => {
    await expect(
      performHttp({
        url: `${base}/redirect`,
        method: 'POST',
        headers: { authorization: 'Bearer secret1' },
        body: Buffer.from('{"x":1}'),
        timeoutMs: 5000,
        policy: LOOP_POLICY,
      }),
    ).rejects.toMatchObject({ name: 'TransportError', kind: 'blocked', message: /redirect/i });
  });

  it('surfaced connection errors as TransportError with kind', async () => {
    await expect(
      performHttp({
        url: 'http://127.0.0.1:9', // discard port — nothing listens
        method: 'GET',
        timeoutMs: 1500,
        policy: LOOP_POLICY,
      }),
    ).rejects.toMatchObject({ name: 'TransportError', kind: 'connect' });
  });
});
