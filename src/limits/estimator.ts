// Reservation estimates (spec 7.3). Pure: no I/O. Prices are USD per million tokens, so tokens times price is micro-USD.
import type { RequestFeatures } from '../policy/types.js';
import { lookupModel, type ModelPrice, type PriceTable, serverToolFormat, serverToolPrice, serviceTierPrice } from '../pricing/prices.js';
import type { ExtractedFeatures } from '../surfaces/types.js';

/** Tokens the provider may add for the tool-use system prompt and message framing (286 to 406 on 5.5 models, pricing page). */
export const OVERHEAD_TOKENS = 4096;
/** Content block types whose tokens are bounded by their bytes in the body. */
export const TEXT_BLOCK_TYPES = ['text', 'thinking', 'redacted_thinking', 'tool_use', 'tool_result'] as const;

/**
 * OpenAI Responses input item and content part types whose tokens are bounded by their bytes: text parts, and tool
 * calls and their string outputs. Reasoning items are not on it: their `encrypted_content` is opaque, so how many
 * tokens it decrypts to is not bounded by its bytes; images, files and item references are expanded by the provider.
 */
export const RESPONSES_TEXT_TYPES = [
  'input_text', 'output_text', 'refusal', 'function_call', 'function_call_output', 'custom_tool_call', 'custom_tool_call_output',
  'local_shell_call', 'local_shell_call_output',
] as const;

const TEXT_TYPES: ReadonlySet<string> = new Set([...TEXT_BLOCK_TYPES, ...RESPONSES_TEXT_TYPES]);

/**
 * Float noise below this many micro-USD is dropped before rounding up, so an exact sum such as
 * 116,210,000 does not become 116,210,001. Safe: actual costs round half up, so a reservation that is low by
 * less than half a micro-USD (plus float error, about 1e-6 at 1e10 micro-USD) still covers them.
 */
const NOISE_MICRO = 1e-6;

/**
 * Upper bound on billed input tokens for one sampling iteration. `bytes` holds when every block is text-only and
 * nothing makes the provider add input (a byte-level tokenizer emits at most one token per byte, spec 7.3, R11);
 * anything else, a parse error or a missing model included, is bounded by the context window.
 */
export function inputTokenBound(x: ExtractedFeatures, m: ModelPrice): { tokens: number; kind: 'bytes' | 'context-window' } {
  const textOnly =
    !x.parseError &&
    x.model !== null &&
    !x.expandsServerSide &&
    x.serverTools.length === 0 &&
    x.blockTypes.every((t) => TEXT_TYPES.has(t));
  if (!textOnly) return { tokens: m.maxContextTokens, kind: 'context-window' };
  return { tokens: Math.min(x.bodyBytes + OVERHEAD_TOKENS, m.maxContextTokens), kind: 'bytes' };
}

type PriceSet = { input: number; output: number; cacheWrite5m: number; cacheWrite1h: number; cacheRead: number };

/**
 * The price sets a request may be billed at: fast mode prices when asked for and listed; for an OpenAI service tier its
 * `serviceTiers` prices and their tiers; for `auto` (the provider picks the tier) the base prices and every listed
 * service tier, so the highest applies; otherwise the base prices and their tiers. A named tier the model does not
 * list is refused before this (decide: `unpriced`); here it falls back to the base prices.
 */
export function priceSets(m: ModelPrice, fast = false, serviceTier: string | null = null): PriceSet[] {
  if (fast && m.fast) return [m.fast];
  const base: PriceSet[] = [m, ...(m.tiers ?? [])];
  if (serviceTier === 'auto') return [...base, ...Object.values(m.serviceTiers ?? {}).flatMap((st) => [st, ...(st.tiers ?? [])])];
  const st = serviceTier === null ? null : serviceTierPrice(m, serviceTier);
  return st ? [st, ...(st.tiers ?? [])] : base;
}

/** Highest input-side rate (input, cache writes, cache reads) across the request's price sets (`priceSets`). */
export function maxInputRate(m: ModelPrice, fast = false, serviceTier: string | null = null): number {
  return Math.max(...priceSets(m, fast, serviceTier).flatMap((p) => [p.input, p.cacheWrite5m, p.cacheWrite1h, p.cacheRead]));
}

/** Highest cache write rate across the request's price sets (`priceSets`). */
export function maxCacheWriteRate(m: ModelPrice, fast = false, serviceTier: string | null = null): number {
  return Math.max(...priceSets(m, fast, serviceTier).flatMap((p) => [p.cacheWrite5m, p.cacheWrite1h]));
}

/**
 * Highest rate one bounded input token can cost. On the Responses surface `cache_write_tokens` is billed on top of
 * `input_tokens` (ruling, until confirmed), and writes come from prompt tokens, so each input token may also be written
 * once: the input rate plus the write rate.
 */
function inputTokenRate(f: RequestFeatures, m: ModelPrice, fast: boolean, tier: string | null): number {
  return maxInputRate(m, fast, tier) + (f.surface === 'openai-responses' ? maxCacheWriteRate(m, fast, tier) : 0);
}

/** Highest output rate across the request's price sets (`priceSets`). */
export function maxOutputRate(m: ModelPrice, fast = false, serviceTier: string | null = null): number {
  return Math.max(...priceSets(m, fast, serviceTier).map((p) => p.output));
}

/** Product of every modifier above 1: the estimator assumes each one that raises the price may apply. */
export function modifierProduct(t: PriceTable): number {
  let product = 1;
  for (const factor of Object.values(t.modifiers)) if (factor > 1) product *= factor;
  return product;
}

/**
 * Prices for a reservation. A missing or unpriced model (spec 7.6, `allow-and-flag`) gets an envelope at least as
 * expensive as every model in the table: the highest input-side and output rates (fast mode included) and the
 * largest context window and output limit, so it covers the most expensive priced model.
 */
export function reservationPrice(t: PriceTable, model: string | null): { price: ModelPrice; unpriced: boolean } {
  const found = model === null ? null : lookupModel(t, model);
  if (found) return { price: found.price, unpriced: false };
  const models = Object.values(t.models);
  if (models.length === 0) throw new Error('price table has no models');
  const input = Math.max(...models.flatMap((m) => [maxInputRate(m, true), maxInputRate(m, false, 'auto')]));
  const output = Math.max(...models.flatMap((m) => [maxOutputRate(m, true), maxOutputRate(m, false, 'auto')]));
  return {
    price: {
      input, output, cacheWrite5m: input, cacheWrite1h: input, cacheRead: input,
      maxContextTokens: Math.max(...models.map((m) => m.maxContextTokens)),
      maxOutputTokens: Math.max(...models.map((m) => m.maxOutputTokens)),
      source: 'envelope of every model in the price table', retrieved: t.version,
    },
    unpriced: true,
  };
}

/** Output tokens one sampling iteration may bill: the request's own limit (or the model's), the route cap, the model cap. */
function outputTokenBound(f: RequestFeatures, m: ModelPrice, reserveOutputTokens: number | null): number {
  const asked = f.maxOutputTokens !== null && Number.isFinite(f.maxOutputTokens) && f.maxOutputTokens > 0 ? Math.ceil(f.maxOutputTokens) : m.maxOutputTokens;
  return Math.min(asked, reserveOutputTokens ?? Number.POSITIVE_INFINITY, m.maxOutputTokens);
}

/**
 * Sampling iterations the request may run: the highest `maxIterations` among its priced server tools, else 1. On the
 * Responses surface `max_tool_calls` caps the built-in tool calls of the response and each call may be followed by
 * one more sampling, so an OpenAI tool also counts `max_tool_calls + 1` (OpenAI documents no loop limit of its own).
 */
function loopIterations(f: RequestFeatures, t: PriceTable, assumedMaxUses: number): number {
  let iterations = 1;
  const format = serverToolFormat(f.surface);
  for (const tool of f.serverTools) {
    const price = serverToolPrice(t, format, serverToolKey(tool.type));
    if (!price) continue;
    iterations = Math.max(iterations, price.maxIterations);
    if (format === 'openai') iterations = Math.max(iterations, Math.ceil(tool.maxUses ?? assumedMaxUses) + 1);
  }
  return iterations;
}

/**
 * Output tokens the worst-case reservation covers: one iteration's bound, or `maxIterations * maxOutputTokens` with
 * server tools, plus one model-max summary per iteration under threshold compaction.
 */
function reservedOutputTokens(f: RequestFeatures, m: ModelPrice, t: PriceTable, reserveOutputTokens: number | null, assumedMaxUses: number): number {
  const iterations = loopIterations(f, t, assumedMaxUses);
  let out = f.serverTools.length > 0 ? iterations * m.maxOutputTokens : outputTokenBound(f, m, reserveOutputTokens);
  if (f.compaction === true) out += iterations * m.maxOutputTokens;
  return out;
}

/** Server tool type to its price table key: `web_search_20250305` is `web_search`. */
export function serverToolKey(type: string): string {
  return type.replace(/_\d{8}$/, '');
}

function roundUp(micro: number, what: string): number {
  const nearest = Math.round(micro);
  const result = Math.abs(micro - nearest) < NOISE_MICRO ? nearest : Math.ceil(micro);
  // Fail closed: a NaN, infinite or imprecise reservation would slip past every budget comparison.
  if (!Number.isSafeInteger(result) || result < 0) throw new Error(`invalid estimate for ${what}: ${micro}`);
  return result;
}

/**
 * Worst-case reservation in integer micro-USD, rounded up once on the final sum (spec 7.3). Under the premises of
 * spec 7.4 the actual cost of the request is never above it. `f.fastMode` on a model with fast prices uses them.
 * decide refuses fast mode on a priced model without them as unpriced before any estimate (CL-t9e); only the
 * envelope of an unpriced model (allow-and-flag) reaches here with fast mode and no fast block, and its base prices
 * already include every fast rate (reservationPrice).
 *
 * With server tools the provider may loop `maxIterations` times (the highest across the request's tools): input
 * is bounded by `maxIterations * maxContextTokens`, output by `maxIterations * maxOutputTokens`, and each tool's
 * fee by `max_uses * perUseUsd`. `block` names what the caller must refuse or flag: an unpriced server tool type
 * (micro then assumes 1 iteration and no fee for it, so it is no bound and `boundAssumed` is true), or a tool
 * without `max_uses` under `serverToolsWithoutMaxUses: block` (micro then prices `assumedMaxUses`).
 */
export function worstCaseMicroUsd(
  f: RequestFeatures,
  m: ModelPrice,
  t: PriceTable,
  o: { serverToolsWithoutMaxUses: 'block' | 'assume'; assumedMaxUses: number; reserveOutputTokens: number | null },
): { micro: number; boundAssumed: boolean; block: 'server-tool-no-max-uses' | 'unpriced-server-tool' | null } {
  const fast = f.fastMode && m.fast !== undefined;
  let inputTokens = f.inputTokensBound;
  const outputTokens = reservedOutputTokens(f, m, t, o.reserveOutputTokens, o.assumedMaxUses);
  let feeMicro = 0;
  let unpriced = false;
  let withoutMaxUses = false;
  const iterations = loopIterations(f, t, o.assumedMaxUses);
  const format = serverToolFormat(f.surface);
  if (f.serverTools.length > 0) {
    for (const tool of f.serverTools) {
      // Priced per provider (A2-3): an OpenAI tool is never priced with an Anthropic entry of the same name.
      const price = serverToolPrice(t, format, serverToolKey(tool.type));
      if (!price) {
        unpriced = true;
        continue;
      }
      let uses = tool.maxUses;
      if (uses === null) {
        withoutMaxUses = true;
        uses = o.assumedMaxUses;
      }
      feeMicro += Math.max(0, Math.ceil(uses)) * price.perUseUsd * 1_000_000;
    }
    inputTokens = iterations * m.maxContextTokens;
  }
  // Threshold compaction: before each sampling iteration the provider may run a compaction iteration over the whole
  // context, and its summary has no documented limit below the model's output cap (A4; output in reservedOutputTokens).
  if (f.compaction === true) inputTokens += iterations * m.maxContextTokens;
  const tier = f.serviceTier ?? null;
  const tokenMicro = (inputTokens * inputTokenRate(f, m, fast, tier) + outputTokens * maxOutputRate(m, fast, tier)) * modifierProduct(t);
  const micro = roundUp(tokenMicro + feeMicro, f.model);
  const block = unpriced ? 'unpriced-server-tool' : withoutMaxUses && o.serverToolsWithoutMaxUses === 'block' ? 'server-tool-no-max-uses' : null;
  return { micro, boundAssumed: unpriced || withoutMaxUses, block };
}

/**
 * `session-aware` estimate (spec 7.3): no hard bound. Input tokens are priced with the cache read share of the
 * session's previous request (read share at the highest cache read rate, the rest at the highest input-side rate;
 * no previous request means share 0), output as `min(max_tokens, reserveOutputTokens)`. Server tool loops and fees
 * are not estimated here.
 */
export function sessionAwareMicroUsd(
  f: RequestFeatures,
  m: ModelPrice,
  t: PriceTable,
  prevCacheReadShare: number | null,
  reserveOutputTokens: number | null,
): number {
  const fast = f.fastMode && m.fast !== undefined;
  const share = prevCacheReadShare === null || Number.isNaN(prevCacheReadShare) ? 0 : Math.min(1, Math.max(0, prevCacheReadShare));
  const tier = f.serviceTier ?? null;
  const readRate = Math.max(...priceSets(m, fast, tier).map((p) => p.cacheRead));
  const inputMicro = f.inputTokensBound * (share * readRate + (1 - share) * inputTokenRate(f, m, fast, tier));
  const outputMicro = outputTokenBound(f, m, reserveOutputTokens) * maxOutputRate(m, fast, tier);
  return roundUp((inputMicro + outputMicro) * modifierProduct(t), f.model);
}
