// Frozen copy of the file of the same name in src/surfaces at 5ad6f31, before the V1 performance work. Test-only:
// test/surfaces/walker-differential.test.ts holds the optimised walkers to exactly these results. Do not edit.
import { createHash } from 'node:crypto';
import { arrayElementRanges, topLevelValueRanges } from './json-ranges.js';
import { serviceTierLabel, toolTypeLabel } from '../../../src/surfaces/labels.js';
import type { ExtractedFeatures } from '../../../src/surfaces/types.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Tools the caller defines and runs itself: bounded by their bytes in the body. */
const USER_TOOL_TYPES: ReadonlySet<string> = new Set(['function', 'custom']);
/**
 * OpenAI-defined tools the client runs when they carry no hosted environment. OpenAI adds their definitions on its
 * side, so like Anthropic-defined client tools they force the context-window bound (`expandsServerSide`). With an
 * `environment` other than `{ type: "local" }`, or a `container`, they run in OpenAI-managed containers with a
 * server-side loop and billed container time: server tools.
 * Every other tool `type` (web_search, file_search, code_interpreter, mcp, image_generation, computer use, and any type
 * added after these lists) lands in `serverTools`: denied unless the route lists it, and unbounded unless it is priced.
 */
const OPENAI_CLIENT_TOOL_TYPES: ReadonlySet<string> = new Set(['local_shell', 'shell', 'apply_patch']);

/** Runs on the client: no environment, or `{ type: "local" }`, and no container. */
const runsLocally = (t: Obj): boolean => t.container === undefined && (t.environment === undefined || (isObj(t.environment) && t.environment.type === 'local' && Object.keys(t.environment).length === 1));
/**
 * Top-level Responses fields that add no input on the provider side beyond the body's own bytes. Any other field
 * (`previous_response_id` and `conversation` load stored input, `prompt` a stored template, `background`, a field added
 * after this list) sets `expandsServerSide`, so the input bound falls back to the context window (spec 7.3).
 */
const PLAIN_FIELDS: ReadonlySet<string> = new Set([
  'model', 'input', 'instructions', 'tools', 'tool_choice', 'parallel_tool_calls', 'max_output_tokens', 'max_tool_calls',
  'stream', 'stream_options', 'store', 'include', 'metadata', 'temperature', 'top_p', 'top_logprobs', 'truncation',
  'reasoning', 'text', 'prompt_cache_key', 'prompt_cache_retention', 'safety_identifier', 'user', 'service_tier',
  // Codex 0.166.0 sends session, thread and turn ids here on every request (seen live): request metadata, like `metadata`.
  'client_metadata',
]);

function emptyFeatures(bodyBytes: number): ExtractedFeatures {
  return {
    model: null, stream: false, maxOutputTokens: null, toolCount: 0, thinking: false, serverTools: [], bodyBytes,
    prefixHash: null, blockTypes: [], expandsServerSide: false, fastMode: false, parseError: true, lastTurn: null,
  };
}

/** Item and content part types of `input`: a message's parts, a tool output's parts, every other item's own type. */
function collectTypes(input: unknown, out: Set<string>): void {
  if (typeof input === 'string') {
    out.add('input_text');
    return;
  }
  if (!Array.isArray(input)) return;
  for (const item of input) {
    if (!isObj(item)) {
      out.add('(invalid)');
      continue;
    }
    const type = typeof item.type === 'string' ? item.type : item.role !== undefined ? 'message' : '(untyped)';
    if (type === 'message') {
      if (typeof item.content === 'string') out.add('input_text');
      else if (Array.isArray(item.content)) for (const part of item.content) out.add(isObj(part) && typeof part.type === 'string' ? part.type : '(invalid)');
      else out.add('(invalid)');
      continue;
    }
    out.add(type);
    // Tool outputs are a string, or an array of parts (text, image, file).
    if (Array.isArray(item.output)) for (const part of item.output) out.add(isObj(part) && typeof part.type === 'string' ? part.type : '(invalid)');
    else if (item.output !== undefined && typeof item.output !== 'string') out.add('(invalid)');
  }
}

/** Namespaces nest this deep at most; anything deeper counts as a server tool. */
const MAX_NAMESPACE_DEPTH = 4;

/**
 * Server tools among `tools`. A `namespace` (Codex 0.166.0 groups its sub-agent function tools in one) is a container:
 * its own tools are classified the same way, so a built-in tool cannot hide inside one. A namespace without a tools
 * array, or nested too deep, counts as a server tool itself.
 */
function collectServerTools(tools: unknown[], maxUses: number | null, out: ExtractedFeatures['serverTools'], depth: number, seen: { openaiClient: boolean }): void {
  for (const t of tools) {
    const type = isObj(t) ? (typeof t.type === 'string' ? t.type : String(t.type)) : '(invalid)';
    if (isObj(t) && USER_TOOL_TYPES.has(type)) continue;
    if (isObj(t) && OPENAI_CLIENT_TOOL_TYPES.has(type) && runsLocally(t)) {
      seen.openaiClient = true;
      continue;
    }
    if (type === 'namespace' && isObj(t) && Array.isArray(t.tools) && depth < MAX_NAMESPACE_DEPTH) {
      collectServerTools(t.tools, maxUses, out, depth + 1, seen);
      continue;
    }
    // The type reaches traces and spans: free text in it is replaced, never copied (B1).
    out.push({ type: toolTypeLabel(type), maxUses });
  }
}

function hasExpandingField(parsed: Obj): boolean {
  for (const key of Object.keys(parsed)) if (!PLAIN_FIELDS.has(key)) return true;
  if (parsed.instructions !== undefined && parsed.instructions !== null && typeof parsed.instructions !== 'string') return true;
  // A structured output format is not documented as adding no input (as in the Anthropic surface); verbosity is plain.
  const text = parsed.text;
  if (text !== undefined && !(isObj(text) && (text.format == null || (isObj(text.format) && text.format.type === 'text')))) return true;
  if (parsed.input !== undefined && typeof parsed.input !== 'string' && !Array.isArray(parsed.input)) return true;
  return false;
}

/** Messages from the user, developer or system, and tool outputs: what the client adds to the conversation. */
const isClientItem = (item: unknown): boolean =>
  isObj(item) && ((item.type === undefined || item.type === 'message') ? item.role !== 'assistant' : typeof item.type === 'string' && item.type.endsWith('_output'));

/**
 * The newest turn for the guardrail scanner (spec 5.3 step 5): the trailing client items of `input` (the newest user
 * message with the tool outputs after it, as an Anthropic user message carries its tool_result blocks), else the
 * newest user message. A string `input` is the whole turn. Ranges that do not line up with the parsed array: none.
 */
function turnRanges(body: Buffer, input: unknown): Pick<ExtractedFeatures, 'lastTurn' | 'messages'> {
  if (typeof input === 'string') {
    const r = topLevelValueRanges(body, 'input')[0];
    return r === undefined ? { lastTurn: null } : { lastTurn: { ...r, index: 0 }, messages: [r] };
  }
  if (!Array.isArray(input) || input.length === 0) return { lastTurn: null };
  const ranges = arrayElementRanges(body, 'input');
  if (ranges === null || ranges.length !== input.length) return { lastTurn: null };
  let first = input.length;
  while (first > 0 && isClientItem(input[first - 1])) first--;
  const lastRange = ranges.at(-1);
  const firstRange = ranges[first];
  if (firstRange !== undefined && lastRange !== undefined) return { lastTurn: { start: firstRange.start, end: lastRange.end, index: first }, messages: ranges };
  for (let i = input.length - 1; i >= 0; i--) {
    const m = input[i];
    const r = ranges[i];
    if (isObj(m) && m.role === 'user' && r !== undefined) return { lastTurn: { ...r, index: i }, messages: ranges };
  }
  return { lastTurn: null, messages: ranges };
}

/** A duplicate top-level `input`, `instructions` or `model`, or an input item with a duplicate content-bearing key. */
function hasAmbiguousKeys(body: Buffer): boolean {
  for (const k of ['input', 'instructions', 'model', 'tools']) if (topLevelValueRanges(body, k).length > 1) return true;
  for (const r of arrayElementRanges(body, 'input') ?? []) {
    if (body[r.start] !== 0x7b) continue;
    const item = body.subarray(r.start, r.end);
    for (const k of ['type', 'role', 'content', 'output', 'arguments', 'input']) if (topLevelValueRanges(item, k).length > 1) return true;
  }
  return false;
}

/**
 * Feature extraction for `/v1/responses` (spec 5.4): one read-only `JSON.parse` of the body. The parsed object is
 * discarded; the body forwarded upstream is the original Buffer, encrypted reasoning items and unknown fields included.
 */
export function extractResponsesFeatures(body: Buffer): ExtractedFeatures {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return emptyFeatures(body.length);
  }
  if (!isObj(parsed)) return emptyFeatures(body.length);

  const tools = Array.isArray(parsed.tools) ? parsed.tools : [];
  // `max_tool_calls` caps every built-in tool call of the response together, so it bounds each tool's uses.
  const maxUses = typeof parsed.max_tool_calls === 'number' && Number.isFinite(parsed.max_tool_calls) && parsed.max_tool_calls >= 0 ? parsed.max_tool_calls : null;
  const serverTools: ExtractedFeatures['serverTools'] = [];
  const seen = { openaiClient: false };
  collectServerTools(tools, maxUses, serverTools, 0, seen);

  const types = new Set<string>();
  collectTypes(parsed.input, types);
  const prefixHash =
    parsed.tools !== undefined || parsed.instructions !== undefined
      ? createHash('sha256').update(JSON.stringify([parsed.tools ?? null, parsed.instructions ?? null])).digest('hex')
      : null;
  const reasoning = parsed.reasoning;
  return {
    model: typeof parsed.model === 'string' ? parsed.model : null,
    stream: parsed.stream === true,
    maxOutputTokens: typeof parsed.max_output_tokens === 'number' ? parsed.max_output_tokens : null,
    toolCount: tools.length,
    thinking: isObj(reasoning) && reasoning.effort !== 'none',
    serverTools,
    bodyBytes: body.length,
    prefixHash,
    blockTypes: [...types],
    expandsServerSide: seen.openaiClient || hasExpandingField(parsed),
    fastMode: false,
    ...(parsed.service_tier === undefined || parsed.service_tier === null || parsed.service_tier === 'default' ? {} : { serviceTier: typeof parsed.service_tier === 'string' ? serviceTierLabel(parsed.service_tier) : 'other' }),
    parseError: false,
    ...turnRanges(body, parsed.input),
    ...(hasAmbiguousKeys(body) ? { ambiguousKeys: true as const } : {}),
  };
}
