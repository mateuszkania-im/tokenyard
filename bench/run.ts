// `npm run bench` (spec 12.3): the six benchmarks against the mock provider only, results in bench/results.json with the
// hardware, OS, Node and tool versions. Redis runs use REDIS_URL when set, else a throwaway local container
// (`docker run -d --rm --name ty-redis-bench -p 6379:6379 redis:7`, stopped at the end); without either, Redis is
// recorded as not measured. BENCH_QUICK=1 shortens the overhead runs for development; never commit its results.
// Exits 1 when calibration finds a request billed above its input bound (R11), after writing the results.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createClient } from 'redis';
import { createRedisStore } from '../src/limits/redis-store.js';
import type { CounterStore } from '../src/limits/store.js';
import { benchBudget, type BudgetRun } from './budget.js';
import { benchCache, type CacheRow } from './cache.js';
import { benchCalibration } from './calibration.js';
import { environment, ROOT } from './lib.js';
import { benchOverhead, MOCK, type OverheadRow, SCENARIOS } from './overhead.js';
import { benchReplay } from './replay.js';
import { benchScanAll } from './scan.js';

const log = (s: string): void => console.error(`bench: ${s}`);
const CONTAINER = 'ty-redis-bench';

/** A Redis to bench against: REDIS_URL, else a local container. `stop` removes the container when this run started it. */
async function redis(): Promise<{ url: string; version: string; stop(): void } | { notMeasured: string }> {
  let url = process.env.REDIS_URL ?? null;
  let started = false;
  if (!url) {
    try {
      execFileSync('docker', ['run', '-d', '--rm', '--name', CONTAINER, '-p', '6379:6379', 'redis:7'], { stdio: ['ignore', 'ignore', 'pipe'] });
      started = true;
      url = 'redis://127.0.0.1:6379';
    } catch (e) {
      const why = e instanceof Error && 'stderr' in e ? String((e as { stderr: Buffer }).stderr).trim().split('\n')[0] : String(e);
      return { notMeasured: `not measured: no REDIS_URL and the local Redis container did not start (${why || 'Docker unavailable'})` };
    }
  }
  const stop = (): void => {
    if (started) execFileSync('docker', ['stop', CONTAINER], { stdio: 'ignore' });
  };
  for (let i = 0; i < 50; i++) {
    const c = createClient({ url });
    c.on('error', () => undefined);
    try {
      await c.connect();
      const info = await c.info('server');
      await c.close();
      return { url, version: /redis_version:(\S+)/.exec(info)?.[1] ?? 'unknown', stop };
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  stop();
  return { notMeasured: `not measured: Redis at ${url} did not answer` };
}

type Slo = { sli: string; target: string; measured: string; met: boolean | null };

const SCENARIO_NAMES: Record<string, string> = { 'non-streaming': 'non-streaming', 'streaming-500': 'streaming 500 tokens', 'body-150kb': 'streaming 150 KB body' };

function slos(o: { overhead: OverheadRow[]; budget: BudgetRun[]; cache: CacheRow[]; replay: { seconds: number; records: number }; redis: string }): Slo[] {
  const out: Slo[] = [];
  for (const store of ['memory', 'redis'] as const) {
    for (const scenario of SCENARIOS) {
      for (const c of [10, 100, 500]) {
        const row = o.overhead.find((r) => r.store === store && r.scenario === scenario && r.concurrency === c);
        const sli = `Added TTFB p50 / p99, ${SCENARIO_NAMES[scenario]}, ${c} streams, ${store} store`;
        if (!row) {
          out.push({ sli, target: 'under 5 ms / under 25 ms', measured: store === 'redis' ? o.redis : 'not measured', met: null });
          continue;
        }
        out.push({ sli, target: 'under 5 ms / under 25 ms', measured: `${row.added.ttfb.p50} ms / ${row.added.ttfb.p99} ms`, met: row.added.ttfb.p50 < 5 && row.added.ttfb.p99 < 25 });
      }
    }
  }
  const gw = o.overhead.reduce((n, r) => n + r.requests.gateway, 0);
  const gwErr = o.overhead.reduce((n, r) => n + r.errors.gateway, 0);
  out.push({ sli: 'Gateway-attributable error rate', target: 'under 0.1% per month', measured: `not measured (a production SLI); overhead runs: ${gwErr} errors beside ${gw} answered requests through the gateway`, met: null });
  out.push({ sli: 'Policy propagation, merge to all instances, p99', target: 'under 60 s', measured: 'not measured', met: null });
  const worst = o.budget.filter((r) => r.estimator === 'worst-case');
  const over = Math.max(...worst.map((r) => r.maxOverspendUsd));
  const lost = worst.some((r) => r.spendDriftMicroUsd !== 0 || r.reservedLeftMicroUsd !== 0);
  out.push({
    sli: 'Admitted spend above an enforced budget (worst-case estimator)',
    target: 'zero',
    measured: `$${over} over ${worst.length} run(s) of 1,000 concurrent requests (${worst.map((r) => r.store).join(', ')})${lost ? ', with a lost update' : ''}`,
    met: over === 0 && !lost,
  });
  out.push({ sli: 'Conformance suite on the pinned Claude Code and Codex versions', target: '100%', measured: 'not measured by the benchmark (docs/conformance.md)', met: null });
  const direct = o.cache.find((r) => r.path === 'direct') as CacheRow;
  const via = o.cache.find((r) => r.path === 'tokenyard') as CacheRow;
  out.push({
    sli: 'Cache hit ratio through tokenyard versus direct, same session on the mock',
    target: 'equal',
    measured: `${(via.cacheHitRatio * 100).toFixed(2)}% versus ${(direct.cacheHitRatio * 100).toFixed(2)}%`,
    met: via.cacheHitRatio === direct.cacheHitRatio && via.costUsd === direct.costUsd,
  });
  out.push({ sli: `Replay of ${o.replay.records.toLocaleString('en-US')} trace records`, target: 'under 60 s on a CI runner', measured: `${o.replay.seconds} s on the machine above (not a CI runner)`, met: o.replay.seconds < 60 });
  return out;
}

async function main(): Promise<void> {
  const quick = process.env.BENCH_QUICK === '1';
  const r = await redis();
  const redisUrl = 'url' in r ? r.url : null;
  const redisNote = 'url' in r ? 'measured' : r.notMeasured;
  try {
    const env = environment('url' in r ? r.version : null);
    log(`redis: ${redisNote}`);
    log('calibration');
    const calibration = await benchCalibration();
    log('scan');
    const scan = benchScanAll(4);
    log('cache');
    const cache = await benchCache();
    log('budget');
    const clients: Array<{ close(): Promise<unknown> }> = [];
    const redisStore = redisUrl
      ? async (): Promise<CounterStore> => {
          const client = createClient({ url: redisUrl });
          clients.push(client);
          await client.connect();
          await client.flushDb();
          return createRedisStore(client, { deadlineMs: 600_000 });
        }
      : null;
    const budget = await benchBudget({ redis: redisStore, log });
    for (const c of clients) await c.close();
    log('replay');
    const replay = await benchReplay(1_000_000);
    log(`replay: ${replay.seconds} s`);
    log('overhead');
    const overhead = await benchOverhead({ redisUrl, quick, log });
    const results = {
      schemaVersion: 1,
      ...env,
      quick,
      overhead: {
        method: `autocannon drives each scenario at the mock provider directly and through the gateway (both in their own processes, loopback); the mock answers after a fixed ${MOCK.ttftMs} ms time to first token and streams ${MOCK.outputTokens} tokens at ${MOCK.tokensPerSec} tokens/s. Each connection is one stream with a fixed request rate below what it can complete directly; latencies are corrected for coordinated omission with that intended interval. Added time is the gateway percentile minus the direct percentile; CPU and RSS are the gateway process's, RSS above its idle size. The gateway runs examples/policy with every budget level enforced at a limit the load never reaches, no rate limits, guardrails on, traces written and metrics kept.`,
        mock: MOCK,
        redis: redisNote,
        rows: overhead,
      },
      budget: {
        ...budget,
        notMeasured: redisUrl ? undefined : `Redis store: ${redisNote}`,
        headroom: {
          ...budget.headroom,
          note: 'session-aware reserves the same as worst-case here: the estimator is not given the session\'s previous cache read share yet (src/policy/decide.ts passes none), and the route sets no reserveOutputTokens.',
        },
      },
      cache,
      scan,
      replay,
      calibration,
    };
    const full = { ...results, slo: slos({ overhead, budget: budget.runs, cache: cache.rows, replay, redis: redisNote }) };
    writeFileSync(join(ROOT, 'bench', 'results.json'), `${JSON.stringify(full, null, 2)}\n`);
    log('bench/results.json written');
    for (const s of full.slo) log(`SLO ${s.sli}: ${s.measured} (${s.met === true ? 'met' : s.met === false ? 'missed' : 'not measured'})`);
    if (calibration.violations > 0) {
      log(`calibration: ${calibration.violations} request(s) billed more input than their bound (R11)`);
      process.exitCode = 1;
    }
  } finally {
    if ('stop' in r) r.stop();
  }
}

await main();
