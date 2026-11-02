import { expect, test } from 'vitest';
import { lookupModel, parsePriceTable } from '../../src/pricing/prices.js';
import { loadPrices } from '../helpers/prices.js';

test('the example price table parses and every model carries source, date, context and output limits', () => {
  const t = loadPrices();
  expect(t.version).toBe('2026-11-02');
  expect(Object.keys(t.models)).toEqual(expect.arrayContaining(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1']));
  for (const [id, m] of Object.entries(t.models)) {
    expect(m.source, id).toMatch(/^https:\/\//);
    expect(m.retrieved, id).toBe('2026-11-02');
    expect(m.maxContextTokens, id).toBeGreaterThan(0);
    expect(m.maxOutputTokens, id).toBeGreaterThan(0);
  }
  expect(t.modifiers.inferenceGeoUs).toBe(1.1);
});

test('dated model id resolves to its table entry; unknown returns null', () => {
  const t = loadPrices();
  expect(lookupModel(t, 'claude-opus-5-5')?.id).toBe('claude-opus-5-5');
  expect(lookupModel(t, 'claude-opus-5-5-20261001')?.id).toBe('claude-opus-5-5');
  expect(lookupModel(t, 'claude-opus-5-50')).toBeNull();
  expect(lookupModel(t, 'claude-opus-9')).toBeNull();
});

test('lookup picks the longest table id that prefixes the model', () => {
  const t = parsePriceTable(`
version: x
models:
  claude-a: { input: 1, output: 1, cacheWrite5m: 1, cacheWrite1h: 1, cacheRead: 1, maxContextTokens: 10, maxOutputTokens: 10, source: s, retrieved: r }
  claude-a-b: { input: 2, output: 2, cacheWrite5m: 2, cacheWrite1h: 2, cacheRead: 2, maxContextTokens: 10, maxOutputTokens: 10, source: s, retrieved: r }
modifiers: {}
serverTools: {}
`);
  expect(lookupModel(t, 'claude-a-b-20260101')?.id).toBe('claude-a-b');
  expect(lookupModel(t, 'claude-a-20260101')?.id).toBe('claude-a');
});

test('price table without maxContextTokens is rejected', () => {
  const text = `
version: x
models:
  claude-a: { input: 1, output: 1, cacheWrite5m: 1, cacheWrite1h: 1, cacheRead: 1, maxOutputTokens: 10, source: s, retrieved: r }
modifiers: {}
serverTools: {}
`;
  expect(() => parsePriceTable(text)).toThrow(/maxContextTokens/);
});

test('server tools parse with per-use price and iteration cap', () => {
  const t = parsePriceTable(`
version: x
models: {}
modifiers: {}
serverTools:
  web_search: { perUseUsd: 0.01, maxIterations: 10, source: s, retrieved: r }
`);
  expect(t.serverTools.web_search?.perUseUsd).toBe(0.01);
});

test('lookupModel only resolves own table entries, never Object.prototype members', () => {
  const t = loadPrices();
  for (const id of ['__proto__', 'constructor', 'hasOwnProperty', 'toString', 'constructor-20261102', 'toString-20261102']) {
    expect(lookupModel(t, id), id).toBeNull();
  }
});

test('a price table with a __proto__ key is rejected and does not pollute Object.prototype', () => {
  const entry = '{ input: 1, output: 1, cacheWrite5m: 1, cacheWrite1h: 1, cacheRead: 1, maxContextTokens: 10, maxOutputTokens: 10, source: s, retrieved: r }';
  for (const text of [
    `version: x\nmodels:\n  "__proto__": ${entry}\nmodifiers: {}\nserverTools: {}\n`,
    `version: x\nmodels: {}\nmodifiers:\n  "__proto__": 2\nserverTools: {}\n`,
    `version: x\nmodels: {}\nmodifiers: {}\nserverTools:\n  "__proto__": { perUseUsd: 1, maxIterations: 1, source: s, retrieved: r }\n`,
  ]) {
    expect(() => parsePriceTable(text)).toThrow(/__proto__/);
  }
  expect(({} as Record<string, unknown>).input).toBeUndefined();
});

test('example table: Opus 5.5 fast prices and web_search are sourced from the docs', () => {
  const t = loadPrices();
  const fast = t.models['claude-opus-5-5']?.fast;
  expect(fast).toMatchObject({ input: 8, output: 40, cacheWrite5m: 10, cacheWrite1h: 16, cacheRead: 0.4, retrieved: '2026-11-02' });
  expect(fast?.source).toContain('https://platform.claude.com/docs/en/about-claude/pricing');
  expect(t.models['claude-sonnet-5-5']?.fast).toBeUndefined();
  expect(t.serverTools.web_search).toMatchObject({ perUseUsd: 0.01, maxIterations: 10, retrieved: '2026-11-02' });
  expect(t.serverTools.web_search?.source).toContain('https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons');
});

test('a fast block must be complete', () => {
  const text = (fast: string) => `
version: x
models:
  claude-a: { input: 1, output: 1, cacheWrite5m: 1, cacheWrite1h: 1, cacheRead: 1, maxContextTokens: 10, maxOutputTokens: 10, source: s, retrieved: r, fast: ${fast} }
`;
  expect(parsePriceTable(text('{ input: 2, output: 2, cacheWrite5m: 2, cacheWrite1h: 2, cacheRead: 2, source: s, retrieved: r }')).models['claude-a']?.fast?.input).toBe(2);
  expect(() => parsePriceTable(text('{ input: 2, output: 2, source: s, retrieved: r }'))).toThrow(/fast/);
});
