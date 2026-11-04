// Upstream error bodies that quote the provider credential (security reviews B2, S25-4). Pure: no I/O.
// In API mode every client shares the operator's provider key, so a provider answer that echoes it (a 401 quoting the
// header it received, or OpenAI's "Incorrect API key provided: sk-proj-****WXYZ") must not reach a client as is.
// The body comes from upstream, so matching is a linear scan with bounded look-back, never a backtracking pattern.

/** Keys shorter than this are not real provider keys (tests use one-letter values); nothing is replaced for them. */
const MIN_KEY_LENGTH = 16;
/** A mask is at most this many characters long. */
const MAX_MASK = 64;
const REDACTED = '[redacted]';

const isMask = (c: number): boolean => c === 0x2a || c === 0x2e || c === 0x2022 || c === 0x2026;
const isKeyChar = (c: number): boolean => (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f || c === 0x2d;

/**
 * Where a masked form of `key` that ends right before `end` (where the key's last four characters start) begins: a mask
 * (three or more `*`, `.` or bullets, or an ellipsis character, at most 64 characters) and, before it, optionally a run
 * of key characters (at most the key's length) starting with the key's first three characters. -1 when there is no mask.
 */
function maskedStart(text: string, end: number, key: string): number {
  let i = end;
  let marks = 0;
  let ellipsis = false;
  while (i > 0 && end - i < MAX_MASK && isMask(text.charCodeAt(i - 1))) {
    i--;
    if (text.charCodeAt(i) === 0x2026) ellipsis = true;
    else marks++;
  }
  if (marks < 3 && !ellipsis) return -1;
  const maskStart = i;
  let start = maskStart;
  const first3 = key.slice(0, 3);
  for (let j = maskStart - 1; j >= 0 && maskStart - j <= key.length && isKeyChar(text.charCodeAt(j)); j--) {
    if (text.startsWith(first3, j)) start = j;
  }
  return start;
}

/**
 * `body` with every occurrence of `key` and of its masked forms (an optional run starting with the key's first three
 * characters, then a mask, then the key's last four characters) replaced by `[redacted]`; null when nothing matched or
 * the key is too short to search for.
 */
export function redactCredentialEcho(body: Buffer, key: string): Buffer | null {
  if (key.length < MIN_KEY_LENGTH) return null;
  // Error bodies are JSON, so UTF-8; a body is rewritten only when something matched.
  const text = body.toString('utf8');
  const exact = text.split(key).join(REDACTED);
  const last4 = key.slice(-4);
  let out = '';
  let copied = 0;
  for (let at = exact.indexOf(last4); at >= 0; at = exact.indexOf(last4, at + 1)) {
    const start = maskedStart(exact, at, key);
    if (start < 0) continue;
    out += `${exact.slice(copied, Math.max(copied, start))}${REDACTED}`;
    copied = at + last4.length;
    at = copied - 1;
  }
  out += exact.slice(copied);
  return out === text ? null : Buffer.from(out, 'utf8');
}
