import { expect, test } from 'vitest';
import { costMicroUsd } from '../../src/pricing/cost.js';
import { parsePriceTable } from '../../src/pricing/prices.js';
import { loadPrices } from '../helpers/prices.js';

const t = loadPrices();
const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };

test('cost of Opus 5.5 usage in micro-USD', () => {
  // input 1000*4 + cw5m 2000*5 + cw1h 3000*8 + read 10000*0.2 + output 500*20 = 4000+10000+24000+2000+10000
  expect(costMicroUsd(t, 'claude-opus-5-5', { input: 1000, cacheWrite5m: 2000, cacheWrite1h: 3000, cacheRead: 10000, output: 500 })).toBe(50_000);
});

test('inferenceGeoUs modifier multiplies every bucket by 1.1', () => {
  const u = { input: 1000, cacheWrite5m: 2000, cacheWrite1h: 3000, cacheRead: 10000, output: 500 };
  expect(costMicroUsd(t, 'claude-opus-5-5', u, { modifiers: ['inferenceGeoUs'] })).toBe(55_000);
  for (const k of Object.keys(zero) as Array<keyof typeof zero>) {
    const one = { ...zero, [k]: 1_000_000 };
    expect(costMicroUsd(t, 'claude-opus-5-5', one, { modifiers: ['inferenceGeoUs'] })).toBe(Math.round(costMicroUsd(t, 'claude-opus-5-5', one) * 1.1));
  }
});

test('tier above 100k input tokens uses the tier prices, counting reads and writes in the prompt length', () => {
  // 100,000 total is not over the threshold: base prices (0.1 input, 0.5 output).
  expect(costMicroUsd(t, 'claude-haiku-5-5', { ...zero, input: 100_000, output: 1000 })).toBe(10_000 + 500);
  // 100,001 is over: tier prices (0.5 input, 2.5 output).
  expect(costMicroUsd(t, 'claude-haiku-5-5', { ...zero, input: 100_001, output: 1000 })).toBe(50_001 + 2500);
  // cache reads count toward the prompt length: 60k + 50k = 110k, tier read price 0.05, tier input 0.5.
  expect(costMicroUsd(t, 'claude-haiku-5-5', { ...zero, input: 60_000, cacheRead: 50_000 })).toBe(30_000 + 2500);
  // the modifier applies to the tier as well.
  expect(costMicroUsd(t, 'claude-haiku-5-5', { ...zero, input: 200_000 }, { modifiers: ['inferenceGeoUs'] })).toBe(110_000);
});

test('dated ids price like their table entry; unknown model, modifier or server tool throws', () => {
  expect(costMicroUsd(t, 'claude-opus-5-5-20261001', { ...zero, output: 1000 })).toBe(20_000);
  expect(() => costMicroUsd(t, 'claude-nope', zero)).toThrow(/unpriced model/);
  expect(() => costMicroUsd(t, 'claude-opus-5-5', zero, { modifiers: ['nope'] })).toThrow(/modifier/);
  expect(() => costMicroUsd(t, 'claude-opus-5-5', zero, { serverToolUses: { web_search: 1 } })).toThrow(/server tool/);
});

test('server tool uses add perUseUsd each, and the final sum rounds half up', () => {
  const st = parsePriceTable(`
version: x
models:
  claude-a: { input: 0.5, output: 1, cacheWrite5m: 1, cacheWrite1h: 1, cacheRead: 1, maxContextTokens: 10, maxOutputTokens: 10, source: s, retrieved: r }
modifiers: {}
serverTools:
  web_search: { perUseUsd: 0.01, maxIterations: 10, source: s, retrieved: r }
`);
  expect(costMicroUsd(st, 'claude-a', { ...zero, output: 5 }, { serverToolUses: { web_search: 3 } })).toBe(30_000 + 5);
  expect(costMicroUsd(st, 'claude-a', { ...zero, input: 1 })).toBe(1); // 0.5 rounds up
  expect(costMicroUsd(st, 'claude-a', { ...zero, input: 3 })).toBe(2); // 1.5 rounds up
});
