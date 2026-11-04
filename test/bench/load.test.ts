import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, test } from 'vitest';
import { BENCH_INPUTS, cpuRssSlopes, gitState, intendedStarts, percentiles, rowSaturated, runGit, throughput, ttfbVerdict } from '../../bench/lib.js';
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

test('a row is saturated at a full core, or when the gateway answered clearly less than offered, or drained well past its window (V1 fix round)', () => {
  const row = { concurrency: 500, ratePerConnection: 1.25, durationS: 10, gatewayCpuPct: 50, throughput: { gateway: { requestsPerS: 620, outputTokensPerS: 0, elapsedS: 10.1 } } };
  expect(rowSaturated(row)).toBe(false);
  expect(rowSaturated({ ...row, gatewayCpuPct: 95 })).toBe(true);
  // The Redis 150 KB row at 500 streams: 94.1% CPU, 322.9 of 625 offered requests a second, 19.36 s for a 10 s window.
  expect(rowSaturated({ ...row, gatewayCpuPct: 94.1, throughput: { gateway: { requestsPerS: 322.9, outputTokensPerS: 0, elapsedS: 19.36 } } })).toBe(true);
  expect(rowSaturated({ ...row, throughput: { gateway: { requestsPerS: 600, outputTokensPerS: 0, elapsedS: 12.5 } } })).toBe(true);
  // Rows measured before throughput existed fall back to the CPU rule.
  expect(rowSaturated({ concurrency: 500, ratePerConnection: 1.25, durationS: 10, gatewayCpuPct: 94 })).toBe(false);
  const lo = { store: 'redis', scenario: 'body-150kb', concurrency: 100, ratePerConnection: 1.25, durationS: 18, gatewayCpuPct: 60, rssGrowthMb: 10 };
  const hi = { ...row, store: 'redis', scenario: 'body-150kb', gatewayCpuPct: 94.1, rssGrowthMb: 30, throughput: { gateway: { requestsPerS: 322.9, outputTokensPerS: 0, elapsedS: 19.36 } } };
  expect(cpuRssSlopes([lo, hi], 100, 500)[0]?.saturated).toBe(true);
});

/** A throwaway git repository with one committed file under each benchmark input and a results file and README. */
function fixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ty-bench-git-'));
  const git = (...args: string[]): void => void execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
  git('init', '-q');
  for (const f of ['src/a.ts', 'bin/tokenyard.mjs', 'scripts/s.mjs', 'bench/results.json', 'README.md']) {
    mkdirSync(join(dir, dirname(f)), { recursive: true });
    writeFileSync(join(dir, f), 'one\n');
  }
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'one');
  return dir;
}

test('a run is dirty when the bundle or the scripts it runs have uncommitted changes, not when only its results or the README do (V5 review)', () => {
  expect(BENCH_INPUTS).toEqual(expect.arrayContaining(['src', 'bin', 'bench', 'scripts', 'package.json', 'package-lock.json']));
  const dir = fixtureRepo();
  try {
    const head = gitState(dir);
    expect(head.commit).toMatch(/^[0-9a-f]{7,}$/);
    expect(head.dirty).toBe(false);
    // The results file and README a run writes do not make it dirty.
    writeFileSync(join(dir, 'bench/results.json'), 'two\n');
    writeFileSync(join(dir, 'README.md'), 'two\n');
    expect(gitState(dir)).toEqual(head);
    for (const f of ['bin/tokenyard.mjs', 'scripts/s.mjs', 'scripts/new.mjs', 'src/a.ts']) {
      const before = existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8') : null;
      writeFileSync(join(dir, f), 'changed\n');
      expect(gitState(dir), f).toEqual({ commit: head.commit, dirty: true });
      if (before === null) rmSync(join(dir, f));
      else writeFileSync(join(dir, f), before);
      expect(gitState(dir), f).toEqual(head);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a run records the commit it started on, and is dirty when the tree was dirty at either end or HEAD moved during it (V5 review)', () => {
  const clean = { commit: 'aaaaaaa', dirty: false };
  expect(runGit(clean, clean)).toEqual(clean);
  expect(runGit(clean, { commit: 'bbbbbbb', dirty: false })).toEqual({ commit: 'aaaaaaa', dirty: true });
  expect(runGit({ commit: 'aaaaaaa', dirty: true }, clean)).toEqual({ commit: 'aaaaaaa', dirty: true });
  expect(runGit(clean, { commit: 'aaaaaaa', dirty: true })).toEqual({ commit: 'aaaaaaa', dirty: true });
});

test('several load processes split the connections as evenly as they can and never get none', async () => {
  const { splitConnections } = await import('../../bench/lib.js');
  expect(splitConnections(500, 3)).toEqual([167, 167, 166]);
  expect(splitConnections(10, 4)).toEqual([3, 3, 2, 2]);
  expect(splitConnections(2, 4)).toEqual([1, 1]);
  expect(splitConnections(500, 1)).toEqual([500]);
});

test('the loads of several processes merge into one: samples and counts add up, the run spans the earliest send to the latest answer', async () => {
  const { mergeLoads } = await import('../../bench/lib.js');
  const a = { intended: 10, ttfb: [1, 2], outside: [0.1], total: [5], ok: 2, dropped: 1, errorKinds: { ECONNRESET: 1 }, firstScheduledMs: 1_000, lastAnswerMs: 9_000 };
  const b = { intended: 12, ttfb: [3], outside: [0.2, 0.3], total: [6, 7], ok: 3, dropped: 0, errorKinds: { ECONNRESET: 2, '500': 1 }, firstScheduledMs: 900, lastAnswerMs: 9_500 };
  expect(mergeLoads([a, b])).toEqual({ intended: 22, ttfb: [1, 2, 3], outside: [0.1, 0.2, 0.3], total: [5, 6, 7], ok: 5, dropped: 1, errorKinds: { ECONNRESET: 3, '500': 1 }, firstScheduledMs: 900, lastAnswerMs: 9_500 });
});

test('with several gateway processes a row is saturated when any one process uses a full core, not when their sum passes one', () => {
  const base = { concurrency: 500, ratePerConnection: 1.25, durationS: 10, throughput: { gateway: { requestsPerS: 625, outputTokensPerS: 0, elapsedS: 10 } } };
  expect(rowSaturated({ ...base, gatewayCpuPct: 300, perProcessCpuPct: [70, 75, 80, 75] })).toBe(false);
  expect(rowSaturated({ ...base, gatewayCpuPct: 300, perProcessCpuPct: [60, 96, 70, 74] })).toBe(true);
  expect(rowSaturated({ ...base, gatewayCpuPct: 99 })).toBe(true); // one process, as before
});
