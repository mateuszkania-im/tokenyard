// Frozen copy of the file of the same name in src/surfaces at 5ad6f31, before the V1 performance work. Test-only:
// test/surfaces/walker-differential.test.ts holds the optimised walkers to exactly these results. Do not edit.
// Byte-level JSON walker shared by the surfaces: byte ranges in the original body, never a re-serialised copy.
// Byte-level JSON walker. Only called on bodies JSON.parse accepted, so the input is valid JSON.
// Structural characters are ASCII, and UTF-8 continuation bytes never collide with them.
export const QUOTE = 0x22;
const BACKSLASH = 0x5c;

function skipWs(b: Buffer, i: number): number {
  while (i < b.length && (b[i] === 0x20 || b[i] === 0x09 || b[i] === 0x0a || b[i] === 0x0d)) i++;
  return i;
}

/** `i` points at an opening quote; returns the index just past the closing quote. */
function skipString(b: Buffer, i: number): number {
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
