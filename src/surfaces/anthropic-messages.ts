import { createHash } from 'node:crypto';
import type { ExtractedFeatures } from './types.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Tool type prefixes of Anthropic server tools (executed by the provider, billed per use). */
const SERVER_TOOL_PREFIXES = ['web_search_', 'web_fetch_', 'code_execution_', 'tool_search_tool_'];
/** Content blocks whose token count the provider decides (fetched URLs, rendered PDFs), so body bytes do not bound them. */
const EXPANDING_BLOCKS = new Set(['image', 'document']);

function emptyFeatures(bodyBytes: number, parseError: boolean): ExtractedFeatures {
  return {
    model: null,
    stream: false,
    maxOutputTokens: null,
    toolCount: 0,
    thinking: false,
    serverTools: [],
    bodyBytes,
    prefixHash: null,
    blockTypes: [],
    expandsServerSide: false,
    parseError,
    lastTurn: null,
  };
}

function collectBlockTypes(content: unknown, out: Set<string>): void {
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (!isObj(block) || typeof block.type !== 'string') continue;
    out.add(block.type);
    if (block.type === 'tool_result') collectBlockTypes(block.content, out);
  }
}

/**
 * Feature extraction for `/v1/messages`: one read-only `JSON.parse` of the body.
 * The parsed object is discarded; nothing here is ever serialised back into a request.
 */
export function extractAnthropicFeatures(body: Buffer): ExtractedFeatures {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return emptyFeatures(body.length, true);
  }
  if (!isObj(parsed)) return emptyFeatures(body.length, true);

  const tools = Array.isArray(parsed.tools) ? parsed.tools : [];
  const serverTools: ExtractedFeatures['serverTools'] = [];
  for (const t of tools) {
    if (!isObj(t) || typeof t.type !== 'string') continue;
    const type = t.type;
    if (!SERVER_TOOL_PREFIXES.some((p) => type.startsWith(p))) continue;
    serverTools.push({ type, maxUses: typeof t.max_uses === 'number' ? t.max_uses : null });
  }

  const types = new Set<string>();
  const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
  for (const m of messages) if (isObj(m)) collectBlockTypes(m.content, types);
  const blockTypes = [...types];

  const hasPrefix = parsed.tools !== undefined || parsed.system !== undefined;
  const prefixHash = hasPrefix
    ? createHash('sha256')
        .update(JSON.stringify([parsed.tools ?? null, parsed.system ?? null]))
        .digest('hex')
    : null;

  const thinking = parsed.thinking;
  return {
    model: typeof parsed.model === 'string' ? parsed.model : null,
    stream: parsed.stream === true,
    maxOutputTokens: typeof parsed.max_tokens === 'number' ? parsed.max_tokens : null,
    toolCount: tools.length,
    thinking: isObj(thinking) && thinking.type !== 'disabled',
    serverTools,
    bodyBytes: body.length,
    prefixHash,
    blockTypes,
    expandsServerSide: blockTypes.some((t) => EXPANDING_BLOCKS.has(t)),
    parseError: false,
    lastTurn: messages.length > 0 ? lastMessageRange(body) : null,
  };
}

// Byte-level JSON walker. Only called on bodies JSON.parse accepted, so the input is valid JSON.
// Structural characters are ASCII, and UTF-8 continuation bytes never collide with them.
const QUOTE = 0x22;
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

function skipValue(b: Buffer, i: number): number {
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

/** Byte range of the last element of the top-level `messages` array (the last `messages` key wins, as in JSON.parse). */
function lastMessageRange(b: Buffer): { start: number; end: number } | null {
  let i = skipWs(b, 0);
  if (b[i] !== 0x7b) return null;
  i++;
  let result: { start: number; end: number } | null = null;
  for (;;) {
    i = skipWs(b, i);
    if (i >= b.length || b[i] === 0x7d) break;
    const keyStart = i;
    i = skipString(b, i);
    const rawKey = b.toString('utf8', keyStart, i);
    const key = rawKey.includes('\\') ? (JSON.parse(rawKey) as string) : rawKey.slice(1, -1);
    i = skipWs(b, i) + 1; // colon
    i = skipWs(b, i);
    if (key === 'messages' && b[i] === 0x5b) {
      i++;
      let last: { start: number; end: number } | null = null;
      for (;;) {
        i = skipWs(b, i);
        if (i >= b.length) break;
        if (b[i] === 0x5d) {
          i++;
          break;
        }
        const start = i;
        i = skipValue(b, i);
        last = { start, end: i };
        i = skipWs(b, i);
        if (b[i] === 0x2c) i++;
      }
      result = last;
    } else {
      i = skipValue(b, i);
    }
    i = skipWs(b, i);
    if (b[i] === 0x2c) i++;
  }
  return result;
}
