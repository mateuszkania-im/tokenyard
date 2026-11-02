import { createHash } from 'node:crypto';
import { arrayElementRanges, QUOTE, topLevelValueRanges } from './json-ranges.js';
import type { ExtractedFeatures } from './types.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Type prefixes of Anthropic-defined client tools (tool reference page: memory, bash, text editor, computer use and
 * browser use). The application runs them, so the provider adds hidden definitions but no sampling loop.
 * Every other tool `type` except absent or `custom` (web search, web fetch, code execution, tool search, advisor,
 * `mcp_toolset`, and any type added after this list) is treated as server-side: it lands in `serverTools`, where
 * the estimator prices its loop or, without a price entry, reports it unpriced.
 */
const CLIENT_TOOL_PREFIXES = ['memory_', 'bash_', 'text_editor_', 'computer_', 'browser_toolset_'];
const isClientTool = (type: string): boolean => CLIENT_TOOL_PREFIXES.some((p) => type.startsWith(p));
/** Content blocks whose token count the provider decides (fetched URLs, rendered PDFs), so body bytes do not bound them. */
const EXPANDING_BLOCKS = new Set(['image', 'document']);
/**
 * Top-level Messages API fields that add no input on the provider side beyond the body's own bytes and the
 * tool-use framing covered by the estimator's overhead. Any other field (`mcp_servers`, `container`, a field
 * added after this list) sets `expandsServerSide`, so a new client feature fails safe (spec 7.3).
 * `output_config` and `context_management` are checked further below.
 */
const PLAIN_FIELDS = new Set([
  'model', 'messages', 'max_tokens', 'system', 'tools', 'tool_choice', 'thinking', 'stream', 'metadata', 'stop_sequences',
  'temperature', 'top_p', 'top_k', 'cache_control', 'inference_geo', 'service_tier', 'speed', 'diagnostics',
  'output_config', 'context_management',
]);
/** Context editing that only removes content from the prompt. Other edits (compaction) run extra sampling. */
const CLEARING_EDIT_PREFIXES = ['clear_tool_uses_', 'clear_thinking_'];

function hasExpandingField(parsed: Obj, tools: unknown[]): boolean {
  for (const key of Object.keys(parsed)) if (!PLAIN_FIELDS.has(key)) return true;
  // Structured output formats are not documented as adding no input; effort alone is plain.
  if (parsed.output_config !== undefined && !(isObj(parsed.output_config) && parsed.output_config.format == null)) return true;
  const cm = parsed.context_management;
  if (cm !== undefined) {
    if (!isObj(cm) || (cm.edits !== undefined && !Array.isArray(cm.edits))) return true;
    for (const e of (cm.edits as unknown[] | undefined) ?? []) {
      if (!isObj(e) || typeof e.type !== 'string' || !CLEARING_EDIT_PREFIXES.some((p) => (e.type as string).startsWith(p))) return true;
    }
  }
  // Custom tools are bounded by their bytes. Anthropic-defined client tools (bash, text editor, computer and
  // browser toolsets) add hidden definitions of up to about 6,600 tokens (pricing page); server tools are counted apart.
  for (const t of tools) {
    if (isObj(t) && typeof t.type === 'string' && isClientTool(t.type)) return true;
  }
  return false;
}

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
    fastMode: false,
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
    if (!isObj(t) || t.type === undefined || t.type === 'custom') continue;
    const type = typeof t.type === 'string' ? t.type : String(t.type);
    if (isClientTool(type)) continue;
    serverTools.push({ type, maxUses: typeof t.max_uses === 'number' ? t.max_uses : null });
  }
  // The MCP connector samples on the provider side (mcp_tool_use and mcp_tool_result inside one response),
  // whether or not an `mcp_toolset` entry names the server. No price entry exists, so it stays unpriced.
  const mcp = parsed.mcp_servers;
  if (mcp !== undefined && mcp !== null && !(Array.isArray(mcp) && mcp.length === 0)) serverTools.push({ type: 'mcp_servers', maxUses: null });

  const types = new Set<string>();
  const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
  collectBlockTypes(parsed.system, types);
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
    expandsServerSide: blockTypes.some((t) => EXPANDING_BLOCKS.has(t)) || hasExpandingField(parsed, tools),
    fastMode: parsed.speed !== undefined && parsed.speed !== null && parsed.speed !== 'standard',
    ...(typeof parsed.inference_geo === 'string' ? { inferenceGeo: parsed.inference_geo } : {}),
    parseError: false,
    ...turnRanges(body, messages),
    ...(hasAmbiguousKeys(body) ? { ambiguousKeys: true as const } : {}),
  };
}

/** A duplicate top-level `messages`, or a message object with a duplicate `role` or `content` (keys compared unescaped). */
function hasAmbiguousKeys(body: Buffer): boolean {
  if (topLevelValueRanges(body, 'messages').length > 1) return true;
  for (const r of arrayElementRanges(body, 'messages') ?? []) {
    if (body[r.start] !== 0x7b) continue;
    const m = body.subarray(r.start, r.end);
    if (topLevelValueRanges(m, 'role').length > 1 || topLevelValueRanges(m, 'content').length > 1) return true;
  }
  return false;
}

/**
 * Byte ranges of the messages and of the newest user-role message (spec 5.3 step 5): an assistant prefill after it is
 * not the last turn. No user message, or ranges that do not line up with the parsed array: no last turn.
 */
function turnRanges(body: Buffer, messages: unknown[]): Pick<ExtractedFeatures, 'lastTurn' | 'messages'> {
  if (messages.length === 0) return { lastTurn: null };
  const ranges = arrayElementRanges(body, 'messages');
  if (ranges === null || ranges.length !== messages.length) return { lastTurn: null };
  let index = -1;
  for (let i = messages.length - 1; i >= 0 && index < 0; i--) {
    const m = messages[i];
    if (isObj(m) && m.role === 'user') index = i;
  }
  const r = ranges[index];
  return { lastTurn: r === undefined ? null : { ...r, index }, messages: ranges };
}

/**
 * The body with only the bytes of the top-level `model` string replaced by `model` (JSON-escaped); every other byte is
 * kept. Null when the value cannot be located exactly: the body is not a JSON object, has no string `model`, or has
 * more than one top-level `model` key. The result is checked by parsing it back.
 */
export function rewriteTopLevelModel(b: Buffer, model: string): Buffer | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(b.toString('utf8'));
  } catch {
    return null;
  }
  if (!isObj(parsed) || typeof parsed.model !== 'string') return null;
  const ranges = topLevelValueRanges(b, 'model');
  const r = ranges[0];
  if (ranges.length !== 1 || r === undefined || b[r.start] !== QUOTE) return null;
  try {
    if (JSON.parse(b.toString('utf8', r.start, r.end)) !== parsed.model) return null;
  } catch {
    return null;
  }
  const out = Buffer.concat([b.subarray(0, r.start), Buffer.from(JSON.stringify(model), 'utf8'), b.subarray(r.end)]);
  try {
    const back = JSON.parse(out.toString('utf8')) as unknown;
    return isObj(back) && back.model === model ? out : null;
  } catch {
    return null;
  }
}
