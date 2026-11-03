// Request body shapes the gateway refuses because another parser may read them differently (security review A5, C7,
// S25-2). Pure: no I/O. The gateway prices, authorises and scans its own JSON.parse of bytes it forwards unchanged, so
// a body that the provider's parser could read another way (a UTF-8 BOM some parsers skip, a duplicate key a
// first-wins parser keeps, at any depth) is refused instead of guessed at.

import { skipString } from './json-ranges.js';

export type BodyShapeRefusal = 'body-bom' | 'duplicate-keys' | 'too-deep';

/** Objects and arrays nested deeper than this are refused (tool schemas and tool results stay far below it). */
export const MAX_BODY_DEPTH = 128;

const QUOTE = 0x22;
const COMMA = 0x2c;

/**
 * One linear pass over a body JSON.parse accepted: a Set of keys (compared after unescaping) per open object, so a
 * repeated key in any object at any depth, inside arrays included, is found without pairwise compares.
 */
function scan(b: Buffer): BodyShapeRefusal | null {
  // One entry per open container: a Set for an object, null for an array.
  const stack: Array<Set<string> | null> = [];
  // True when the next string in the current object is a key.
  let expectKey = false;
  let i = 0;
  while (i < b.length) {
    const c = b[i] as number;
    if (c === QUOTE) {
      const start = i;
      i = skipString(b, i);
      const top = stack.at(-1);
      if (expectKey && top) {
        const rawKey = b.toString('utf8', start, i);
        const escaped = rawKey.includes('\\');
        let key: string;
        try {
          key = escaped ? (JSON.parse(rawKey) as string) : rawKey.slice(1, -1);
        } catch {
          return 'duplicate-keys'; // not reachable on a body JSON.parse accepted; fail closed
        }
        if (top.has(key)) return 'duplicate-keys';
        top.add(key);
        expectKey = false;
      }
      continue;
    }
    if (c === 0x7b || c === 0x5b) {
      if (stack.length >= MAX_BODY_DEPTH) return 'too-deep';
      stack.push(c === 0x7b ? new Set() : null);
      expectKey = c === 0x7b;
    } else if (c === 0x7d || c === 0x5d) {
      stack.pop();
      expectKey = false;
    } else if (c === COMMA) {
      expectKey = stack.at(-1) instanceof Set;
    }
    i++; // colons, whitespace, numbers, literals
  }
  return null;
}

/**
 * Why the body must be refused, or null. A UTF-8 BOM is refused whether or not JSON.parse accepts the rest; duplicate
 * keys (in any object, at any depth) and nesting deeper than MAX_BODY_DEPTH are checked on a body JSON.parse accepted.
 */
export function bodyShapeRefusal(body: Buffer, parsed: boolean): BodyShapeRefusal | null {
  if (body.length >= 3 && body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) return 'body-bom';
  if (!parsed) return null;
  return scan(body);
}
