import { expect, test } from 'vitest';
import { cpuRssSlopes, intendedStarts, percentiles, throughput, ttfbVerdict } from '../../bench/lib.js';
import { profileArgs } from '../../bench/overhead.js';

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

test('throughput is answered requests and output tokens per second of the run, from its first scheduled send to its last answer (V1)', () => {
  expect(throughput({ answered: 500, outputTokens: 250_000, firstScheduledMs: 1_000, lastAnswerMs: 11_000 })).toEqual({ requestsPerS: 50, outputTokensPerS: 25_000, elapsedS: 10 });
  // A saturated path drains past its window: the same answers over a longer run are a lower rate, never a negative one.
  expect(throughput({ answered: 500, outputTokens: 250_000, firstScheduledMs: 1_000, lastAnswerMs: 21_000 })).toEqual({ requestsPerS: 25, outputTokensPerS: 12_500, elapsedS: 20 });
  expect(throughput({ answered: 0, outputTokens: 0, firstScheduledMs: 1_000, lastAnswerMs: 0 })).toEqual({ requestsPerS: 0, outputTokensPerS: 0, elapsedS: 0 });
});

test('BENCH_CPU_PROF profiles the gateway child only, into the named directory (V1)', () => {
  expect(profileArgs('gateway', '/tmp/prof')).toEqual(['--cpu-prof', '--cpu-prof-dir=/tmp/prof']);
  expect(profileArgs('mock', '/tmp/prof')).toEqual([]);
  expect(profileArgs('gateway', undefined)).toEqual([]);
});

test('a full bench run keeps the soak section that npm run soak wrote (V2)', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { keptSoak } = await import('../../bench/lib.js');
  const dir = mkdtempSync(join(tmpdir(), 'ty-soak-keep-'));
  try {
    const file = join(dir, 'results.json');
    expect(keptSoak(file)).toEqual({});
    writeFileSync(file, JSON.stringify({ overhead: {}, soak: { runs: [{ mode: 'memory' }] } }));
    expect(keptSoak(file)).toEqual({ soak: { runs: [{ mode: 'memory' }] } });
    writeFileSync(file, JSON.stringify({ overhead: {} }));
    expect(keptSoak(file)).toEqual({});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
