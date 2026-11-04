// `npm run bench` (spec 12.3): the six benchmarks against the mock provider only, results in bench/results.json with the
// hardware, OS, Node and tool versions. Redis runs use REDIS_URL when set, else a throwaway local container from
// scripts/local-redis.mjs (random 127.0.0.1 port, random password, removed at the end); without either, Redis is
// recorded as not measured. BENCH_QUICK=1 shortens the overhead runs for development; never commit its results.
// Exits 1 when calibration finds a request billed above its input bound (R11), after writing the results.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createClient } from 'redis';
import { createRedisStore } from '../src/limits/redis-store.js';
import type { CounterStore } from '../src/limits/store.js';
import { isLoopbackRedisUrl, startLocalRedis } from '../scripts/local-redis.mjs';
import { benchBudget, type BudgetRun } from './budget.js';
import { benchCache, type CacheRow } from './cache.js';
import { benchCalibration } from './calibration.js';
import { cpuRssSlopes, environment, keptSoak, type Percentiles, ROOT, rowSaturated, ttfbVerdict } from './lib.js';
import { benchOverhead, benchOverheadWorkers, CONCURRENCY, MOCK, type OverheadRow, RATE, SCENARIOS, SLO_LEVELS, WORKERS_LEVELS, type WorkersRow } from './overhead.js';
import { benchReplay } from './replay.js';
import { benchScanAll } from './scan.js';

const log = (s: string): void => console.error(`bench: ${s}`);

/** A Redis to bench against: REDIS_URL, else a throwaway local container (scripts/local-redis.mjs). */
async function redis(): Promise<{ url: string; version: string; stop(): void } | { notMeasured: string }> {
  const given = process.env.REDIS_URL;
  // The budget benchmark flushes the Redis it is given: only a loopback one, unless explicitly allowed.
  if (given && !isLoopbackRedisUrl(given) && process.env.BENCH_ALLOW_FLUSH !== '1') {
    return { notMeasured: 'not measured: REDIS_URL is not a loopback address and the benchmark flushes it (set BENCH_ALLOW_FLUSH=1 to allow)' };
  }
  let url: string;
  let stop: () => void;
  try {
    ({ url, stop } = startLocalRedis());
  } catch (e) {
    const why = e instanceof Error && 'stderr' in e ? String((e as { stderr: Buffer }).stderr).trim().split('\n')[0] : e instanceof Error ? e.message.split('\n')[0] : String(e);
    return { notMeasured: `not measured: no REDIS_URL and the local Redis container did not start (${why || 'Docker unavailable'})` };
  }
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
  return { notMeasured: 'not measured: Redis did not answer' };
}

const count = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

type Slo = { sli: string; target: string; measured: string; met: boolean | null };

/**
 * The multi-worker rows: the gateway as each of these process counts (1 is the control: the same harness, one gateway
 * process), the mock and the load generator in their own processes. SLO_WORKERS backs the SLO rows; it was chosen from
 * development runs on the bench machine before the committed run (with 4, the gateway competes with the mock and load
 * processes for the performance cores and does worse), and every count is in the table.
 */
const WORKER_COUNTS = [1, 2, 3, 4] as const;
const SLO_WORKERS = 3;
const HARNESS = { mockProcesses: 3, loadProcesses: 3 } as const;
type WorkersSection = { method: string; workers: readonly number[]; sloWorkers: number; mockProcesses: number; loadProcesses: number; rows: WorkersRow[] } | { notMeasured: string };

const SCENARIO_NAMES: Record<string, string> = { 'non-streaming': 'non-streaming', 'streaming-500': 'streaming 500 tokens', 'body-150kb': 'streaming 150 KB body' };

function slos(o: { overhead: OverheadRow[]; workers: WorkersSection; budget: BudgetRun[]; cache: CacheRow[]; replay: { seconds: number; records: number }; redis: string }): Slo[] {
  const out: Slo[] = [];
  const pp = (p: Percentiles): string => `${p.p50 ?? 'n/a'} / ${p.p99 ?? 'n/a'} ms`;
  const measured = (row: OverheadRow): string => {
    const a = row.addedTtfb;
    return `${a.p50 ?? 'n/a'} ms / ${a.p99 ?? 'n/a'} ms (n = ${count(a.n)}); client-side TTFB outside the provider, p50 / p99: direct ${pp(row.direct.outsideProvider)}, through the gateway ${pp(row.gateway.outsideProvider)}`;
  };
  for (const store of ['memory', 'redis'] as const) {
    for (const scenario of SCENARIOS) {
      for (const c of SLO_LEVELS) {
        const row = o.overhead.find((r) => r.store === store && r.scenario === scenario && r.concurrency === c);
        const sli = `Added TTFB p50 / p99, ${SCENARIO_NAMES[scenario]}, ${c} streams, ${store} store`;
        if (!row) {
          out.push({ sli, target: 'under 5 ms / under 25 ms', measured: store === 'redis' ? o.redis : 'not measured', met: null });
          continue;
        }
        out.push({ sli, target: 'under 5 ms / under 25 ms', measured: measured(row), met: ttfbVerdict(row.addedTtfb, row.gateway.outsideProvider) });
      }
    }
  }
  // The same 500-stream rows with the gateway as several processes on one port (serve --workers), Redis store.
  for (const scenario of SCENARIOS) {
    for (const c of WORKERS_LEVELS) {
      const w = 'rows' in o.workers ? o.workers.sloWorkers : SLO_WORKERS;
      const sli = `Added TTFB p50 / p99, ${SCENARIO_NAMES[scenario]}, ${c} streams, redis store, ${w} gateway processes (serve --workers ${w})`;
      const row = 'rows' in o.workers ? o.workers.rows.find((r) => r.scenario === scenario && r.concurrency === c && r.workers === w) : undefined;
      if (!row) out.push({ sli, target: 'under 5 ms / under 25 ms', measured: 'rows' in o.workers ? 'not measured' : o.workers.notMeasured, met: null });
      else out.push({ sli, target: 'under 5 ms / under 25 ms', measured: measured(row), met: ttfbVerdict(row.addedTtfb, row.gateway.outsideProvider) });
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
    measured: `$${over} over ${worst.length} run(s) of 1,000 requests sent at once (${worst.map((r) => r.store).join(', ')})${lost ? ', with a lost update' : ''}`,
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
  out.push({ sli: `Replay of ${o.replay.records.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')} trace records`, target: 'under 60 s on a CI runner', measured: `${o.replay.seconds} s on the machine above (not a CI runner)`, met: o.replay.seconds < 60 });
  return out;
}

/** How the overhead benchmark measures, for the README. */
function overheadMethod(): string {
  return [
          `An open-loop load generator in the benchmark process sends each scenario to the mock provider directly and through the gateway (each in its own process, loopback). The mock answers after a fixed ${MOCK.ttftMs} ms time to first token and streams ${MOCK.outputTokens} tokens at ${MOCK.tokensPerSec} tokens/s.`,
          `Each stream is one keep-alive connection, opened before the run, with its own schedule of evenly spaced send times (${RATE['non-streaming']} requests/s non-streaming, ${RATE['streaming-500']} requests/s streaming) starting at a seeded random phase, so connections do not fire together; a request still running at the next scheduled time delays the next one, and client-side latency always counts from the scheduled time (coordinated omission included).`,
          'Added TTFB is the gateway\'s own per-request measure from its traces (`addedTtfbMs`: from the start of request handling to forwarding upstream, with a sub-millisecond clock in the benchmark), so it is paired per request; it does not include time a request waits before the gateway starts handling it, nor the response path.',
          'The client-side columns are absolute percentiles of each path, never subtracted from each other; "outside the provider" is each request\'s TTFB minus the mock\'s own wait for that request (the `x-mock-wait-ms` header), paired per request, so the mock\'s timer jitter drops out.',
          'An added TTFB SLO row is met only when both the gateway-measured value and the client-side TTFB outside the provider through the gateway (an upper bound on what the gateway adds, which includes queueing before handling) are under target.',
          `Each scenario runs at ${CONCURRENCY.join(', ')} streams; ${SLO_LEVELS.join(', ')} back the SLO rows (about 2,200 scheduled requests each), the other levels about 300.`,
          'Throughput is answered (2xx) requests and output tokens per second of each run, from its first scheduled send to its last answer (direct: the mock\'s fixed output per answer; through the gateway: the output tokens its traces settled); at a fixed open-loop rate it follows the offered load until a path saturates, then falls below it.',
          'n is the number of samples behind each percentile. CPU is the gateway process\'s user plus system time over the run\'s wall time (100% is one core); RSS growth is its peak during the run above its size just before it; per 100 streams is the slope between 100 and 500 streams, flagged as an understatement when the gateway could not keep up at 500 (a full core, fewer than 90% of the offered requests answered per second, or a drain more than 20% past the window).',
          'The gateway runs examples/policy with every budget level enforced at a limit the load never reaches, no rate limits, guardrails on, traces written and metrics kept.',
        ].join(' ');
}

/** How the multi-worker rows measure, for the README. */
function workersMethod(): string {
  return [
    `The ${WORKERS_LEVELS.join(', ')}-stream rows again on the Redis store, with the gateway as ${WORKER_COUNTS.join(', ')} processes sharing one port through node:cluster, as \`tokenyard serve --workers <n>\` runs it (a primary that serves no traffic hands each connection to a worker in turn; every worker has its own instance id and Redis connection).`,
    `The harness is in several processes too, so it is not the bottleneck: the mock runs as ${HARNESS.mockProcesses} processes on one port and the load generator as ${HARNESS.loadProcesses} processes that split the connections and start together (the single-process rows above saturate the mock at 150 KB and 500 streams). The direct path goes through the same mock and load processes; the mock and load CPU columns are per process over the gateway run.`,
    'Same schedule, mock timing, policy, measures and verdict as the rows above. Gateway CPU is the sum over the workers and the primary, with each worker in brackets; a row is flagged saturated when one worker uses a full core.',
    `The row with 1 process is the control: the same harness with one gateway process. The SLO rows use ${SLO_WORKERS} processes, chosen from development runs on this machine before this run; every count is in the table. These rows run before the single-process sweep above, which heats the laptop until it throttles.`,
  ].join(' ');
}

/**
 * `--recompute-slo`: re-derives the SLO rows, the CPU and RSS slopes and the method text of an existing bench/results.json from its own
 * measured rows (after a change to how verdicts are derived); measures nothing and changes no measured value.
 */
function recomputeSlo(): void {
  const file = join(ROOT, 'bench', 'results.json');
  const r = JSON.parse(readFileSync(file, 'utf8')) as {
    overhead: { rows: OverheadRow[]; redis: string; slopes: unknown; method: string; workers?: WorkersSection };
    budget: { runs: BudgetRun[] };
    cache: { rows: CacheRow[] };
    replay: { seconds: number; records: number };
    slo: Slo[];
    sloDerivedAt?: string;
  };
  r.overhead.method = overheadMethod();
  for (const row of r.overhead.rows) {
    row.addedTtfbMet = ttfbVerdict(row.addedTtfb, row.gateway.outsideProvider);
    row.saturated = rowSaturated(row);
  }
  r.overhead.slopes = cpuRssSlopes(r.overhead.rows, 100, 500);
  const workers: WorkersSection = r.overhead.workers ?? { notMeasured: 'not measured' };
  if ('rows' in workers) {
    workers.method = workersMethod();
    for (const row of workers.rows) {
      row.addedTtfbMet = ttfbVerdict(row.addedTtfb, row.gateway.outsideProvider);
      row.saturated = rowSaturated(row);
    }
  }
  r.slo = slos({ overhead: r.overhead.rows, workers, budget: r.budget.runs, cache: r.cache.rows, replay: r.replay, redis: r.overhead.redis });
  writeFileSync(file, `${JSON.stringify(r, null, 2)}\n`);
  for (const s of r.slo) log(`SLO ${s.sli}: ${s.met === true ? 'met' : s.met === false ? 'missed' : 'not measured'}`);
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
    // The multi-worker rows need the most cores at once, so they run before the 35-minute single-process sweep: at
    // its end the laptop throttles (kernel_task at 73% CPU near the end of the first full run, 2026-11-04).
    log('overhead with several gateway processes');
    const workers: WorkersSection = redisUrl
      ? { method: workersMethod(), workers: WORKER_COUNTS, sloWorkers: SLO_WORKERS, ...HARNESS, rows: await benchOverheadWorkers({ redisUrl, quick, log, workers: WORKER_COUNTS, ...HARNESS }) }
      : { notMeasured: `Redis store: ${redisNote}` };
    log('overhead');
    const overhead = await benchOverhead({ redisUrl, quick, log });
    const results = {
      schemaVersion: 1,
      ...env,
      quick,
      overhead: {
        method: overheadMethod(),
        mock: MOCK,
        redis: redisNote,
        rows: overhead,
        slopes: cpuRssSlopes(overhead, 100, 500),
        workers,
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
    const file = join(ROOT, 'bench', 'results.json');
    const full = { ...results, slo: slos({ overhead, workers, budget: budget.runs, cache: cache.rows, replay, redis: redisNote }), ...keptSoak(file) };
    writeFileSync(file, `${JSON.stringify(full, null, 2)}\n`);
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

if (process.argv.includes('--recompute-slo')) recomputeSlo();
else await main();
