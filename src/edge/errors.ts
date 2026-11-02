/**
 * tokenyard's own error in the Anthropic envelope (spec 5.6). Upstream errors never pass through here:
 * they are forwarded unchanged. `retry-after` is always an integer number of seconds, at most 60: a larger value
 * makes Claude Code stop retrying and show the error at once (spec 5.6).
 */
export function anthropicError(
  status: number,
  type: string,
  message: string,
  retryAfterS: number | null,
  requestId: string,
): { status: number; headers: Record<string, string>; body: Buffer } {
  const body = Buffer.from(JSON.stringify({ type: 'error', error: { type, message: `tokenyard: ${message}` } }));
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'content-length': String(body.length),
    'x-tokenyard-request-id': requestId,
  };
  if (retryAfterS !== null) headers['retry-after'] = String(Number.isFinite(retryAfterS) ? Math.min(60, Math.max(0, Math.ceil(retryAfterS))) : 60);
  return { status, headers, body };
}
