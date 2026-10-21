import { lookup as dnsLookup, type LookupOneOptions, type LookupAddress } from 'node:dns';
import * as http from 'node:http';
import * as https from 'node:https';
import { isIP } from 'node:net';
import { URL } from 'node:url';
import { ApiError } from './errors.js';
import { logger } from './logger.js';

const log = logger('transport');

/* ────────────────────────────────────────────────────────────────────────────
 * URL policy + SSRF defense
 * ──────────────────────────────────────────────────────────────────────────── */

export interface UrlPolicy {
  /**
   * Allow plain http://. When true, ONLY loopback destinations qualify;
   * private-network http additionally requires `allowInsecurePrivateHttp`.
   */
  allowInsecureHttp?: boolean;
  /** Allow http:// to private/LAN addresses (e.g. LAN llama.cpp servers). Default false. */
  allowInsecurePrivateHttp?: boolean;
}

const LOOPBACK_V4 = ['127.0.0.0/8'];
const LOOPBACK_V6 = ['::1'];
const CLOUD_METADATA_HOSTNAMES = new Set([
  'metadata.google.internal',
  'metadata.goog',
  'metadata', // AWS IMDS
  'metadata.azure.internal',
  '169.254.169.254',
]);

function v4ToInt(ip: string): number {
  const parts = ip.split('.').map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    throw new Error('not an ipv4');
  }
  const a = parts[0] as number;
  const b = parts[1] as number;
  const c = parts[2] as number;
  const d = parts[3] as number;
  // eslint-disable-next-line no-bitwise
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

function inCidr(ip: string, cidr: string): boolean {
  const [range, bitsRaw] = cidr.split('/');
  if (!range || !bitsRaw) return false;
  const bits = Number.parseInt(bitsRaw, 10);
  if (isIP(range) === 4 && isIP(ip) === 4) {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (v4ToInt(ip) & mask) === (v4ToInt(range) & mask);
  }
  return false;
}

/** True when an address must never be contacted as a *remote* provider. */
export function isForbiddenIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    if (ip === '0.0.0.0') return true;
    const ranges = [
      '0.0.0.0/8',
      '10.0.0.0/8',
      '100.64.0.0/10',
      '127.0.0.0/8',
      '169.254.0.0/16',
      '172.16.0.0/12',
      '192.0.0.0/24',
      '192.168.0.0/16',
      '198.18.0.0/15',
      '224.0.0.0/4',
      '240.0.0.0/4',
    ];
    return ranges.some((r) => inCidr(ip, r));
  }
  if (isIP(ip) === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::' ) return true;
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // fc00::/7
    if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true; // fe80::/10
    if (lower.startsWith('ff')) return true; // multicast
    if (lower.startsWith('::ffff:')) return isForbiddenIp(lower.slice(7)); // v4-mapped
    return false;
  }
  return true;
}

function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    // RFC1918 only. Link-local (169.254/16 incl. cloud metadata) is NEVER permitted
    // through the LAN opt-in — see resolveEndpoint().
    const ranges = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'];
    return ranges.some((r) => inCidr(ip, r));
  }
  if (isIP(ip) === 6) {
    const lower = ip.toLowerCase();
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // ULA fc00::/7
  }
  return false;
}

function isLoopbackIp(ip: string): boolean {
  if (isIP(ip) === 4) return inCidr(ip, '127.0.0.0/8');
  if (isIP(ip) === 6) return ip.toLowerCase() === '::1';
  return false;
}

export interface ParsedTarget {
  url: URL;
  scheme: 'http' | 'https';
  hostname: string;
  port: number;
  isLoopbackHost: boolean;
}

/**
 * Validates a provider/base URL against the SSRF policy.
 * Throws ApiError with actionable detail on violation.
 */
export function parseTargetUrl(raw: string, policy: UrlPolicy): ParsedTarget {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw ApiError.badRequest(`Invalid URL: ${truncate(raw)}.`);
  }
  if (url.username || url.password || raw.includes('@')) {
    throw ApiError.badRequest('URLs with embedded credentials are not allowed.');
  }
  const scheme = url.protocol.replace(/:$/, '') as 'http' | 'https';
  if (scheme !== 'http' && scheme !== 'https') {
    throw ApiError.badRequest(`Unsupported URL scheme "${scheme};" expected http or https.`);
  }
  const hostnameRaw = url.hostname;
  // WHATWG URL keeps brackets for IPv6 literals; the address form used for
  // classification, DNS pinning and SNI is the bare address.
  const nameLower = hostnameRaw.toLowerCase().replace(/\.+$/, '').replace(/^\[(.+)\]$/, '$1');
  if (CLOUD_METADATA_HOSTNAMES.has(nameLower)) {
    throw ApiError.badRequest('Cloud metadata hosts are forbidden.');
  }

  const isLiteralIp = isIP(nameLower) !== 0;
  const ipLike = isLiteralIp ? nameLower : null;
  if (ipLike && isForbiddenIp(ipLike)) {
    // Loopback literals are permitted iff plain http/loopback policy is on.
    const loopbackOk = isLoopbackIp(ipLike) && policy.allowInsecureHttp === true;
    // RFC1918/ULA literals are permitted exactly like hostnames resolving to LAN:
    // only through the explicit per-provider opt-in. Metadata/link-local ranges
    // are NEVER permitted through it (isPrivateIp is RFC1918/ULA only).
    const lanOk = policy.allowInsecurePrivateHttp === true && isPrivateIp(ipLike);
    if (!loopbackOk && !lanOk) {
      throw ApiError.badRequest(
        `Refusing provider URL pointing at a private/loopback address (${ipLike}). ` +
          'Local model servers: loopback is allowed by default; LAN addresses need the ' +
          'allow_insecure_http provider option.',
      );
    }
  }

  if (scheme === 'http' && !(policy.allowInsecureHttp === true)) {
    throw ApiError.badRequest(
      'Plain http:// provider URLs are disabled. Use https://, or enable the explicit ' +
        '"allow insecure http" provider option for a local model server (loopback/LAN only).',
    );
  }
  if (scheme === 'http' && !ipLike && !policy.allowInsecurePrivateHttp && !nameLower.endsWith('.local')) {
    // Hostname-only http targets resolve later; the resolver re-checks target IPs.
    const looksLoopback = nameLower === 'localhost' || nameLower.startsWith('127.') || nameLower === '::1' || nameLower === '[::1]';
    if (!looksLoopback) {
      throw ApiError.badRequest(
        'Plain http:// is permitted for loopback model servers, or LAN addresses with allow_insecure_private_http=true.',
      );
    }
  }

  const port = url.port ? Number.parseInt(url.port, 10) : scheme === 'https' ? 443 : 80;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw ApiError.badRequest('Invalid port in URL.');
  }

  return {
    url,
    scheme,
    hostname: nameLower,
    port,
    isLoopbackHost: nameLower === 'localhost' || (ipLike !== null && isLoopbackIp(ipLike)),
  };
}

export interface ResolvedEndpoint {
  target: ParsedTarget;
  address: string;
  family: 4 | 6;
}

export type LookupFn = (
  hostname: string,
  options: LookupOneOptions,
  callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
) => void;

const defaultLookup: LookupFn = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, []);
    callback(null, addresses as LookupAddress[]);
  });
};

/**
 * Resolves every address for the hostname and validates each against the policy.
 * Security-first: if ANY resolved address is forbidden, the host is rejected
 * entirely (no partial-contact attempts).
 */
export async function resolveEndpoint(
  target: ParsedTarget,
  policy: UrlPolicy,
  lookupFn: LookupFn = defaultLookup,
): Promise<ResolvedEndpoint> {
  const candidates: { address: string; family: 4 | 6 }[] = [];

  if (isIP(target.hostname) !== 0) {
    candidates.push({ address: target.hostname, family: isIP(target.hostname) === 6 ? 6 : 4 });
  } else {
    const addresses = await new Promise<Array<{ address: string; family: 4 | 6 }>>((resolve, reject) => {
      lookupFn(target.hostname, {}, (err, addrs) => {
        if (err) return reject(err);
        const list = Array.isArray(addrs) ? addrs : [addrs as string];
        resolve(
          list.map((a) =>
            typeof a === 'string'
              ? { address: a, family: (isIP(a) === 6 ? 6 : 4) as 4 | 6 }
              : { address: a.address, family: a.family === 6 ? 6 : 4 },
          ),
        );
      });
    });
    if (addresses.length === 0) {
      throw ApiError.upstream(502, 'provider_unavailable', `Provider host did not resolve: ${target.hostname}`, { retriable: true });
    }
    candidates.push(...addresses);
  }

  // IP-level gate: loopback is permitted when allowInsecureHttp (default policy);
  // other private/metadata/multicast ranges always require the LAN opt-in below,
  // and cloud metadata (169.254.169.254) is never reachable through it.
  const forbids = candidates.filter((c) => isForbiddenIp(c.address) && !(isLoopbackIp(c.address) && policy.allowInsecureHttp === true));
  if (forbids.length > 0 && !policy.allowInsecurePrivateHttp) {
    throw ApiError.upstream(
      502,
      'provider_blocked',
      `Provider host ${target.hostname} resolves to a rejected network address (${forbids[0]?.address ?? 'unknown'}). Access to this destination is blocked by SSRF policy.`,
    );
  }
  if (forbids.length > 0 && policy.allowInsecurePrivateHttp && !(forbids.every((f) => isPrivateIp(f.address)))) {
    throw ApiError.upstream(502, 'provider_blocked', `Provider host ${target.hostname} resolves to a non-LAN address (metadata/link-local/multicast) — blocked by SSRF policy.`);
  }
  // With the LAN opt-in, RFC1918/ULA candidates remain usable; anything else
  // forbidden (metadata, multicast, etc.) never does.
  const usable = candidates.filter((c) => !forbids.includes(c) || (policy.allowInsecurePrivateHttp && isPrivateIp(c.address)));
  if (usable.length === 0) {
    throw ApiError.upstream(502, 'provider_blocked', `No usable address for ${target.hostname}.`);
  }

  // Prefer IPv4 first for determinism.
  usable.sort((a, b) => a.family - b.family);
  const chosen = usable[0]!;
  return { target, address: chosen.address, family: chosen.family };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Transport
 * ──────────────────────────────────────────────────────────────────────────── */

export interface TransportRequest {
  url: string;
  method: 'GET' | 'POST' | 'HEAD';
  headers?: Record<string, string>;
  body?: Buffer | string;
  /** Signal that aborts both connection and response streaming. */
  signal?: AbortSignal;
  timeoutMs: number;
  /** When true, `stream` is returned instead of buffered `body`. */
  wantStream?: boolean;
  maxRedirects?: number;
  maxResponseBytes?: number;
  maxBodyBytes?: number;
  policy: UrlPolicy;
  /** Injectable for tests. */
  lookupFn?: LookupFn;
}

export interface TransportResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body?: Buffer;
  stream?: http.IncomingMessage;
  contentType?: string;
  durationMs: number;
  redirects: number;
  finalUrl: string;
}

export type TransportFailureKind =
  | 'dns'
  | 'connect'
  | 'tls'
  | 'timeout'
  | 'aborted'
  | 'response_too_large'
  | 'blocked'
  | 'too_many_redirects'
  | 'reset'
  | 'unknown';

export class TransportError extends Error {
  readonly kind: TransportFailureKind;
  override readonly cause?: unknown;
  constructor(kind: TransportFailureKind, message: string, cause?: unknown) {
    super(message);
    this.name = 'TransportError';
    this.kind = kind;
    this.cause = cause;
  }
}

const ATTEMPT_HEADERS_STRIP = new Set(['authorization', 'x-api-key', 'cookie']);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, Math.min(ms, 5_000)));
}

async function attempt(
  target: ParsedTarget,
  endpoint: ResolvedEndpoint,
  req: TransportRequest,
  signal?: AbortSignal,
  startedMs = 0,
): Promise<{ res: http.IncomingMessage; redirect?: URL; durationMs: number; actualAddress: string }> {
  const start = performance.now();
  return await new Promise((resolve, reject) => {
    const url = target.url;
    const lib = target.scheme === 'https' ? https : http;
    const headers: Record<string, string> = { ...(req.headers ?? {}) };
    if (req.body !== undefined && !headers['content-length'] && req.method !== 'GET') {
      headers['content-length'] = String(Buffer.isBuffer(req.body) ? req.body.length : Buffer.byteLength(req.body));
    }

    const options: https.RequestOptions = {
      host: endpoint.address,
      port: target.port,
      path: `${url.pathname}${url.search}` || '/',
      method: req.method,
      headers,
      // Pin DNS: never re-resolve after our validated lookup (anti-rebinding).
      lookup: (_host: string, opts: unknown, cb: (err: Error | null, address: string, family: number) => void) =>
        cb(null, endpoint.address, endpoint.family),
      signal,
      timeout: Math.max(1_000, Math.min(req.timeoutMs, 60_000)),
    };
    if (target.scheme === 'https') {
      (options as https.RequestOptions).servername = target.hostname;
      (options as https.RequestOptions).checkServerIdentity = (servername, cert) => {
        // Validate certificate against the hostname, not the pinned IP.
        const { checkServerIdentity } = require('node:tls') as typeof import('node:tls');
        return checkServerIdentity(target.hostname as string, cert);
      };
    }

    const request = lib.request(options, (res) => {
      const actual = res.socket?.remoteAddress;
      if (actual) {
        const normalized = actual.replace(/^::ffff:/i, '');
        if (isIP(normalized) !== 0 && normalized !== endpoint.address) {
          res.destroy(new TransportError('blocked', 'Connection address diverged from validated DNS — aborting.'));
          reject(new TransportError('blocked', 'Connection address diverged from validated DNS.'));
          return;
        }
      }
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400) {
        const locHeader = res.headers['location'];
        res.resume();
        if (locHeader) {
          try {
            resolve({ res, redirect: new URL(locHeader, url), durationMs: performance.now() - start, actualAddress: normalizedAddress(actual) });
            return;
          } catch {
            /* fallthrough to normal resolution */
          }
        }
      }
      resolve({ res, durationMs: performance.now() - start, actualAddress: normalizedAddress(actual) });
    });

    request.on('timeout', () => {
      request.destroy(new TransportError('timeout', `Socket timeout (${options.timeout}ms)`));
    });

    request.on('error', (err) => {
      reject(mapNetError(err));
    });

    if (req.body !== undefined) request.end(req.body);
    else request.end();
  });
}

function normalizedAddress(addr: string | undefined): string {
  if (!addr) return '';
  return addr.replace(/^::ffff:/i, '');
}

function mapNetError(err: NodeJS.ErrnoException | Error): TransportError {
  if (err instanceof TransportError) return err;
  const code = (err as NodeJS.ErrnoException).code;
  const msg = String(err.message ?? err);
  switch (code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return new TransportError('dns', `Provider host DNS lookup failed: ${code}`, err);
    case 'ECONNREFUSED':
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
    case 'EADDRNOTAVAIL':
      return new TransportError('connect', `Provider host unreachable: ${code}`, err);
    case 'ECONNRESET':
    case 'EPIPE':
      return new TransportError('reset', 'Provider closed the connection unexpectedly.', err);
    case 'ETIMEDOUT':
      return new TransportError('timeout', 'Provider connection timed out.', err);
    case 'EPROTO':
    case 'ERR_SSL_WRONG_VERSION_NUMBER':
    case 'UNSUPPORTED_PROTOCOL':
      return new TransportError('tls', 'TLS negotiation with provider failed.', err);
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'CERT_HAS_EXPIRED':
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
      return new TransportError('tls', `TLS certificate rejected: ${code ?? 'unknown'}`, err);
    default:
      return new TransportError('unknown', `Provider connection failed: ${msg}`, err);
  }
}

/** Converts a transport failure to an API error with a stable category. */
export function transportFailureToApiError(err: unknown, attemptedHost: string): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof TransportError) {
    switch (err.kind) {
      case 'dns':
      case 'connect':
        return ApiError.upstream(502, 'provider_unavailable', err.message, { retriable: true });
      case 'reset':
        return ApiError.upstream(502, 'provider_unavailable', err.message, { retriable: true });
      case 'tls':
        return ApiError.upstream(502, 'provider_unavailable', err.message);
      case 'timeout':
        return ApiError.upstream(504, 'timeout', `Provider ${attemptedHost} timed out.`, { retriable: true });
      case 'aborted':
        return ApiError.canceled();
      case 'blocked':
        return ApiError.upstream(502, 'provider_blocked', err.message);
      case 'response_too_large':
        return ApiError.upstream(502, 'malformed_response', 'Upstream response exceeded the size limit.');
      case 'too_many_redirects':
        return ApiError.upstream(502, 'provider_error', err.message);
      default:
        return ApiError.upstream(502, 'provider_unavailable', err.message);
    }
  }
  return ApiError.upstream(502, 'provider_unavailable', `Provider ${attemptedHost} request failed.`);
}

export function truncate(s: string, max = 200): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** The main entry: validated redirects, buffered or streaming. */
export async function performHttp(req: TransportRequest): Promise<TransportResponse> {
  const maxRedirects = req.maxRedirects ?? 5;
  const maxResponseBytes = req.maxResponseBytes ?? 16 * 1024 * 1024;
  // Combined abort signal: caller cancellation + overall timeout budget.
  const timeoutSignal = AbortSignal.timeout(req.timeoutMs);
  const overall = req.signal ? AbortSignal.any([timeoutSignal, req.signal]) : timeoutSignal;
  let currentUrl = req.url;
  let redirects = 0;
  const startedAt = performance.now();

  for (;;) {
    const target = parseTargetUrl(currentUrl, req.policy);
    const endpoint = await resolveEndpoint(target, req.policy, req.lookupFn);

    // Each hop inherits current time budget (AbortSignal.timeout already combined).
    let attemptResult;
    try {
      const controller = new AbortController();
      const abort = () => controller.abort(new TransportError('aborted', 'Request aborted'));
      overall.addEventListener('abort', () => {
        if (overall.reason instanceof Error) controller.abort(overall.reason);
        else abort();
      }, { once: true });
      attemptResult = await attempt(target, endpoint, req, controller.signal);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)['name'] === 'AbortError' || (err as NodeJS.ErrnoException)['code'] === 'ABORT_ERR') {
        throw new TransportError('aborted', 'Provider request aborted');
      }
      throw err;
    }

    if (attemptResult.res.statusCode && attemptResult.res.statusCode >= 300 && attemptResult.res.statusCode < 400 && attemptResult.redirect) {
      redirects += 1;
      if (redirects > maxRedirects) {
        attemptResult.res.destroy();
        throw new TransportError('too_many_redirects', `Provider produced more than ${maxRedirects} redirects.`);
      }
      const next = attemptResult.redirect;
      const methodChanging = attemptResult.res.statusCode === 301 || attemptResult.res.statusCode === 302 || attemptResult.res.statusCode === 303;
      if (req.method === 'POST' && methodChanging) {
        attemptResult.res.destroy();
        throw new TransportError(
          'blocked',
          `Provider responded with a method-changing redirect (${attemptResult.res.statusCode}); refusing to convert POST → GET. Reached ${next.host}`,
        );
      }
      if (next.protocol === 'https:' && next.username) {
        throw new TransportError('blocked', 'Redirect URL contains credentials.');
      }
      const next_policy_urls_match_origin = new URL(currentUrl).hostname;
      if (next.hostname !== next_policy_urls_match_origin) {
        // cross-host redirect: strip credentials
        if (req.headers) {
          for (const h of Object.keys(req.headers)) {
            if (ATTEMPT_HEADERS_STRIP.has(h.toLowerCase())) delete req.headers[h];
          }
        }
      }
      currentUrl = next.toString();
      log.debug('following provider redirect', { redirects, host: next.host });
      continue;
    }

    const contentType = (attemptResult.res.headers['content-type'] as string | undefined) ?? undefined;
    if (req.wantStream) {
      const res = attemptResult.res;
      let streamed = 0;
      res.on('data', (chunk: Buffer) => {
        streamed += chunk.length;
        if (streamed > maxResponseBytes) {
          res.destroy(new TransportError('response_too_large', 'Upstream stream exceeded size limit'));
        }
      });
      return {
        status: res.statusCode ?? 0,
        headers: res.headers,
        stream: res,
        contentType,
        durationMs: performance.now() - startedAt,
        redirects,
        finalUrl: currentUrl,
      };
    }

    // Buffer with cap
    const chunks: Buffer[] = [];
    let received = 0;
    const contentLengthHeader = Number.parseInt(String(attemptResult.res.headers['content-length'] ?? ''), 10);
    if (Number.isInteger(contentLengthHeader) && contentLengthHeader > maxResponseBytes) {
      attemptResult.res.destroy();
      throw new TransportError('response_too_large', `Upstream response larger than cap: ${contentLengthHeader} bytes.`);
    }
    const res = attemptResult.res;
    const body = await new Promise<Buffer>((resolve, reject) => {
      res.on('data', (c: Buffer) => {
        received += c.length;
        chunks.push(c);
        if (received > maxResponseBytes) {
          res.destroy(new TransportError('response_too_large', 'Upstream response exceeded size limit'));
          reject(new TransportError('response_too_large', 'Upstream response exceeded size limit'));
        }
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', (err) => reject(mapNetError(err)));
      res.on('aborted', () => reject(new TransportError('reset', 'Upstream connection aborted mid-response')));
    });
    return {
      status: res.statusCode ?? 0,
      headers: res.headers,
      body,
      contentType,
      durationMs: performance.now() - startedAt,
      redirects,
      finalUrl: currentUrl,
    };
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * SSE parsing
 * ──────────────────────────────────────────────────────────────────────────── */

export interface SseEvent {
  event: string | null;
  data: string;
  id: string | null;
}

/**
 * Incremental, spec-compliant-enough SSE parser over byte chunk streams.
 * Handles multi-line data fields, comment lines and CRLF.
 */
export class SseParser {
  private buffer = '';
  private eventName: string | null = null;
  private dataLines: string[] = [];
  private lastId: string | null = null;

  constructor(private readonly onEvent: (ev: SseEvent) => void) {}

  static fromHttp(res: http.IncomingMessage, onEvent: (ev: SseEvent) => void, onDone?: () => void): SseParser {
    const parser = new SseParser(onEvent);
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => parser.push(chunk));
    res.on('end', () => {
      parser.flush();
      onDone?.();
    });
    res.on('error', (err) => {
      if (!res.destroyed) res.destroy();
      onEvent({ event: null, data: `[TRANSPORT] ${err instanceof Error ? err.message : String(err)}`, id: null });
    });
    return parser;
  }

  push(chunk: string): void {
    this.buffer += chunk;
    let idx = this.buffer.indexOf('\n');
    while (idx !== -1) {
      let line = this.buffer.slice(0, idx);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      this.buffer = this.buffer.slice(idx + 1);
      this.processLine(line);
      idx = this.buffer.indexOf('\n');
    }
  }

  flush(): void {
    if (this.buffer.length > 0) {
      this.processLine(this.buffer.replace(/\r$/, ''));
      this.buffer = '';
    }
    this.dispatch();
  }

  private processLine(line: string): void {
    if (line === '') {
      this.dispatch();
      return;
    }
    if (line.startsWith(':')) return; // comment/keepalive
    const colon = line.indexOf(':');
    if (colon === -1) return;
    const field = line.slice(0, colon).trim();
    let value = line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    const matchIndex = field;
    switch (matchIndex) {
      case 'data':
        this.dataLines.push(value);
        break;
      case 'event':
        this.eventName = value;
        break;
      case 'id':
        this.lastId = value;
        break;
      default:
        break;
    }
  }

  private dispatch(): void {
    if (this.dataLines.length > 0) {
      this.onEvent({ event: this.eventName, data: this.dataLines.join('\n'), id: this.lastId });
    }
    this.eventName = null;
    this.dataLines = [];
  }
}

export const sleepFor = sleep;
