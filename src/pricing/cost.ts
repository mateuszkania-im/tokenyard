// Cost of one request (spec 7.6). Prices are USD per million tokens, so tokens times price is micro-USD.
import type { Usage } from '../stream/anthropic-usage.js';
import { lookupModel, type PriceTable, type ServerToolFormat, serverToolPrice, serviceTierPrice } from './prices.js';

export interface CostOptions {
  /** Names from the table's `modifiers`, each multiplying every token bucket (for example `inferenceGeoUs`). */
  modifiers?: string[];
  /** Server tool uses by tool name, charged at `perUseUsd` each and not touched by modifiers. */
  serverToolUses?: Record<string, number>;
  /** Whose tools `serverToolUses` names (default `anthropic`): each provider's tools have their own prices (A2-3). */
  serverToolFormat?: ServerToolFormat;
  /** The response reported `usage.speed: "fast"`: the model's `fast` prices apply instead of the base prices and tiers. */
  fast?: boolean;
  /**
   * The OpenAI service tier the request was served on: its `serviceTiers` prices (and their tiers) replace the base
   * prices. `default` or none is standard; `auto` (the tier served is unknown) or a tier without prices throws.
   */
  serviceTier?: string | null;
}

/** The tier a response is billed at: the one it reports, else the one the request asked for; undefined for standard. */
export function billedServiceTier(u: { serviceTier?: string }, x: { serviceTier?: string }): string | undefined {
  const tier = u.serviceTier ?? x.serviceTier;
  return tier === undefined || tier === 'default' ? undefined : tier;
}

/**
 * Actual cost in integer micro-USD, rounded half up. The prompt length for tier selection is every input
 * bucket together (input, cache reads and cache writes); the highest tier whose threshold it exceeds applies.
 * Fast mode prices apply across the full context window (pricing page), so tiers are skipped for them.
 * Throws on an unknown model, modifier or server tool: the caller decides what an unpriced request means.
 */
export function costMicroUsd(t: PriceTable, modelId: string, u: Usage, o: CostOptions = {}): number {
  const found = lookupModel(t, modelId);
  if (!found) throw new Error(`unpriced model: ${modelId}`);
  const m = found.price;
  const promptTokens = u.input + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h;
  let p: { input: number; output: number; cacheWrite5m: number; cacheWrite1h: number; cacheRead: number } = m;
  let tiers = m.tiers ?? [];
  let above = -1;
  if (o.fast) {
    if (!m.fast) throw new Error(`unpriced fast mode: ${modelId}`);
    p = m.fast;
    tiers = [];
  } else if (o.serviceTier !== undefined && o.serviceTier !== null && o.serviceTier !== 'default') {
    const st = serviceTierPrice(m, o.serviceTier);
    if (!st) throw new Error(`unpriced service tier ${o.serviceTier}: ${modelId}`);
    p = st;
    tiers = st.tiers ?? [];
  }
  for (const tier of tiers) {
    if (promptTokens > tier.aboveInputTokens && tier.aboveInputTokens > above) {
      p = tier;
      above = tier.aboveInputTokens;
    }
  }
  let tokenCost = u.input * p.input + u.cacheWrite5m * p.cacheWrite5m + u.cacheWrite1h * p.cacheWrite1h + u.cacheRead * p.cacheRead + u.output * p.output;
  for (const name of o.modifiers ?? []) {
    const factor = Object.hasOwn(t.modifiers, name) ? t.modifiers[name] : undefined;
    if (factor === undefined) throw new Error(`unknown price modifier: ${name}`);
    tokenCost *= factor;
  }
  let toolCost = 0;
  for (const [name, uses] of Object.entries(o.serverToolUses ?? {})) {
    const tool = serverToolPrice(t, o.serverToolFormat ?? 'anthropic', name);
    if (!tool) throw new Error(`unpriced server tool: ${name}`);
    toolCost += uses * tool.perUseUsd * 1_000_000;
  }
  const cost = Math.round(tokenCost + toolCost);
  // Fail closed: a NaN or negative cost would slip past every budget comparison.
  if (!Number.isSafeInteger(cost) || cost < 0) throw new Error(`invalid cost for ${modelId}: ${cost}`);
  return cost;
}
