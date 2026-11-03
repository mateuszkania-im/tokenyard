import { expect, test } from 'vitest';
import { BENCH_END, BENCH_START, checkBenchBlock, renderBenchBlock, writeBenchBlock } from '../../scripts/bench-to-readme.mjs';

const pct = (p50: number, p95: number, p99: number) => ({ p50, p95, p99 });

/** A small but complete results object in the shape `npm run bench` writes. */
function results() {
  const row = (store: 'memory' | 'redis', concurrency: number) => ({
    scenario: 'streaming-500',
    store,
    concurrency,
    ratePerConnection: 1,
    durationS: 5,
    requests: { direct: 50, gateway: 50 },
    errors: { direct: 0, gateway: 0 },
    errorKinds: { direct: {}, gateway: {} },
    direct: { ttfb: pct(100.1, 101, 102), total: pct(600, 601, 602) },
    gateway: { ttfb: pct(101.3, 103, 110), total: pct(602, 604, 610) },
    added: { ttfb: pct(1.2, 2, 8), total: pct(2, 3, 8) },
    gatewayCpuPct: 12.5,
    cpuPctPer100Streams: 1.25,
    gatewayRssMb: 120.4,
    rssMbPer100Streams: 3.1,
  });
  return {
    schemaVersion: 1,
    runAt: '2026-11-03T10:00:00.000Z',
    git: { commit: 'abc1234', dirty: false },
    hardware: { cpu: 'Test CPU', cores: 8, memoryGb: 16, arch: 'arm64' },
    os: { platform: 'darwin', release: '27.0.0' },
    node: 'v22.14.0',
    tools: { autocannon: '8.0.0', tsx: '4.0.0', redis: '7.4.0' },
    quick: false,
    overhead: {
      method: 'autocannon, loopback, mock provider',
      mock: { ttftMs: 100, tokensPerSec: 1000 },
      redis: 'measured',
      rows: [row('memory', 10), row('memory', 100), row('redis', 10)],
    },
    budget: {
      runs: [
        {
          store: 'memory', estimator: 'worst-case', limitUsd: 1, requests: 1000, admitted: 40, rejected: 960, finalSpentUsd: 0.51, maxSpentPlusReservedUsd: 0.99,
          maxOverspendUsd: 0, spendDriftMicroUsd: 0, reservedLeftMicroUsd: 0, overruns: 0,
        },
      ],
      headroom: { bodyBytes: 150000, maxTokens: 32000, model: 'claude-opus-5-5', sessionBudgetUsd: 25, rows: [{ estimator: 'worst-case', reservationUsd: 2.11, inFlightAdmitted: 11, sent: 40 }], note: 'A note.' },
    },
    cache: { turns: 40, model: 'claude-opus-5-5', rows: [{ path: 'direct', costUsd: 1.5, inputTokens: 0, cacheReadTokens: 1000, cacheWriteTokens: 10, cacheHitRatio: 0.9 }] },
    scan: { bodyMb: 4, lastTurnMbPerS: 900, fullBodyMbPerS: 80, fpCorpus: { files: 300, mb: 9.1, blockHits: 0, documentedExamples: 2 } },
    replay: { records: 1000000, seconds: 30.5, recordsPerSecond: 32787, fileMb: 100, fidelityAgreement: 1 },
    calibration: {
      violations: 0,
      note: 'Live rows are aggregates.',
      sources: [{ source: 'demo', label: 'demo traffic (mock tokenizer)', requests: 10, boundKinds: { bytes: 10, 'context-window': 0 }, boundToActual: { min: 3.9, median: 4, max: 4.2 }, reservationToCost: { min: 5, median: 20, max: 80 }, violations: 0 }],
    },
    slo: [{ sli: 'Added TTFB p50 / p99, concurrency 10', target: 'under 5 ms / under 25 ms', measured: '1.2 ms / 8 ms', met: true }],
  };
}

const README = `# tokenyard\n\nIntro text.\n\n${BENCH_START}\nstale block\n${BENCH_END}\n\n## After\n\nMore text.\n`;

test('writeBenchBlock replaces only the block; checkBenchBlock fails on any drift', () => {
  const r = results();
  const out = writeBenchBlock(README, r);
  const [before, rest] = out.split(BENCH_START) as [string, string];
  const [block, after] = rest.split(BENCH_END) as [string, string];
  // Only the block changes.
  expect(before).toBe('# tokenyard\n\nIntro text.\n\n');
  expect(after).toBe('\n\n## After\n\nMore text.\n');
  expect(block).toBe(`\n${renderBenchBlock(r)}\n`);
  expect(block).not.toContain('stale block');
  expect(block).toContain('Test CPU');
  // Idempotent, and the written README checks clean.
  expect(writeBenchBlock(out, r)).toBe(out);
  expect(checkBenchBlock(out, r)).toBe(true);
  // The stale README, a hand edit inside the block, and any changed number in the results all fail.
  expect(checkBenchBlock(README, r)).toBe(false);
  expect(checkBenchBlock(out.replace('Test CPU', 'Other CPU'), r)).toBe(false);
  const drifted = results();
  drifted.replay.seconds = 30.6;
  expect(checkBenchBlock(out, drifted)).toBe(false);
  const drifted2 = results();
  (drifted2.overhead.rows[0] as { added: { ttfb: { p99: number } } }).added.ttfb.p99 = 9;
  expect(checkBenchBlock(out, drifted2)).toBe(false);
  // No markers, or markers out of order or repeated: write refuses, check fails.
  expect(() => writeBenchBlock('# no markers\n', r)).toThrow(/BENCH:START/);
  expect(checkBenchBlock('# no markers\n', r)).toBe(false);
  expect(() => writeBenchBlock(`${BENCH_END}\n${BENCH_START}\n`, r)).toThrow();
  expect(checkBenchBlock(`${out}\n${BENCH_START}\n${BENCH_END}\n`, r)).toBe(false);
});

test('the block holds no em dashes or arrow characters and says what was not measured', () => {
  const r = results();
  (r.overhead as { redis: string }).redis = 'not measured: Docker unavailable';
  r.overhead.rows = r.overhead.rows.filter((x) => x.store === 'memory');
  const block = renderBenchBlock(r);
  expect(block).not.toMatch(/[—–←-⇿⟵-⟿]/);
  expect(block).toContain('not measured: Docker unavailable');
  // A missed target is shown as missed.
  r.slo = [{ sli: 'Added TTFB p50 / p99, concurrency 500', target: 'under 5 ms / under 25 ms', measured: '9 ms / 80 ms', met: false }];
  expect(renderBenchBlock(r)).toMatch(/concurrency 500 \| under 5 ms \/ under 25 ms \| 9 ms \/ 80 ms \| missed/);
});
