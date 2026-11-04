// Estimator branches the V5 mutation run found unpinned: service tier price sets (auto, named, none), the unpriced
// envelope across fast and service tier prices, the output bound for absent or invalid max_tokens, the OpenAI tool
// loop (max_tool_calls + 1), the date suffix of tool types, zero and negative estimates, and the service tier and
// cache read rate of the session-aware estimate. Prices are small hand-made tables, so each expected value is exact.
import { expect, test } from 'vitest';
import { maxCacheWriteRate, maxInputRate, priceSets, reservationPrice, serverToolKey, sessionAwareMicroUsd, worstCaseMicroUsd } from '../../src/limits/estimator.js';
import type { RequestFeatures } from '../../src/policy/types.js';
import type { ModelPrice, PriceTable } from '../../src/pricing/prices.js';

const P = { source: 's', retrieved: 'r' };
const rates = (input: number, output: number, cacheRead = input / 10) => ({ input, output, cacheWrite5m: input, cacheWrite1h: input, cacheRead });
/** Base 1/10, a long-context tier 2/20, fast 6/60, service tiers priority 3/30 (with its own tier 4/40) and flex 0.5/5. */
const M: ModelPrice = {
  ...rates(1, 10), maxContextTokens: 1_000, maxOutputTokens: 100, ...P,
  tiers: [{ aboveInputTokens: 500, ...rates(2, 20) }],
  fast: { ...rates(6, 60), ...P },
  serviceTiers: { priority: { ...rates(3, 30), tiers: [{ aboveInputTokens: 500, ...rates(4, 40, 0.9) }], ...P }, flex: { ...rates(0.5, 5), ...P } },
};
/** No tiers of any kind. */
const PLAIN: ModelPrice = { ...rates(1, 10), maxContextTokens: 2_000, maxOutputTokens: 300, ...P };
const table = (models: Record<string, ModelPrice>, extra: Partial<PriceTable> = {}): PriceTable => ({ version: 'v', models, modifiers: {}, serverTools: {}, ...extra });
const T = table({ m: M, plain: PLAIN });
const OPTS = { serverToolsWithoutMaxUses: 'assume', assumedMaxUses: 3, reserveOutputTokens: null } as const;

const feat = (over: Partial<RequestFeatures> = {}): RequestFeatures => ({
  id: 'r', ts: 0, surface: 'anthropic-messages', traffic: 'product', billing: 'api', tenant: 't', team: null, keyId: 'k',
  model: 'm', stream: false, inputTokensBound: 10, boundKind: 'bytes', maxOutputTokens: 5, serverTools: [], toolCount: 0, thinking: false, fastMode: false,
  attribution: { session: null, agent: null, parentAgent: null, requestClass: null, agentType: null, promptId: null, repo: null, branch: null, ticket: null, feature: null },
  guardrail: { hits: [] },
  ...over,
});
const inputs = (sets: Array<{ input: number }>): number[] => sets.map((s) => s.input);

test('price sets: auto adds every service tier and its tiers to the base sets; a named tier replaces them; no tier is the base', () => {
  expect(inputs(priceSets(M))).toEqual([1, 2]);
  expect(inputs(priceSets(M, false, 'auto'))).toEqual([1, 2, 3, 4, 0.5]);
  expect(inputs(priceSets(M, false, 'priority'))).toEqual([3, 4]);
  expect(inputs(priceSets(M, false, 'flex'))).toEqual([0.5]);
  // a tier the model does not list falls back to the base (decide refuses it before this)
  expect(inputs(priceSets(M, false, 'scale'))).toEqual([1, 2]);
  expect(inputs(priceSets(PLAIN, false, 'auto'))).toEqual([1]);
  // fast replaces everything, and only when asked for
  expect(inputs(priceSets(M, true, 'priority'))).toEqual([6]);
  expect(inputs(priceSets(PLAIN, true))).toEqual([1]);
  expect(maxInputRate(M)).toBe(2);
  expect(maxCacheWriteRate(M)).toBe(2);
});

test('the unpriced envelope covers the most expensive fast and service tier prices of any model, and the largest limits', () => {
  const r = reservationPrice(T, 'not-in-the-table');
  expect(r.unpriced).toBe(true);
  // fast input 6 beats priority's tier 4; fast output 60 beats priority's tier 40
  expect(r.price).toMatchObject({ input: 6, output: 60, cacheWrite5m: 6, cacheWrite1h: 6, cacheRead: 6, maxContextTokens: 2_000, maxOutputTokens: 300 });
  expect(r.price.source).toBe('envelope of every model in the price table');
  expect(r.price.retrieved).toBe('v');
  // without fast prices the auto service tiers set the envelope
  const noFast = table({ m: { ...M, fast: undefined } as ModelPrice });
  expect(reservationPrice(noFast, null).price).toMatchObject({ input: 4, output: 40, maxOutputTokens: 100 });
  // fast cheaper than the dearest service tier: the auto tiers still count
  const cheapFast = table({ m: { ...M, fast: { ...rates(1.5, 15), ...P } } });
  expect(reservationPrice(cheapFast, null).price).toMatchObject({ input: 4, output: 40 });
  expect(() => reservationPrice(table({}), null)).toThrow('price table has no models');
  expect(reservationPrice(T, 'plain')).toEqual({ price: PLAIN, unpriced: false });
});

test('output bound: absent, zero, negative or non-finite max_tokens reserve the model maximum; a fraction rounds up', () => {
  const micro = (maxOutputTokens: number | null): number => worstCaseMicroUsd(feat({ model: 'plain', maxOutputTokens }), PLAIN, T, OPTS).micro;
  // 10 input tokens at 1 plus output at 10 per token
  expect(micro(5)).toBe(10 + 50);
  expect(micro(4.2)).toBe(10 + 50);
  for (const bad of [null, 0, -3, Number.NaN, Number.POSITIVE_INFINITY]) expect(micro(bad), String(bad)).toBe(10 + 300 * 10);
  expect(sessionAwareMicroUsd(feat({ model: 'plain', maxOutputTokens: 0 }), PLAIN, T, null, null)).toBe(10 + 300 * 10);
});

test('an OpenAI built-in tool reserves max_tool_calls + 1 sampling iterations; an Anthropic tool its maxIterations', () => {
  const t = table({ plain: PLAIN }, { serverTools: { 'openai/web_search': { perUseUsd: 0, maxIterations: 1, ...P }, web_search: { perUseUsd: 0, maxIterations: 2, ...P } } });
  const tool = (maxUses: number | null) => [{ type: 'web_search', maxUses }];
  // per iteration: the whole context (2,000) at 1 (+1 written on Responses) and the model maximum (300) at 10
  const openai = (maxUses: number | null): number => worstCaseMicroUsd(feat({ model: 'plain', surface: 'openai-responses', serverTools: tool(maxUses) }), PLAIN, t, OPTS).micro;
  expect(openai(4)).toBe(5 * (2_000 * 2 + 300 * 10));
  expect(openai(null)).toBe((3 + 1) * (2_000 * 2 + 300 * 10));
  expect(openai(0)).toBe(1 * (2_000 * 2 + 300 * 10));
  const anthropic = worstCaseMicroUsd(feat({ model: 'plain', serverTools: tool(4) }), PLAIN, t, OPTS).micro;
  expect(anthropic).toBe(2 * (2_000 + 300 * 10));
});

test('only a trailing 8-digit date suffix is dropped from a tool type', () => {
  expect(serverToolKey('web_search_20250305')).toBe('web_search');
  expect(serverToolKey('web_search_20250305_beta')).toBe('web_search_20250305_beta');
  expect(serverToolKey('web_search_2025030')).toBe('web_search_2025030');
});

test('a free model estimates 0, never an error; a negative estimate fails closed', () => {
  const free: ModelPrice = { ...PLAIN, ...rates(0, 0, 0) };
  expect(worstCaseMicroUsd(feat({ model: 'free' }), free, table({ free }), OPTS).micro).toBe(0);
  expect(sessionAwareMicroUsd(feat({ model: 'free' }), free, table({ free }), 0.5, null)).toBe(0);
  const negative = { ...PLAIN, ...rates(-1, -1, -1) } as ModelPrice;
  expect(() => worstCaseMicroUsd(feat({ model: 'neg' }), negative, table({ neg: negative }), OPTS)).toThrow(/invalid estimate/);
});

test('the service tier of the request sets both estimates; session-aware reads at the highest cache read rate of its sets', () => {
  const f = feat({ inputTokensBound: 10, maxOutputTokens: 5 });
  // base sets: input-side max 2 (the long-context tier), output max 20
  expect(worstCaseMicroUsd(f, M, T, OPTS).micro).toBe(10 * 2 + 5 * 20);
  // priority sets: input-side max 4, output max 40
  expect(worstCaseMicroUsd({ ...f, serviceTier: 'priority' }, M, T, OPTS).micro).toBe(10 * 4 + 5 * 40);
  expect(sessionAwareMicroUsd({ ...f, serviceTier: 'priority' }, M, T, 0, null)).toBe(10 * 4 + 5 * 40);
  // every input token a cache read: priority's highest cache read rate is its tier's 0.9, not the base 0.3
  expect(sessionAwareMicroUsd({ ...f, serviceTier: 'priority' }, M, T, 1, null)).toBe(Math.ceil(10 * 0.9 + 5 * 40));
  expect(sessionAwareMicroUsd(f, M, T, 1, null)).toBe(Math.ceil(10 * 0.2 + 5 * 20));
});
