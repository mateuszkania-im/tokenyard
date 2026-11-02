import type { BlockReason } from '../policy/types.js';

/**
 * Block reasons that waiting cannot clear: the answer carries `x-should-retry: false`, which the Anthropic SDK in
 * Claude Code honours, so the error is shown at once instead of after its retry loop (a 429 without it is retried for
 * minutes). Rate, stream and store-down blocks clear with time and keep their `retry-after`.
 */
const NOT_RETRYABLE: ReadonlySet<BlockReason> = new Set<BlockReason>([
  'no-route', 'model-not-allowed', 'secret', 'taint', 'budget', 'unpriced', 'server-tool-no-max-uses', 'server-tool-not-allowed',
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
): { status: number; headers: Record<string, string>; body: Buffer } {
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
