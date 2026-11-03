// Byte-level JSON walker shared by the surfaces: byte ranges in the original body, never a re-serialised copy.
// Byte-level JSON walker. Only called on bodies JSON.parse accepted, so the input is valid JSON.
// Structural characters are ASCII, and UTF-8 continuation bytes never collide with them.
export const QUOTE = 0x22;
const BACKSLASH = 0x5c;

function skipWs(b: Buffer, i: number): number {
  while (i < b.length && (b[i] === 0x20 || b[i] === 0x09 || b[i] === 0x0a || b[i] === 0x0d)) i++;
  return i;
}

/**
 * `i` points at an opening quote; returns the index just past the closing quote. Quotes are found with indexOf (V1:
 * a byte loop over every string was most of the walk on a long agent context): a quote closes the string when the
 * run of backslashes just before it, inside the string, has even length. Without a closing quote, the byte loop.
 */
export function skipString(b: Buffer, i: number): number {
  const open = i;
  let from = i + 1;
  for (;;) {
    const q = b.indexOf(QUOTE, from);
    if (q < 0) return skipStringTail(b, open);
    let k = q - 1;
    while (k > open && b[k] === BACKSLASH) k--;
    if ((q - 1 - k) % 2 === 0) return q + 1;
    from = q + 1;
  }
}

function skipStringTail(b: Buffer, i: number): number {
  i++;
  while (i < b.length) {
    const c = b[i];
    if (c === BACKSLASH) i += 2;
    else if (c === QUOTE) return i + 1;
    else i++;
  }
  return i;
}

export function skipValue(b: Buffer, i: number): number {
  const c = b[i];
  if (c === QUOTE) return skipString(b, i);
  if (c === 0x7b || c === 0x5b) {
    let depth = 0;
    while (i < b.length) {
      const d = b[i];
      if (d === QUOTE) {
        i = skipString(b, i);
        continue;
      }
      if (d === 0x7b || d === 0x5b) depth++;
      else if (d === 0x7d || d === 0x5d) depth--;
      i++;
      if (depth === 0) return i;
    }
    return i;
  }
  while (i < b.length && b[i] !== 0x2c && b[i] !== 0x7d && b[i] !== 0x5d && b[i] !== 0x20 && b[i] !== 0x0a && b[i] !== 0x0d && b[i] !== 0x09) i++;
  return i;
}

/** Byte ranges of the elements of the top-level array `name` (the last such key wins, as in JSON.parse); null without one. */
export function arrayElementRanges(b: Buffer, name: string): Array<{ start: number; end: number }> | null {
  let i = skipWs(b, 0);
  if (b[i] !== 0x7b) return null;
  i++;
  let result: Array<{ start: number; end: number }> | null = null;
  for (;;) {
    i = skipWs(b, i);
    if (i >= b.length || b[i] === 0x7d) break;
    const keyStart = i;
    i = skipString(b, i);
    const rawKey = b.toString('utf8', keyStart, i);
    const key = rawKey.includes('\\') ? (JSON.parse(rawKey) as string) : rawKey.slice(1, -1);
    i = skipWs(b, i) + 1; // colon
    i = skipWs(b, i);
    if (key === name && b[i] === 0x5b) {
      i++;
      const all: Array<{ start: number; end: number }> = [];
      for (;;) {
        i = skipWs(b, i);
        if (i >= b.length) break;
        if (b[i] === 0x5d) {
          i++;
          break;
        }
        const start = i;
        i = skipValue(b, i);
        all.push({ start, end: i });
        i = skipWs(b, i);
        if (b[i] === 0x2c) i++;
      }
      result = all;
    } else {
      i = skipValue(b, i);
    }
    i = skipWs(b, i);
    if (b[i] === 0x2c) i++;
  }
  return result;
}

/** Byte ranges of every value of top-level `key` in a JSON object body, keys compared after unescaping. */
export function topLevelValueRanges(b: Buffer, key: string): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  let i = skipWs(b, 0);
  if (b[i] !== 0x7b) return out;
  i++;
  for (;;) {
    i = skipWs(b, i);
    if (i >= b.length || b[i] !== QUOTE) break;
    const keyStart = i;
    i = skipString(b, i);
    const rawKey = b.toString('utf8', keyStart, i);
    let k: string;
    try {
      k = rawKey.includes('\\') ? (JSON.parse(rawKey) as string) : rawKey.slice(1, -1);
    } catch {
      return [];
    }
    i = skipWs(b, i) + 1; // colon
    i = skipWs(b, i);
    const start = i;
    i = skipValue(b, i);
    if (k === key) out.push({ start, end: i });
    i = skipWs(b, i);
    if (b[i] === 0x2c) i++;
  }
  return out;
}

/**
 * True when any of `keys` occurs more than once at the top level of a JSON object body (keys compared after
 * unescaping): `keys.some((k) => topLevelValueRanges(b, k).length > 1)` in one walk.
 */
export function duplicateTopLevelKey(b: Buffer, keys: readonly string[]): boolean {
  const seen = new Set<string>();
  let dup = false;
  let i = skipWs(b, 0);
  if (b[i] !== 0x7b) return false;
  i++;
  for (;;) {
    i = skipWs(b, i);
    if (i >= b.length || b[i] !== QUOTE) break;
    const keyStart = i;
    i = skipString(b, i);
    const rawKey = b.toString('utf8', keyStart, i);
    let k: string;
    try {
      k = rawKey.includes('\\') ? (JSON.parse(rawKey) as string) : rawKey.slice(1, -1);
    } catch {
      return false; // topLevelValueRanges finds nothing in such a body
    }
    if (keys.includes(k)) {
      if (seen.has(k)) dup = true;
      seen.add(k);
    }
    i = skipWs(b, i) + 1; // colon
    i = skipWs(b, i);
    i = skipValue(b, i);
    i = skipWs(b, i);
    if (b[i] === 0x2c) i++;
  }
  return dup;
}

/**
 * Most JSON values (strings, object keys included, numbers, literals, objects and arrays) a request body may hold
 * (S-V3-3). Parsing and scanning cost per value, not per byte: 32 MiB of `{},` took 2.5 s and 1.2 GB in JSON.parse
 * alone, 32 MiB of `1,` as the messages array 1.2 s and 1.2 GB. At the budget the whole request (parse, shape check,
 * three scans on a product route) takes at most about 0.6 s. A coding-agent body holds a few hundred to a few tens of
 * thousands of values (a long tool result or an image is one string; the bench's 31 MiB body holds 76,000), so the
 * budget leaves more than 10 times what a context window can carry.
 */
export const BODY_VALUE_BUDGET = 1024 * 1024;

/** Byte classes for countJsonValuesUpTo: 0 a token byte, 1 whitespace or a separator, 2 an opening brace or bracket. */
const BYTE_CLASS = new Uint8Array(256);
for (const c of [0x20, 0x09, 0x0a, 0x0d, 0x7d, 0x5d, 0x2c, 0x3a]) BYTE_CLASS[c] = 1;
BYTE_CLASS[0x7b] = 2;
BYTE_CLASS[0x5b] = 2;
BYTE_CLASS[QUOTE] = 3;

/**
 * JSON values in `b` as a parser would count them (a string, a run of other bytes outside strings, an opening brace or
 * bracket), counted up to `max + 1` and no further, so a body over the budget is refused before JSON.parse allocates
 * it. Works on any bytes: a body JSON.parse refuses is counted the same way.
 */
export function countJsonValuesUpTo(b: Buffer, max: number): number {
  let n = 0;
  let i = 0;
  const len = b.length;
  while (i < len && n <= max) {
    const k = BYTE_CLASS[b[i] as number];
    if (k === 1) {
      i++;
    } else if (k === 3) {
      n++;
      i = skipString(b, i);
    } else if (k === 2) {
      n++;
      i++;
    } else {
      n++;
      i++;
      while (i < len && BYTE_CLASS[b[i] as number] === 0) i++;
    }
  }
  return n;
}
