/**
 * Shared helpers an adapter uses to talk through the guarded transport.
 */
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { performHttp, parseTargetUrl, TransportError } from '../transport.js';
import { ApiError } from '../errors.js';
import { logger } from '../logger.js';
import type { AdapterContext, TransportHooks } from './base.js';
import type { UrlPolicy } from '../transport.js';

const log = logger('transport');

export interface HttpResult {
  status: number;
  headers: IncomingHttpHeaders;
  body?: Buffer;
  stream?: IncomingMessage;
  contentType?: string;
}

/** Builds the standard transport hooks bound to a provider's policy + timeout. */
export function makeTransportHooks(policy: UrlPolicy): TransportHooks {
  return {
    policy,
    async perform(reqOptions) {
      const url = reqOptions.url;
      void parseTargetUrl(url, policy);
      const res = await performHttp({
        ...reqOptions,
        policy,
      });
      const out: HttpResult = {
        status: res.status,
        headers: res.headers,
        body: res.body,
        stream: res.stream,
        contentType: res.contentType,
      };
      return out;
    },
  };
}

export interface JsonBodyResult {
  status: number;
  json: unknown;
  text: string;
  contentType?: string;
  statusFailed: boolean;
}

/** GET/POST JSON helper with uniform failure mapping. */
export async function performJson(
  ctx: AdapterContext,
  opts: {
    url: string;
    method: 'GET' | 'POST';
    headers: Record<string, string>;
    body?: unknown;
    timeoutMs: number;
    maxResponseBytes?: number;
  },
): Promise<JsonBodyResult> {
  const res = await ctx.transport.perform({
    url: opts.url,
    method: opts.method,
    headers: {
      accept: 'application/json',
      ...opts.headers,
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: opts.body === undefined ? undefined : Buffer.from(JSON.stringify(opts.body), 'utf8'),
    timeoutMs: opts.timeoutMs,
    maxResponseBytes: opts.maxResponseBytes ?? 16 * 1024 * 1024,
    // discovery/test calls are short-lived
    signal: AbortSignal.timeout(opts.timeoutMs),
    policy: ctx.transport.policy,
  });
  const text = res.body?.toString('utf8') ?? '';
  const contentType = res.contentType;
  let json: unknown = null;
  if ((res.contentType ?? '').includes('json')) {
    try {
      json = JSON.parse(text) as unknown;
    } catch (err) {
      json = [text];
      log.debug('provider returned invalid JSON body', { url: opts.url, err: String(err) });
      if (res.status < 400) {
        throw ApiError.upstream(502, 'malformed_response', `Provider returned an invalid JSON document: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return {
    status: res.status,
    json,
    text,
    contentType,
    statusFailed: res.status >= 400,
  };
}

/** Maps provider HTTP status to an API error with a stable, non-leaking message. */
export function upstreamStatusError(
  ctx: AdapterContext,
  status: number,
  bodySnippet: string,
  hints: { retryAfterMs?: number } = {},
): ApiError {
  const retryAfter = hints.retryAfterMs ?? parseRetryAfterMs(bodySnippet);
  const message = statusMessageFor(status, bodySnippet, ctx.provider.id);
  const code = statusToErrorCode(status);
  return ApiError.upstream(status, code, message, {
    retriable: status >= 500 || status === 429,
    retryAfterMs: retryAfter,
    details: { provider: ctx.provider.id, upstream_status: status },
  });
}

function parseRetryAfterMs(text: string): number | undefined {
  const m = /Retry-After: ?(\d+)/i.exec(text);
  if (m?.[1]) return Number.parseInt(m[1], 10) * 1000;
  return undefined;
}

const STATUS_MESSAGES: Record<number, string> = {
  400: 'Provider rejected the request as invalid.',
  401: 'Provider rejected the API credential (401).',
  402: 'Provider account has insufficient credit or quota (402).',
  403: 'Provider refused access to this resource (403).',
  404: 'Provider does not recognize this resource (404).',
  408: 'Provider reported a request timeout (408).',
  413: 'Provider refused the request body as too large (413).',
  422: 'Provider rejected semantics of the request (422).',
  429: 'Provider is rate limiting requests (429).',
  500: 'Provider returned an unexpected internal error (500).',
  502: 'Provider returned an invalid gateway response (502).',
  503: 'Provider is temporarily unavailable (503).',
  504: 'Provider gateway timed out upstream (504).',
};

export function statusMessageFor(status: number, body: string, providerId: string): string {
  const base =
    STATUS_MESSAGES[status] ??
    STATUS_MESSAGES[status >= 500 && status < 600 ? 500 : 400] ??
    'Provider returned an unexpected HTTP status.';
  const extraction = extractProviderErrorMessage(body);
  const detail = extraction && extraction.length < 300 ? ` — ${extraction}` : '';
  return base.replace(/Provider/g, providerNameOf(providerId)) + detail;
}

function providerNameOf(providerId: string): string {
  return providerId;
}

const FAILURE_CODE_MAP: Record<number, Parameters<typeof ApiError.upstream>[1]> = {
  400: 'invalid_request',
  401: 'provider_auth_failed',
  402: 'provider_auth_failed',
  403: 'provider_blocked',
  404: 'invalid_model',
  408: 'provider_error',
  413: 'malformed_response',
  422: 'invalid_request',
  429: 'provider_unavailable',
};

function statusToErrorCode(status: number): Parameters<typeof ApiError.upstream>[1] {
  if (status >= 500) {
    if (status === 502) return 'provider_error';
    return 'provider_unavailable';
  }
  return FAILURE_CODE_MAP[status] ?? 'provider_error';
}

/** Extracts a human-readable provider error message from common JSON shapes. */
export function extractProviderErrorMessage(body: string): string | null {
  if (!body.trim().startsWith('{') && !body.trim().startsWith('[')) {
    if (body.length < 200 && body.length > 0) return body;
    return null;
  }
  try {
    const json = JSON.parse(body) as unknown;
    const err = pickError(json);
    if (err) return err;
    return null;
  } catch {
    return null;
  }
}

function pickError(json: unknown): string | null {
  if (!json || typeof json !== 'object') return null;
  if ('error' in (json as { error?: unknown })) {
    const errObj = (json as { error?: unknown }).error;
    if (typeof errObj === 'string') return errObj;
    if (errObj && typeof errObj === 'object') {
      const e = errObj as Record<string, unknown>;
      if (typeof e['message'] === 'string') return e['message'];
      if (typeof e['type'] === 'string') return e['type'];
    }
  }
  if ('detail' in (json as { detail?: unknown })) {
    const detail = (json as { detail?: unknown }).detail;
    if (typeof detail === 'string') return detail;
    if (Array.isArray(detail) === false && detail && typeof detail === 'object') {
      const { message } = detail as { message?: unknown };
      if (typeof message === 'string') return message;
    }
  }
  if ('message' in (json as { message?: unknown })) {
    const { message } = json as { message?: unknown };
    if (typeof message === 'string') return message;
  }
  return null;
}

/* ── Request abort safety ── */

export function isTransportError(x: unknown): x is TransportError {
  return x instanceof TransportError;
}
