// S21-2 (coordinator finding, Task 21, MEDIUM): metric labels came from client-controlled values (unbounded
// cardinality, series poisoning, line injection). Every label value now comes from a bounded set: request class and
// agent type map to their known enums else "other", the model is the priced id or "other", and a metric holds at most
// MAX_SERIES_PER_METRIC series.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { parsePriceTable } from '../../src/pricing/prices.js';
import { agentTypeLabel, createMetrics, createRequestRecorder, MAX_SERIES_PER_METRIC, modelLabel, requestClassLabel } from '../../src/telemetry/metrics.js';

const prices = parsePriceTable(readFileSync(join(import.meta.dirname, '..', '..', 'examples', 'policy', 'prices.yaml'), 'utf8'));

test('S21-2 10k hostile request-class, agent-type and model values make a handful of series and no injected line', () => {
  const m = createMetrics();
  const record = createRequestRecorder(m);
  for (let i = 0; i < 10_000; i++) {
    const hostile = `value-${i}-"}\ninjected_metric 1\n`;
    record(
      {
        tenant: 'acme', team: 'platform',
        attribution: { requestClass: i % 5 === 0 ? 'main' : hostile, agentType: hostile },
        decision: { route: 'claude-code', action: 'forward' },
        features: { model: `model-${i}` },
        outcome: { status: 200, addedTtfbMs: 1, costMicroUsd: 5, provider: 'anthropic', upstreamModel: `model-${i}`, totalMs: 5, ttfbMs: 2, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 } },
      } as never,
      prices,
    );
  }
  const text = m.render();
  expect(text.split('\n').filter((l) => l.startsWith('tokenyard_cost_usd_total{'))).toHaveLength(2);
  expect(text.split('\n').filter((l) => !l.startsWith('#') && l !== '').length).toBeLessThan(80);
  expect(text).not.toMatch(/value-\d|injected_metric|model-\d/);
});

test('S21-2 label mappers return the known value or a fixed fallback', () => {
  expect(requestClassLabel('compaction')).toBe('compaction');
  expect(requestClassLabel('Compaction')).toBe('other');
  expect(agentTypeLabel('Explore')).toBe('Explore');
  expect(agentTypeLabel('custom')).toBe('other');
  const priced = Object.keys(prices.models)[0] as string;
  expect(modelLabel(prices, priced)).toBe(priced);
  expect(modelLabel(prices, 'attacker-model-42')).toBe('other');
});

test('S21-2 a metric stops growing at MAX_SERIES_PER_METRIC series', () => {
  const m = createMetrics();
  for (let i = 0; i < MAX_SERIES_PER_METRIC + 100; i++) m.inc('tokenyard_cost_usd_total', { tenant: `t${i}`, team: 'x', route: 'r', request_class: 'main' }, 1);
  expect(m.render().split('\n').filter((l) => l.startsWith('tokenyard_cost_usd_total{'))).toHaveLength(MAX_SERIES_PER_METRIC);
});
