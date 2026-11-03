import { expect, test } from 'vitest';
import { BENCH_END, BENCH_START, checkBenchBlock, renderBenchBlock, writeBenchBlock } from '../../scripts/bench-to-readme.mjs';

const pct = (p50: number, p95: number, p99: number) => ({ p50, p95, p99 });

/** A small but complete results object in the shape `npm run bench` writes. */
function results() {
  const row = (store: 'memory' | 'redis', concurrency: number) => ({
    scenario: 'streaming-500',
    store,
    concurrency,
    ratePerConnection: 1.25,
    durationS: 160,
    intended: { direct: 2000, gateway: 2000 },
    requests: { direct: 2000, gateway: 2000 },
    dropped: { direct: 0, gateway: 0 },
    errors: { direct: 0, gateway: 0 },
    errorKinds: { direct: {}, gateway: {} },
    addedTtfb: { ...pct(1.2, 2, 8), n: 2000 },
    throughput: { direct: { requestsPerS: 12.5, outputTokensPerS: 6250, elapsedS: 160 }, gateway: { requestsPerS: 12.4, outputTokensPerS: 6200, elapsedS: 161.3 } },
    direct: { ttfb: { ...pct(100.1, 101, 102), n: 2000 }, outsideProvider: { ...pct(0.5, 0.6, 0.9), n: 2000 }, total: { ...pct(600, 601, 602), n: 2000 } },
    gateway: { ttfb: { ...pct(101.3, 103, 110), n: 2000 }, outsideProvider: { ...pct(1.7, 2.6, 9.1), n: 2000 }, total: { ...pct(602, 604, 610), n: 2000 } },
    addedTtfbMet: true,
    gatewayCpuPct: 12.5,
    gatewayRssMb: 120.4,
    rssGrowthMb: 3.1,
  });
  return {
    schemaVersion: 1,
    runAt: '2026-11-03T10:00:00.000Z',
    git: { commit: 'abc1234', dirty: false },
    hardware: { cpu: 'Test CPU', cores: 8, memoryGb: 16, arch: 'arm64' },
    os: { platform: 'darwin', release: '27.0.0' },
    node: 'v22.14.0',
    tools: { tsx: '4.0.0', redis: '7.4.0' },
    quick: false,
    overhead: {
      method: 'open-loop scheduler, loopback, mock provider',
      mock: { ttftMs: 100, tokensPerSec: 2000 },
      redis: 'measured',
      rows: [row('memory', 10), row('memory', 100), row('memory', 64), row('redis', 10)],
      slopes: [{ store: 'memory', scenario: 'streaming-500', from: 100, to: 500, cpuPctPer100Streams: 4.2, rssMbPer100Streams: 1.5 }],
    },
    budget: {
      runs: [
        {
          store: 'memory', estimator: 'worst-case', limitUsd: 1, requests: 1000, admitsBeforeFirstSettle: 1000, maxOpenReservations: 40, admitted: 40, rejected: 960, finalSpentUsd: 0.51, maxSpentPlusReservedUsd: 0.99,
          maxOverspendUsd: 0, spendDriftMicroUsd: 0, reservedLeftMicroUsd: 0, overruns: 0,
        },
      ],
      headroom: { bodyBytes: 150000, maxTokens: 32000, model: 'claude-opus-5-5', sessionBudgetUsd: 25, rows: [{ estimator: 'worst-case', reservationUsd: 2.11, inFlightAdmitted: 11, sent: 40 }], note: 'A note.' },
    },
    cache: { turns: 40, model: 'claude-opus-5-5', note: 'Why the naive proxy costs the same.', rows: [{ path: 'direct', costUsd: 1.5, inputTokens: 0, cacheReadTokens: 1000, cacheWriteTokens: 10, cacheHitRatio: 0.9 }] },
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
  (drifted2.overhead.rows[0] as { addedTtfb: { p99: number } }).addedTtfb.p99 = 9;
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
  r.slo = [{ sli: 'Added TTFB p50 / p99, concurrency 500', target: 'under 5 ms / under 25 ms', measured: '9 ms / 80 ms (n = 2,000)', met: false }];
  expect(renderBenchBlock(r)).toMatch(/concurrency 500 \| under 5 ms \/ under 25 ms \| 9 ms \/ 80 ms \(n = 2,000\) \| missed/);
});

test('overhead tables show the gateway-measured added TTFB with n, absolute latencies side by side, slopes and the notes', () => {
  const block = renderBenchBlock(results());
  // Added TTFB comes with its sample count; latencies are absolute, never a difference of two runs.
  expect(block).toContain('| Streaming, 500 tokens | 10 | 1.20 / 2.00 / 8.00 (n = 2,000) | 0.50 / 0.90 | 1.70 / 9.10 | 600.00 / 602.00 | 602.00 / 610.00 | 12.5 / 12.4 req/s, 6,250 / 6,200 tokens/s | 12.5% | 3.1 MB | 0 / 0 |');
  // Throughput and the added TTFB verdict (both measures, as the SLO rows) are in the table of every level too (V1).
  expect(block).toMatch(/\| 12\.5% \| 120\.4 MB \| met \|/);
  expect(block).toMatch(/\| memory \| Streaming, 500 tokens \| 100 \| 1\.25 \| 160 \| 2,000 \/ 2,000 \| 12\.5 \/ 12\.4 \| 6,250 \/ 6,200 \|/);
  expect(block).not.toMatch(/\| -\d/);
  expect(block).toContain('| memory | Streaming, 500 tokens | 100 to 500 | 4.2% | 1.5 MB |');
  expect(block).toContain('Why the naive proxy costs the same.');
  expect(block).toContain('| memory | worst-case | $1.00 | 1,000 | 1,000 | 40 | 40 |');
});

test('a soak section (V2) renders one row per store with memory trends, idle fds, series, keys and failed checks', () => {
  const r = results();
  expect(renderBenchBlock(r)).not.toContain('#### Soak');
  const gw = (instance: string) => ({ instance, cpuPct: 31.2, idleBefore: { fds: 40, series: 3 }, idleAfter: { fds: 41, series: 96 }, traceHours: 2, traceMbPerHourOfLoad: 812.4 });
  const verdict = (check: string, measured: string, ok = true) => ({ check, threshold: 't', measured, ok });
  const soak = {
    method: 'Soak method.',
    runs: [
      {
        mode: 'redis',
        gateways: 2,
        minutes: 45,
        requests: 405_000,
        answeredPerS: 150,
        perGateway: [gw('soak0001'), gw('soak0002')],
        redis: { after: { keys: 31_234 } },
        verdicts: [
          verdict('soak0001: RSS growth', '120.5 to 121.2 MB; trend 0.4% (0.9 MB/h), windows 0.58% (n = 81)'),
          verdict('soak0002: RSS growth', '119 to 125 MB; trend 4.1% (6 MB/h), windows 5% (n = 81)'),
          verdict('soak0001: heap used after GC growth', '30 to 30.5 MB; trend 1.2% (0.5 MB/h), windows 1.6% (n = 81)'),
          verdict('soak0002: heap used after GC growth', '30 to 31 MB; trend 2% (1 MB/h), windows 3.3% (n = 81)'),
          verdict('stream slots after the load', '319 of 320 admitted', false),
        ],
      },
    ],
  };
  const block = renderBenchBlock({ ...r, soak });
  expect(block).toContain('#### Soak');
  expect(block).toContain('| redis | 2 | 45 | 405,000 (150.0) | 31.2%, 31.2% | 120.5 to 121.2, 0.4%; 119 to 125, 4.1% | 30 to 30.5, 1.2%; 30 to 31, 2% | 40 / 41; 40 / 41 | 96, 96 | 31,234 | 2, 812.4; 2, 812.4 | 4 of 5 |');
  expect(block).toContain('- redis: stream slots after the load (319 of 320 admitted; threshold t)');
  expect(block).not.toMatch(/[—–←-⇿⟵-⟿]/);
});

test('soak rows judged with the V2 follow-up criteria render the RSS beyond the control process and heap plus external', () => {
  const gw = { instance: 'g', cpuPct: 30, idleBefore: { fds: 10, series: 3 }, idleAfter: { fds: 10, series: 67 }, traceHours: 2, traceMbPerHourOfLoad: 450 };
  const soak = {
    method: 'm',
    runs: [
      {
        mode: 'memory', gateways: 1, minutes: 45, requests: 1, answeredPerS: 1, perGateway: [gw], redis: null,
        verdicts: [
          { check: 'g: heap after GC plus external memory growth', threshold: 't', measured: '40.5 to 41 MB; trend 1.2% (0.5 MB/h), windows 1.2% (n = 80)', ok: true },
          { check: 'g: RSS growth beyond the control process', threshold: 't', measured: 'gateway minus control 14.2 to -3.1 MB; trend -2.5%, windows -12% of 120 MB (n = 80)', ok: true },
        ],
      },
    ],
  };
  expect(renderBenchBlock({ ...results(), soak })).toContain('| memory | 1 | 45 | 1 (1.0) | 30.0% | 14.2 to -3.1, -2.5% | 40.5 to 41, 1.2% |');
});
