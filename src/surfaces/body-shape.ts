// Request body shapes the gateway refuses because another parser may read them differently (security review A5, C7).
// Pure: no I/O. The gateway prices and authorises its own JSON.parse of bytes it forwards unchanged, so a body that the
// provider's parser could read another way (a UTF-8 BOM some parsers skip, duplicate keys a first-wins parser keeps)
// is refused instead of guessed at.
import { arrayElementRanges, objectKeys } from './json-ranges.js';

export type BodyShapeRefusal = 'body-bom' | 'duplicate-keys';

const BOM = [0xef, 0xbb, 0xbf] as const;
/** Namespaces nest tools this deep at most (as the Responses extractor reads them). */
const MAX_TOOL_DEPTH = 4;

function hasDuplicate(keys: string[]): boolean {
  return new Set(keys).size !== keys.length;
}

/** A duplicate key in a `tools` entry, or in a namespace's own `tools`, at any depth the extractor reads. */
function duplicateInTools(b: Buffer, depth: number): boolean {
  for (const r of arrayElementRanges(b, 'tools') ?? []) {
    if (b[r.start] !== 0x7b) continue;
    const entry = b.subarray(r.start, r.end);
    const keys = objectKeys(entry);
    if (keys === null || hasDuplicate(keys)) return true;
    if (depth < MAX_TOOL_DEPTH && keys.includes('tools') && duplicateInTools(entry, depth + 1)) return true;
  }
  return false;
}

/**
 * Why the body must be refused, or null. A UTF-8 BOM is refused whether or not JSON.parse accepts the rest; duplicate
 * keys are checked only on a body JSON.parse accepted: any key repeated at the top level (keys compared unescaped), or
 * inside one `tools` entry.
 */
export function bodyShapeRefusal(body: Buffer, parsed: boolean): BodyShapeRefusal | null {
  if (body.length >= 3 && body[0] === BOM[0] && body[1] === BOM[1] && body[2] === BOM[2]) return 'body-bom';
  if (!parsed) return null;
  const top = objectKeys(body);
  if (top === null) return null;
  if (hasDuplicate(top) || duplicateInTools(body, 0)) return 'duplicate-keys';
  return null;
}
