import { expect, test } from 'vitest';
import { cpuRssSlopes, intendedStarts, percentiles, ttfbVerdict } from '../../bench/lib.js';

test('intended send times are evenly spaced per connection from a phase inside the first interval, within the run', () => {
  expect(intendedStarts({ startMs: 1000, endMs: 2000, intervalMs: 250, phaseMs: 100 })).toEqual([1100, 1350, 1600, 1850]);
  expect(intendedStarts({ startMs: 0, endMs: 100, intervalMs: 250, phaseMs: 120 })).toEqual([]);
  expect(() => intendedStarts({ startMs: 0, endMs: 100, intervalMs: 250, phaseMs: 250 })).toThrow(/phase/);
});

test('percentiles are nearest-rank on the raw samples (no synthetic values) and report n', () => {
  const xs = Array.from({ length: 100 }, (_, i) => 100 - i);
  expect(percentiles(xs)).toEqual({ p50: 50, p95: 95, p99: 99, n: 100 });
  expect(percentiles([])).toEqual({ p50: null, p95: null, p99: null, n: 0 });
});

test('CPU and RSS per 100 streams are the slope between two concurrency levels', () => {
  const rows = [
    { store: 'memory', scenario: 's', concurrency: 100, gatewayCpuPct: 30, rssGrowthMb: 10 },
    { store: 'memory', scenario: 's', concurrency: 500, gatewayCpuPct: 70, rssGrowthMb: 30 },
    { store: 'redis', scenario: 's', concurrency: 100, gatewayCpuPct: 40, rssGrowthMb: 12 },
  ];
  expect(cpuRssSlopes(rows, 100, 500)).toEqual([{ store: 'memory', scenario: 's', from: 100, to: 500, cpuPctPer100Streams: 10, rssMbPer100Streams: 5, saturated: false }]);
  // A gateway at a full core or more at the upper level cannot use more CPU: the slope is flagged, not trusted.
  const hot = [rows[0] as (typeof rows)[number], { ...(rows[1] as (typeof rows)[number]), gatewayCpuPct: 99 }];
  expect(cpuRssSlopes(hot, 100, 500)[0]?.saturated).toBe(true);
});

test('an added TTFB verdict needs both the gateway measure and the client-side bound under target', () => {
  const p = (p50: number, p99: number) => ({ p50, p95: p99, p99, n: 2000 });
  expect(ttfbVerdict(p(1, 2), p(3, 9))).toBe(true);
  // The gateway's own measure misses time queued before it handles a request; the client-side bound catches it.
  expect(ttfbVerdict(p(0.04, 0.09), p(4.7, 677))).toBe(false);
  expect(ttfbVerdict(p(6, 9), p(3, 9))).toBe(false);
  expect(ttfbVerdict({ p50: null, p95: null, p99: null, n: 0 }, p(1, 2))).toBe(null);
});
