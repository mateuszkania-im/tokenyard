import { expect, test } from 'vitest';
import { classifyKey, type GatewayRun, type GatewaySample, growth, judge, linearFit, parseMetrics, type Point, SOAK_THRESHOLDS, type SoakJudgeInput } from '../../bench/soak-lib.js';

const every30s = (minutes: number, f: (t: number) => number): Point[] => Array.from({ length: (minutes * 60) / 30 + 1 }, (_, i) => ({ t: i * 30, v: f(i * 30) }));
const opts = { warmupS: 300, windowS: 300, maxPct: 10 };

test('linearFit is the least-squares line', () => {
  expect(linearFit([{ t: 0, v: 1 }, { t: 1, v: 3 }, { t: 2, v: 5 }])).toEqual({ slope: 2, intercept: 1 });
  expect(linearFit([{ t: 5, v: 7 }])).toEqual({ slope: 0, intercept: 7 });
});

test('a flat, noisy measure passes; warm-up growth is not counted', () => {
  // Fast growth during the first 5 minutes (warm-up), then a sawtooth around 120 MB.
  const g = growth(every30s(45, (t) => (t < 300 ? 60 + t / 5 : 120 + ((t / 30) % 4) * 3)), opts);
  expect(g.ok).toBe(true);
  expect(Math.abs(g.trendPct)).toBeLessThan(2);
});

test('a steady leak fails on the trend even when each window looks small', () => {
  // 100 MB growing 0.5 MB a minute: 20% over the 40 measured minutes.
  const g = growth(every30s(45, (t) => 100 + t / 120), opts);
  expect(g.ok).toBe(false);
  expect(g.trendPct).toBeGreaterThan(10);
  expect(g.slopePerHour).toBe(30);
});

test('a run too short for two windows after warm-up is not a pass', () => {
  expect(growth(every30s(9, () => 100), opts).ok).toBe(false);
  expect(growth(every30s(15, () => 100), opts).ok).toBe(true);
});

test('parseMetrics counts a histogram as one series per label set and sums plain metrics', () => {
  const text = [
    '# HELP tokenyard_added_ttfb_seconds x',
    '# TYPE tokenyard_added_ttfb_seconds histogram',
    'tokenyard_added_ttfb_seconds_bucket{le="0.001"} 3',
    'tokenyard_added_ttfb_seconds_bucket{le="+Inf"} 4',
    'tokenyard_added_ttfb_seconds_sum 0.01',
    'tokenyard_added_ttfb_seconds_count 4',
    '# TYPE tokenyard_inference_duration_seconds histogram',
    'tokenyard_inference_duration_seconds_bucket{provider="a",model="m",le="1"} 1',
    'tokenyard_inference_duration_seconds_bucket{provider="a",model="m",le="+Inf"} 1',
    'tokenyard_inference_duration_seconds_count{provider="a",model="m"} 1',
    '# TYPE tokenyard_requests_total counter',
    'tokenyard_requests_total{route="r",decision="forward",status_class="2xx"} 5',
    'tokenyard_requests_total{route="r",decision="block",status_class="4xx"} 2',
    '# TYPE tokenyard_reservations_open gauge',
    'tokenyard_reservations_open 0',
    '',
  ].join('\n');
  const m = parseMetrics(text);
  expect(m.byMetric).toEqual({ tokenyard_added_ttfb_seconds: 1, tokenyard_inference_duration_seconds: 1, tokenyard_requests_total: 2, tokenyard_reservations_open: 1 });
  expect(m.series).toBe(5);
  expect(m.totals.tokenyard_requests_total).toBe(7);
  expect(m.totals.tokenyard_reservations_open).toBe(0);
});

test('counter keys are classified by the src/limits/keys.ts layout', () => {
  const session = new Set(['session']);
  expect(classifyKey('ty:{acme}:b:team-day:web:2026-11-03', session)).toBe('budget-window');
  expect(classifyKey('ty:{acme}:b:session:abc%3Ad', session)).toBe('budget-session');
  expect(classifyKey('ty:{acme}:g:dev-rpm:key_1', session)).toBe('rate');
  expect(classifyKey('ty:{acme}:st:dev-streams:key_1', session)).toBe('streams');
  expect(classifyKey('ty:{acme}:taint:s:abc', session)).toBe('taint');
  expect(classifyKey('ty:{acme}:res:01J', session)).toBe('reservation');
  expect(classifyKey('ty:{acme}:deadlines', session)).toBe('deadlines');
  expect(classifyKey('ty:{_sweeper}:sweep-lock', session)).toBe('sweep-lock');
  expect(classifyKey('ty:{_global}:r11', session)).toBe('r11');
  expect(classifyKey('unrelated', session)).toBe('other');
});

function sample(t: number, over: Partial<GatewaySample> = {}): GatewaySample {
  return { t, rssMb: 120, heapMb: 40, externalMb: 5, fds: 60, tcpSockets: 20, handles: 30, eventLoopP50Ms: 10, eventLoopP99Ms: 12, eventLoopMaxMs: 20, series: 80, reservationsOpen: 0, traceFiles: 2, traceBytes: 1e6, ...over };
}

function healthyRun(): SoakJudgeInput {
  const gw: GatewayRun = {
    instance: 'a',
    idleBefore: sample(-10, { fds: 40, tcpSockets: 2, handles: 10, series: 3 }),
    idleAfter: sample(2700, { fds: 42, tcpSockets: 3, handles: 12 }),
    samples: every30s(45, (t) => t).map((p) => sample(p.t)),
    sweptTotal: 0,
    tracesDropped: 0,
    traceHours: 2,
    exitCode: 0,
    unexpectedStderr: [],
    uncaught: 0,
  };
  return {
    gateways: [gw],
    latency: every30s(45, () => 110),
    slotCheck: { keys: 2, admitted: 16, expectedAdmitted: 16, refusedExtra: 2, expectedRefused: 2 },
    redis: { reservationKeys: 0, deadlineKeys: 0, streamKeys: 0, reservedMicroUsd: 0, keysByClass: { 'budget-session': 10 }, bounds: { 'budget-session': 12 } },
    failedRequests: { socket: 0 },
  };
}

test('a healthy run passes every check', () => {
  const v = judge(healthyRun());
  expect(v.filter((x) => !x.ok)).toEqual([]);
  expect(v.length).toBeGreaterThan(10);
});

test('each leak signal fails its own check', () => {
  const failing = (edit: (r: SoakJudgeInput) => void): string[] => {
    const r = healthyRun();
    edit(r);
    return judge(r)
      .filter((x) => !x.ok)
      .map((x) => x.check);
  };
  const gw = (r: SoakJudgeInput): GatewayRun => r.gateways[0] as GatewayRun;
  expect(failing((r) => (gw(r).samples = gw(r).samples.map((s) => ({ ...s, heapMb: 40 + s.t / 100 }))))).toEqual(['a: heap used after GC growth']);
  expect(failing((r) => (gw(r).idleAfter.fds = 80))).toEqual(['a: open fds idle after vs before']);
  expect(failing((r) => (gw(r).idleAfter.reservationsOpen = 1))).toEqual(['a: open reservations after the load']);
  expect(failing((r) => (gw(r).sweptTotal = 3))).toEqual(['a: open reservations after the load']);
  expect(failing((r) => (gw(r).samples = gw(r).samples.map((s) => ({ ...s, series: s.t > 600 ? 200 : 80 }))))).toEqual(['a: metric series']);
  expect(failing((r) => (gw(r).unexpectedStderr = ['(node:1) MaxListenersExceededWarning: ...']))).toEqual(['a: process health']);
  expect(failing((r) => (r.slotCheck.admitted = 15))).toEqual(['stream slots after the load']);
  expect(failing((r) => ((r.redis as NonNullable<SoakJudgeInput['redis']>).reservedMicroUsd = 5))).toEqual(['Redis: reservations, deadlines and stream counts after the load']);
  expect(failing((r) => ((r.redis as NonNullable<SoakJudgeInput['redis']>).keysByClass['budget-session'] = 13))).toEqual(['Redis: keys per class within what the load could create']);
  expect(failing((r) => (r.latency = every30s(45, (t) => (t > 2000 ? 200 : 110))))).toEqual(['client total time p50 drift (2xx)']);
});

test('the thresholds are the ones stated in docs/benchmarks.md', () => {
  expect(SOAK_THRESHOLDS).toMatchObject({ warmupS: 300, windowS: 300, memoryGrowthPct: 10, seriesGrowth: 10, eventLoopP99Ms: 100 });
});
