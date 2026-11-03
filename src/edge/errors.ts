import type { BlockReason } from '../policy/types.js';

/**
 * Block reasons that waiting cannot clear: the answer carries `x-should-retry: false`, which the Anthropic SDK in
 * Claude Code honours, so the error is shown at once instead of after its retry loop (a 429 without it is retried for
 * minutes). Rate, stream and store-down blocks clear with time and keep their `retry-after`.
 */
const NOT_RETRYABLE: ReadonlySet<BlockReason> = new Set<BlockReason>([
  'no-route', 'model-not-allowed', 'secret', 'taint', 'budget', 'unpriced', 'server-tool-no-max-uses', 'server-tool-not-allowed', 'duplicate', 'session-churn',
]);
export const retryable = (reason: BlockReason): boolean => !NOT_RETRYABLE.has(reason);

/**
 * tokenyard's own error in the Anthropic envelope (spec 5.6). Upstream errors never pass through here:
 * they are forwarded unchanged. `retry-after` is always an integer number of seconds, at most 60: a larger value
 * makes Claude Code stop retrying and show the error at once (spec 5.6). `shouldRetry: false` adds `x-should-retry: false`.
 */
export function anthropicError(
  status: number,
  type: string,
  message: string,
  retryAfterS: number | null,
  requestId: string,
  opts: { shouldRetry?: boolean } = {},
): ErrorReply {
  const body = Buffer.from(JSON.stringify({ type: 'error', error: { type, message: `tokenyard: ${message}` } }));
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'content-length': String(body.length),
    'x-tokenyard-request-id': requestId,
  };
  if (opts.shouldRetry === false) headers['x-should-retry'] = 'false';
  if (retryAfterS !== null) headers['retry-after'] = String(Number.isFinite(retryAfterS) ? Math.min(60, Math.max(0, Math.ceil(retryAfterS))) : 60);
  return { status, headers, body };
}

/**
 * tokenyard's own error in the OpenAI envelope (spec 5.6): `{"error":{"type","code","message":"tokenyard: ..."}}`, for
 * requests on the Responses surface. `retry-after` and `x-should-retry` follow the same rules as `anthropicError`.
 */
export function openaiError(
  status: number,
  type: string,
  code: string,
  message: string,
  retryAfterS: number | null,
  requestId: string,
  opts: { shouldRetry?: boolean } = {},
): ErrorReply {
  const reply = anthropicError(status, type, message, retryAfterS, requestId, opts);
  const body = Buffer.from(JSON.stringify({ error: { type, code, message: `tokenyard: ${message}` } }));
  return { status, headers: { ...reply.headers, 'content-length': String(body.length) }, body };
}

export type ErrorReply = { status: number; headers: Record<string, string>; body: Buffer };
export type ErrorEnvelope = 'anthropic' | 'openai';

/**
 * OpenAI type and code for each own error, keyed by the Anthropic type and the block reason (or error class). Budget
 * is `insufficient_quota`, OpenAI's answer to a spent quota; rate and stream limits are `rate_limit_exceeded`.
 */
function openaiTypeAndCode(anthropicType: string, reason: string): { type: string; code: string } {
  switch (reason) {
    case 'budget':
      return { type: 'insufficient_quota', code: 'insufficient_quota' };
    case 'rate':
    case 'streams':
    case 'session-churn':
      return { type: 'requests', code: 'rate_limit_exceeded' };
    case 'secret':
    case 'taint':
      return { type: 'invalid_request_error', code: 'secret_detected' };
    case 'store-down':
      return { type: 'server_error', code: 'service_unavailable' };
    default:
      break;
  }
  if (anthropicType === 'api_error') return { type: 'server_error', code: reason.replaceAll('-', '_') };
  if (anthropicType === 'authentication_error') return { type: 'invalid_request_error', code: 'invalid_api_key' };
  if (anthropicType === 'not_found_error') return { type: 'invalid_request_error', code: 'unknown_url' };
  return { type: 'invalid_request_error', code: reason.replaceAll('-', '_') };
}

/**
 * An own error in the envelope of the request's surface: the Anthropic type and message as decided, translated for the
 * OpenAI envelope. `reason` is the block reason or a short error class (`request_too_large`, `internal_error`).
 */
export function ownError(
  envelope: ErrorEnvelope,
  status: number,
  anthropicType: string,
  reason: string,
  message: string,
  retryAfterS: number | null,
  requestId: string,
  opts: { shouldRetry?: boolean } = {},
): ErrorReply {
  if (envelope === 'anthropic') return anthropicError(status, anthropicType, message, retryAfterS, requestId, opts);
  const { type, code } = openaiTypeAndCode(anthropicType, reason);
  return openaiError(status, type, code, message, retryAfterS, requestId, opts);
}
