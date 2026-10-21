/**
 * ZeroRouter error taxonomy.
 *
 * Gateway-facing errors are surfaced in an OpenAI-compatible envelope:
 *   { "error": { "message", "code", "type", "request_id"? } }
 * where `type` mirrors the OpenAI SDK categories so common client libraries emit
 * recognizable exceptions.
 */

export type ErrorType =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'permission_error'
  | 'not_found_error'
  | 'rate_limit_error'
  | 'api_error'
  | 'unsupported_feature_error'
  | 'upstream_error';

export type ErrorCode =
  | 'invalid_request'
  | 'invalid_model'
  | 'ambiguous_route'
  | 'not_found'
  | 'route_disabled'
  | 'payload_too_large'
  | 'rate_limited'
  | 'disabled'
  | 'auth_required'
  | 'credentials_missing'
  | 'timeout'
  | 'provider_blocked'
  | 'provider_unavailable'
  | 'provider_auth_failed'
  | 'provider_error'
  | 'malformed_response'
  | 'stream_aborted'
  | 'unsupported_feature'
  | 'internal_error';

const TYPE_BY_CODE: Record<ErrorCode, ErrorType> = {
  invalid_request: 'invalid_request_error',
  invalid_model: 'invalid_request_error',
  ambiguous_route: 'invalid_request_error',
  not_found: 'not_found_error',
  route_disabled: 'invalid_request_error',
  payload_too_large: 'invalid_request_error',
  rate_limited: 'rate_limit_error',
  disabled: 'permission_error',
  auth_required: 'authentication_error',
  credentials_missing: 'invalid_request_error',
  timeout: 'api_error',
  provider_blocked: 'api_error',
  provider_unavailable: 'api_error',
  provider_auth_failed: 'api_error',
  provider_error: 'upstream_error',
  malformed_response: 'upstream_error',
  stream_aborted: 'api_error',
  unsupported_feature: 'unsupported_feature_error',
  internal_error: 'api_error',
};

export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details?: unknown;
  /** Whether it is acceptable (per policy) to retry a similar request elsewhere. */
  readonly retriable: boolean;
  /** Retry hint in milliseconds when present. */
  readonly retryAfterMs?: number;

  constructor(
    status: number,
    code: ErrorCode,
    message: string,
    opts: { details?: unknown; retriable?: boolean; retryAfterMs?: number } = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.type = TYPE_BY_CODE[code];
    this.details = opts.details;
    this.retriable = opts.retriable ?? false;
    this.retryAfterMs = opts.retryAfterMs;
  }

  /** Kept as a property for structural typing with OpenAI-ish error payloads. */
  readonly type: ErrorType;

  toEnvelope(requestId?: string): {
    error: { message: string; code: ErrorCode; type: ErrorType; request_id?: string; details?: unknown };
  } {
    const env: {
      error: { message: string; code: ErrorCode; type: ErrorType; request_id?: string; details?: unknown };
    } = { error: { message: this.message, code: this.code, type: this.type } };
    if (requestId !== undefined) env.error.request_id = requestId;
    if (this.details !== undefined) env.error.details = this.details;
    return env;
  }

  static badRequest(message: string, details?: unknown, code: ErrorCode = 'invalid_request'): ApiError {
    return new ApiError(400, code, message, { details });
  }
  static unprocessable(message: string, details?: unknown, code: ErrorCode = 'invalid_request'): ApiError {
    return new ApiError(422, code, message, { details });
  }
  static authRequired(message = 'Missing or invalid gateway API key.'): ApiError {
    return new ApiError(401, 'auth_required', message);
  }
  static forbidden(message = 'Forbidden.'): ApiError {
    return new ApiError(403, 'disabled', message);
  }
  static notFound(message = 'Not found.', code: ErrorCode = 'not_found'): ApiError {
    return new ApiError(404, code, message);
  }
  static conflict(message: string, details?: unknown, code: ErrorCode = 'ambiguous_route'): ApiError {
    return new ApiError(409, code, message, { details });
  }
  static payloadTooLarge(message = 'Request body exceeds the configured limit.'): ApiError {
    return new ApiError(413, 'payload_too_large', message);
  }
  static rateLimited(retryAfterMs?: number, message = 'Rate limit exceeded.'): ApiError {
    return new ApiError(429, 'rate_limited', message, { retriable: true, retryAfterMs });
  }
  static disabled(message: string): ApiError {
    return new ApiError(409, 'disabled', message);
  }
  static upstream(
    status: number,
    code: ErrorCode,
    message: string,
    opts: { details?: unknown; retriable?: boolean; retryAfterMs?: number } = {},
  ): ApiError {
    return new ApiError(status, code, message, opts);
  }
  static internal(message = 'Internal gateway error.'): ApiError {
    return new ApiError(500, 'internal_error', message);
  }
  static canceled(): ApiError {
    return new ApiError(499, 'stream_aborted', 'Client closed request.');
  }
}

/** Maps any thrown value to an ApiError without leaking internals. */
export function toApiError(err: unknown, fallbackMessage = 'Unexpected gateway error.'): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof Error) {
    return new ApiError(500, 'internal_error', fallbackMessage, { details: { cause_name: err.name } });
  }
  return new ApiError(500, 'internal_error', fallbackMessage);
}
