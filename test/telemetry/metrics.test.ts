import { expect, test } from 'vitest';
import { createMetrics, MAX_VALUES_PER_LABEL, modelLabel, registerCollectors } from '../../src/telemetry/metrics.js';
import { parsePriceTable } from '../../src/pricing/prices.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const prices = parsePriceTable(readFileSync(join(import.meta.dirname, '..', '..', 'examples', 'policy', 'prices.yaml'), 'utf8'));

test('counters, gauges and histograms render in the Prometheus text format', () => {
  const m = createMetrics();
  m.inc('tokenyard_requests_total', { route: 'claude-code', decision: 'forward', status_class: '2xx' });
  m.inc('tokenyard_requests_total', { route: 'claude-code', decision: 'forward', status_class: '2xx' }, 2);
  m.set('tokenyard_cache_hit_ratio', 0.5);
  m.observe('tokenyard_added_ttfb_seconds', 0.003);
  const text = m.render();
  expect(text).toContain('# TYPE tokenyard_requests_total counter');
  expect(text).toContain('tokenyard_requests_total{route="claude-code",decision="forward",status_class="2xx"} 3');
  expect(text).toContain('tokenyard_cache_hit_ratio 0.5');
  expect(text).toContain('tokenyard_added_ttfb_seconds_bucket{le="0.0025"} 0');
  expect(text).toContain('tokenyard_added_ttfb_seconds_bucket{le="0.005"} 1');
  expect(text).toContain('tokenyard_added_ttfb_seconds_bucket{le="+Inf"} 1');
  expect(text).toContain('tokenyard_added_ttfb_seconds_count 1');
});

test('a hostile label value cannot inject a metric line', () => {
  const m = createMetrics();
  const evil = 'x"} 1\ntokenyard_cost_usd_total{tenant="evil"} 999\n# ';
  m.inc('tokenyard_requests_total', { route: evil, decision: 'forward', status_class: '2xx' });
  m.inc('tokenyard_should_retry_refusals_total', { reason: 'a\\b"c' });
  const lines = m.render().split('\n').filter((l) => l !== '');
  expect(lines.filter((l) => !l.startsWith('#') && !l.startsWith('tokenyard_requests_total{') && !l.startsWith('tokenyard_should_retry_refusals_total{'))).toEqual([]);
  expect(lines.some((l) => l.startsWith('tokenyard_cost_usd_total'))).toBe(false);
  // what survives the ingest filter is escaped: backslash and double quote
  expect(m.render()).toContain('tokenyard_should_retry_refusals_total{reason="a\\\\b\\"c"} 1');
});

test('only declared labels exist: a session, prompt or key label is dropped', () => {
  const m = createMetrics();
  m.inc('tokenyard_requests_total', { route: 'r', decision: 'forward', status_class: '2xx', session: 'sess-1', promptId: 'p1', key: 'ty_live_abc' });
  const text = m.render();
  expect(text).not.toMatch(/sess-1|p1|ty_live_abc|session|promptId/);
});

test('a label name keeps at most MAX_VALUES_PER_LABEL distinct values, the rest is "other"', () => {
  const m = createMetrics();
  for (let i = 0; i < MAX_VALUES_PER_LABEL + 20; i++) m.inc('tokenyard_cost_usd_total', { tenant: 't', team: 'x', route: 'r', request_class: `c${i}` }, 1);
  const series = m.render().split('\n').filter((l) => l.startsWith('tokenyard_cost_usd_total{'));
  expect(series.length).toBe(MAX_VALUES_PER_LABEL + 1);
  expect(series.some((l) => l.includes('request_class="other"} 20'))).toBe(true);
});

test('model labels are the priced model or "other"', () => {
  const some = Object.keys(prices.models)[0] as string;
  expect(modelLabel(prices, some)).toBe(some);
  expect(modelLabel(prices, 'attacker-model-42')).toBe('other');
  expect(modelLabel(prices, null)).toBe('other');
});

test('collectors refresh the policy info gauge (old revision removed), load errors and trace drops at each scrape', () => {
  const m = createMetrics();
  let rev = 'rev-a';
  let errors = 0;
  registerCollectors(m, { revision: () => rev, loadErrors: () => errors, traceDrops: () => 4 });
  expect(m.render()).toContain('tokenyard_policy_revision_info{revision="rev-a"} 1');
  rev = 'rev-b';
  errors = 2;
  const text = m.render();
  expect(text).toContain('tokenyard_policy_revision_info{revision="rev-b"} 1');
  expect(text).not.toContain('rev-a');
  expect(text).toContain('tokenyard_policy_load_errors_total 2');
  expect(text).toContain('tokenyard_traces_dropped_total 4');
});

test('negative or non-finite values are ignored for counters', () => {
  const m = createMetrics();
  m.inc('tokenyard_swept_total', {}, -1);
  m.inc('tokenyard_swept_total', {}, Number.NaN);
  m.inc('tokenyard_swept_total', {}, 2);
  expect(m.render()).toContain('tokenyard_swept_total 2');
});
