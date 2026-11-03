// Upstream error bodies that quote the provider credential (security review B2). Pure: no I/O.
// In API mode every client shares the operator's provider key, so a provider answer that echoes it (a 401 quoting the
// header it received, or OpenAI's "Incorrect API key provided: sk-proj-****WXYZ") must not reach a client as is.

/** Keys shorter than this are not real provider keys (tests use one-letter values); nothing is replaced for them. */
const MIN_KEY_LENGTH = 16;
/** How providers mask a key: three or more asterisks, dots or bullets, or an ellipsis character. */
const MASK = '(?:[*.\\u2022]{3,}|\\u2026)';
const REDACTED = '[redacted]';

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * `body` with every occurrence of `key` and of its masked forms (an optional run starting with the key's first three
 * characters, then a mask (three or more `*`, `.` or bullets, or `\u2026`), then the key's last four characters) replaced by `[redacted]`; null
 * when nothing matched or the key is too short to search for.
 */
export function redactCredentialEcho(body: Buffer, key: string): Buffer | null {
  if (key.length < MIN_KEY_LENGTH) return null;
  // Error bodies are JSON, so UTF-8; a body is rewritten only when something matched.
  const text = body.toString('utf8');
  const masked = new RegExp(`(?:${escapeRe(key.slice(0, 3))}[A-Za-z0-9_-]*)?${MASK}${escapeRe(key.slice(-4))}`, 'g');
  const out = text.split(key).join(REDACTED).replace(masked, REDACTED);
  return out === text ? null : Buffer.from(out, 'utf8');
}
