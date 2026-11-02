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
