// Spec 12.3 item 1: gateway overhead. An open-loop load generator sends the same load to the mock provider directly
// and through the gateway. Added TTFB is the gateway's own per-request measure (trace field `addedTtfbMs`: request
// start to forwarding upstream), so it is paired by construction; client-side TTFB and total time are reported as
// absolute percentiles for both paths, side by side, never subtracted. The mock and the gateway each run in their own
// child process, so the gateway's CPU and RSS are its own.
// The multi-worker rows (benchOverheadWorkers) run the gateway as several processes sharing one port, as
// `tokenyard serve --workers` does, against a mock of several processes, driven by several load processes.
//   npx tsx bench/overhead.ts mock [procs]                                 (child: the mock provider)
//   npx tsx bench/overhead.ts gateway <memory|redis> <mockUrl> [workers]   (child: the gateway; Redis URL in BENCH_REDIS_URL)
//   npx tsx bench/overhead.ts load                                         (child: one open-loop load generator)
// With procs or workers above 1 the child is a node:cluster primary that serves nothing itself: its workers share the
// port (round robin), and it relays start and stop to them and adds up their CPU and RSS.
import { type ChildProcess, fork } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { Agent, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mulberry32 } from '../src/mock/scenarios.js';
import { PROVIDER_KEY_ENV, TEST_KEY } from '../test/helpers/policy.js';
import { BENCH_PROVIDER_KEY, benchPolicy, intendedStarts, type Load, mergeLoads, type Percentiles, percentiles, preconnect, round, rowSaturated, splitConnections, type Throughput, throughput, ttfbVerdict } from './lib.js';

export type Scenario = 'non-streaming' | 'streaming-500' | 'body-150kb';
export const SCENARIOS: readonly Scenario[] = ['non-streaming', 'streaming-500', 'body-150kb'];
/** 10, 100 and 500 from spec 12.3; 1, 16, 64 and 256 for the extended verification (V1). */
export const CONCURRENCY = [1, 10, 16, 64, 100, 256, 500] as const;
/** The levels whose rows back an SLO verdict: sized for about 2,000 samples each. */
export const SLO_LEVELS: readonly number[] = [10, 100, 500];
/** Mock provider timing, fixed for every run. */
export const MOCK = { ttftMs: 100, tokensPerSec: 2_000, outputTokens: 500 } as const;
/**
 * Requests per second each connection is scheduled to send, evenly spaced. Each interval is longer than what one
 * request takes against the direct mock (non-streaming about 105 ms against 200 ms, streaming about 400 ms against
 * 800 ms), so a connection is idle part of the time and a slower gateway shows up as latency, not as a lower rate.
 */
export const RATE: Record<Scenario, number> = { 'non-streaming': 5, 'streaming-500': 1.25, 'body-150kb': 1.25 };
/** After the scheduled window, requests already due may finish for this long; anything later counts as dropped. */
const DRAIN_MS = 30_000;

const HEADERS = {
  'x-api-key': TEST_KEY,
  'content-type': 'application/json',
  'anthropic-version': '2023-06-01',
  'user-agent': 'claude-cli/2.1.316 (external, cli)',
};

/** Source-like filler; no secret rule matches it. */
const SOURCE = 'export function add(a: number, b: number): number {\n  return a + b; // sum two numbers\n}\n';

export function scenarioBody(s: Scenario): Buffer {
  const base = { model: 'claude-opus-5-5', max_tokens: 1024, messages: [{ role: 'user', content: 'Summarise the change in one line.' }] };
  if (s === 'non-streaming') return Buffer.from(JSON.stringify(base));
  if (s === 'streaming-500') return Buffer.from(JSON.stringify({ ...base, stream: true }));
  // A long agent context: 150 KB, tool results in the history, the newest turn last.
  const target = 150 * 1024;
  const messages: unknown[] = [];
  let i = 0;
  const size = (): number => Buffer.byteLength(JSON.stringify({ ...base, max_tokens: 32000, stream: true, messages }));
  while (size() < target - 4096) {
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${i}`, content: SOURCE.repeat(40) }] }, { role: 'assistant', content: [{ type: 'text', text: 'ok' }] });
    i++;
  }
  messages.push({ role: 'user', content: [{ type: 'text', text: 'continue' }] });
  const body = { ...base, max_tokens: 32000, stream: true, system: [{ type: 'text', text: '' }], messages };
  const pad = target - Buffer.byteLength(JSON.stringify(body));
  body.system = [{ type: 'text', text: 'x'.repeat(Math.max(0, pad)) }];
  return Buffer.from(JSON.stringify(body));
}

export interface OverheadRow {
  scenario: Scenario;
  store: 'memory' | 'redis';
  concurrency: number;
  ratePerConnection: number;
  durationS: number;
  /** Requests scheduled in the window, per path. */
  intended: { direct: number; gateway: number };
  /** 2xx answers received, per path. */
  requests: { direct: number; gateway: number };
  /** Scheduled requests never sent because the drain time ran out. */
  dropped: { direct: number; gateway: number };
  errors: { direct: number; gateway: number };
  errorKinds: { direct: Record<string, number>; gateway: Record<string, number> };
  /** The gateway's own per-request added TTFB (trace `addedTtfbMs`), 2xx requests of the window. */
  addedTtfb: Percentiles;
  /**
   * Client-side, from each request's intended send time (coordinated omission included). `outsideProvider` is each
   * request's TTFB minus the mock's own wait for it (`x-mock-wait-ms`): client, loopback and, on the gateway path, the
   * gateway's share, paired per request.
   */
  direct: { ttfb: Percentiles; outsideProvider: Percentiles; total: Percentiles };
  gateway: { ttfb: Percentiles; outsideProvider: Percentiles; total: Percentiles };
  /**
   * Answered requests and output tokens per second, over each run's first scheduled send to its last answer. Direct:
   * every 2xx answer carries the mock's fixed output; through the gateway: the output tokens its traces settled.
   */
  throughput: { direct: Throughput; gateway: Throughput };
  /** The spec 12.1 added TTFB targets, met on both the gateway measure and the client-side bound (ttfbVerdict). */
  addedTtfbMet: boolean | null;
  /** The gateway could not keep up with the offered load in this run (rowSaturated). */
  saturated: boolean;
  gatewayCpuPct: number;
  gatewayRssMb: number;
  /** Peak RSS during the run minus RSS just before it. */
  rssGrowthMb: number;
  /** Several gateway processes (benchOverheadWorkers): each worker's CPU; gatewayCpuPct is their sum plus the primary's. */
  perProcessCpuPct?: number[];
}

/** A row of the multi-worker benchmark: the gateway as `workers` processes on one port, mock and load in several processes. */
export interface WorkersRow extends OverheadRow {
  workers: number;
  mockProcesses: number;
  loadProcesses: number;
  /** CPU of each mock process over the direct and over the gateway run, so a saturated mock would show. */
  mockCpuPct: { direct: number[]; gateway: number[] };
  /** CPU of each load process over the direct and over the gateway run, so a saturated load generator would show. */
  loadCpuPct: { direct: number[]; gateway: number[] };
}

/** One request on a connection; times are performance.now() values. */
function once(agent: Agent, url: URL, body: Buffer): Promise<{ status: number; headersAt: number; endAt: number; mockWaitMs: number } | { error: string }> {
  return new Promise((resolve) => {
    const req = request(
      { host: url.hostname, port: url.port, method: 'POST', path: '/v1/messages', headers: { ...HEADERS, 'content-length': String(body.length) }, agent },
      (res) => {
        const headersAt = performance.now();
        const mockWaitMs = Number(res.headers['x-mock-wait-ms'] ?? Number.NaN);
        res.on('data', () => undefined);
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headersAt, endAt: performance.now(), mockWaitMs }));
        res.on('error', (e: NodeJS.ErrnoException) => resolve({ error: e.code ?? 'socket' }));
      },
    );
    req.setTimeout(60_000, () => req.destroy(Object.assign(new Error('timeout'), { code: 'timeout' })));
    req.on('error', (e: NodeJS.ErrnoException) => resolve({ error: e.code ?? 'socket' }));
    req.end(body);
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, Math.max(0, ms)));

/**
 * Open-loop load: `connections` keep-alive connections, each with its own schedule of evenly spaced intended send
 * times (interval 1000 / rate ms, phase drawn per connection from a seeded generator). A connection carries one request
 * at a time; when a request is still running at the next intended time, the next one waits and its latency still
 * counts from its intended time, which is the coordinated-omission correction.
 */
async function drive(base: string, s: Scenario, connections: number, durationS: number, body: Buffer, seed: number): Promise<Load> {
  const agents = await openConnections(base, connections);
  return runLoad(agents, base, s, durationS, body, seed, performance.now() + 50);
}

/** One keep-alive connection per agent, opened before the run. */
async function openConnections(base: string, connections: number): Promise<Agent[]> {
  const agents = Array.from({ length: connections }, () => new Agent({ keepAlive: true, maxSockets: 1 }));
  await preconnect(agents, base);
  return agents;
}

/** The open-loop run itself on connections already open, from `startMs` (a performance.now() value). */
async function runLoad(agents: Agent[], base: string, s: Scenario, durationS: number, body: Buffer, seed: number, startMs: number): Promise<Load> {
  const url = new URL(base);
  const interval = 1000 / RATE[s];
  const rng = mulberry32(seed);
  const endMs = startMs + durationS * 1000;
  const load: Load = { intended: 0, ttfb: [], outside: [], total: [], ok: 0, dropped: 0, errorKinds: {}, firstScheduledMs: Number.POSITIVE_INFINITY, lastAnswerMs: 0 };
  await Promise.all(
    agents.map(async (agent) => {
      const times = intendedStarts({ startMs, endMs, intervalMs: interval, phaseMs: rng() * interval });
      load.intended += times.length;
      if (times[0] !== undefined) load.firstScheduledMs = Math.min(load.firstScheduledMs, times[0]);
      for (const [i, t] of times.entries()) {
        if (performance.now() > endMs + DRAIN_MS) {
          load.dropped += times.length - i;
          break;
        }
        await sleep(t - performance.now());
        const r = await once(agent, url, body);
        if ('error' in r) load.errorKinds[r.error] = (load.errorKinds[r.error] ?? 0) + 1;
        else if (r.status < 200 || r.status >= 300) load.errorKinds[String(r.status)] = (load.errorKinds[String(r.status)] ?? 0) + 1;
        else {
          load.ok++;
          load.ttfb.push(r.headersAt - t);
          if (Number.isFinite(r.mockWaitMs)) load.outside.push(r.headersAt - t - r.mockWaitMs);
          load.total.push(r.endAt - t);
          load.lastAnswerMs = Math.max(load.lastAnswerMs, r.endAt);
        }
      }
    }),
  );
  for (const a of agents) a.destroy();
  return load;
}

interface Stats {
  cpuPct: number;
  peakRssMb: number;
  startRssMb: number;
  addedTtfbMs: number[];
  /** Output tokens of the 2xx trace records of the window (gateway only). */
  outputTokens: number;
  /** A clustered child: each worker's CPU (the primary's own share is in cpuPct only). */
  perProcessCpuPct?: number[];
}

interface Child {
  url: string;
  call(cmd: 'start' | 'stop'): Promise<Stats>;
  close(): Promise<void>;
}

/** `--cpu-prof` flags for a gateway child when BENCH_CPU_PROF names a directory (profiling runs, not for committing). */
export function profileArgs(role: string, dir: string | undefined): string[] {
  return role === 'gateway' && dir ? ['--cpu-prof', `--cpu-prof-dir=${dir}`] : [];
}

function spawn(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<Child> {
  const execArgv = ['--import', 'tsx', ...profileArgs(args[0] ?? '', process.env.BENCH_CPU_PROF)];
  const child: ChildProcess = fork(join(import.meta.dirname, 'overhead.ts'), args, { execArgv, env, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`bench child ${args[0]} exited with ${code}`)));
    child.once('message', (m: { url: string }) => {
      child.removeAllListeners('exit');
      resolve({
        url: m.url,
        call: (cmd) =>
          new Promise((r) => {
            child.once('message', (x) => r(x as Stats));
            child.send(cmd);
          }),
        close: () =>
          new Promise((r) => {
            child.once('exit', () => r());
            child.kill('SIGTERM');
          }),
      });
    });
  });
}

/** Child side: CPU and peak RSS over a measured window, and the added TTFB of every 2xx trace record in it. */
function serveStats(url: string, added: number[], tokens: { output: number } = { output: 0 }): void {
  let startRssMb = 0;
  let cpu0 = process.cpuUsage();
  let t0 = process.hrtime.bigint();
  let peak = 0;
  let sampler: NodeJS.Timeout | undefined;
  process.on('message', (cmd: string) => {
    if (cmd === 'start') {
      added.length = 0;
      tokens.output = 0;
      cpu0 = process.cpuUsage();
      t0 = process.hrtime.bigint();
      peak = process.memoryUsage.rss();
      startRssMb = peak / 1024 / 1024;
      sampler = setInterval(() => (peak = Math.max(peak, process.memoryUsage.rss())), 50);
      process.send?.({});
    } else if (cmd === 'stop') {
      clearInterval(sampler);
      const c = process.cpuUsage(cpu0);
      const wallUs = Number(process.hrtime.bigint() - t0) / 1e3;
      const stats: Stats = { cpuPct: ((c.user + c.system) / wallUs) * 100, peakRssMb: Math.max(peak, process.memoryUsage.rss()) / 1024 / 1024, startRssMb, addedTtfbMs: [...added], outputTokens: tokens.output };
      // Trace records are queued after settlement, just after the response ended: give the last ones a moment.
      setTimeout(() => process.send?.({ ...stats, addedTtfbMs: [...added], outputTokens: tokens.output }), 300);
    }
  });
  process.send?.({ url });
}

/**
 * A clustered child (mock or gateway with more than one process): forks `procs` workers that run this file in the same
 * role with one process each (they share the port, round robin, as `serve --workers` does), relays start and stop to
 * them, and answers with their stats added up: CPU of every worker plus the primary's own, RSS summed, samples joined.
 */
async function clusterPrimary(role: 'mock' | 'gateway', args: string[], procs: number): Promise<void> {
  const { default: cluster } = await import('node:cluster');
  cluster.schedulingPolicy = cluster.SCHED_RR;
  cluster.setupPrimary({ exec: join(import.meta.dirname, 'overhead.ts'), args: [role, ...args, '1'], execArgv: process.execArgv });
  const workers = Array.from({ length: procs }, () => cluster.fork());
  const next = <T>(w: (typeof workers)[number]): Promise<T> => new Promise((r) => w.once('message', (m: T) => r(m)));
  const urls = await Promise.all(workers.map((w) => next<{ url: string }>(w)));
  let cpu0 = process.cpuUsage();
  let t0 = process.hrtime.bigint();
  process.on('message', (cmd: string) => {
    void (async () => {
      if (cmd === 'start') {
        await Promise.all(workers.map((w) => (w.send(cmd), next<unknown>(w))));
        cpu0 = process.cpuUsage();
        t0 = process.hrtime.bigint();
        process.send?.({});
      } else if (cmd === 'stop') {
        const c = process.cpuUsage(cpu0);
        const own = ((c.user + c.system) / (Number(process.hrtime.bigint() - t0) / 1e3)) * 100;
        const st = await Promise.all(workers.map((w) => (w.send(cmd), next<Stats>(w))));
        const rss = process.memoryUsage.rss() / 1024 / 1024;
        const stats: Stats = {
          cpuPct: own + st.reduce((n, x) => n + x.cpuPct, 0),
          perProcessCpuPct: st.map((x) => round(x.cpuPct, 1)),
          peakRssMb: rss + st.reduce((n, x) => n + x.peakRssMb, 0),
          startRssMb: rss + st.reduce((n, x) => n + x.startRssMb, 0),
          addedTtfbMs: st.flatMap((x) => x.addedTtfbMs),
          outputTokens: st.reduce((n, x) => n + x.outputTokens, 0),
        };
        process.send?.(stats);
      }
    })();
  });
  process.on('SIGTERM', () => {
    void Promise.all(workers.map((w) => new Promise<void>((r) => (w.once('exit', () => r()), w.process.kill('SIGTERM'))))).then(() => process.exit(0));
  });
  process.send?.({ url: urls[0]?.url });
}

/** A load generator child: opens its connections on `prepare`, runs on `go` from a start time shared by every load child. */
type LoadCmd = { cmd: 'prepare'; base: string; scenario: Scenario; connections: number; durationS: number; seed: number } | { cmd: 'go'; startAtEpochMs: number };
function loadChild(): void {
  let agents: Agent[] = [];
  let job: Extract<LoadCmd, { cmd: 'prepare' }> | null = null;
  const bodies = new Map<Scenario, Buffer>();
  process.on('message', (m: LoadCmd) => {
    void (async () => {
      if (m.cmd === 'prepare') {
        job = m;
        agents = await openConnections(m.base, m.connections);
        process.send?.({ prepared: true });
        return;
      }
      if (!job) return;
      const body = bodies.get(job.scenario) ?? scenarioBody(job.scenario);
      bodies.set(job.scenario, body);
      const cpu0 = process.cpuUsage();
      const t0 = performance.now();
      // Times leave this process as epoch milliseconds, the clock every load child shares.
      const l = await runLoad(agents, job.base, job.scenario, job.durationS, body, job.seed, m.startAtEpochMs - performance.timeOrigin);
      const c = process.cpuUsage(cpu0);
      const cpuPct = ((c.user + c.system) / 1e3 / (performance.now() - t0)) * 100;
      process.send?.({ load: { ...l, firstScheduledMs: l.firstScheduledMs + performance.timeOrigin, lastAnswerMs: l.lastAnswerMs + performance.timeOrigin }, cpuPct });
    })();
  });
  process.send?.({ url: '' });
}

async function childMain(role: string, args: string[]): Promise<void> {
  if (role === 'load') return loadChild();
  const { default: cluster } = await import('node:cluster');
  const procs = Number((role === 'mock' ? args[0] : args[2]) ?? '1');
  if (procs > 1 && cluster.isPrimary) return clusterPrimary(role as 'mock' | 'gateway', role === 'mock' ? [] : args.slice(0, 2), procs);
  // One instance id per gateway process, as serve --workers gives each worker its own.
  const instance = cluster.worker ? `bench-w${cluster.worker.id}` : 'bench0001';
  if (role === 'mock') {
    const { startAnthropicMock } = await import('../src/mock/anthropic.js');
    const mock = await startAnthropicMock({ scenario: { kind: 'ok', ttftMs: MOCK.ttftMs, tokensPerSec: MOCK.tokensPerSec, pingEveryMs: null, outputTokens: MOCK.outputTokens } });
    setInterval(() => (mock.received.length = 0), 1000).unref(); // the mock keeps every request it saw
    process.on('SIGTERM', () => void mock.close().then(() => process.exit(0)));
    serveStats(mock.url, []);
    return;
  }
  const [store, mockUrl] = args as ['memory' | 'redis', string];
  // The Redis URL carries its password, so it comes through the environment, not the command line.
  const redisUrl = process.env.BENCH_REDIS_URL;
  process.env[PROVIDER_KEY_ENV] = BENCH_PROVIDER_KEY;
  const { createGateway } = await import('../src/edge/server.js');
  const { createGatewayRuntime } = await import('../src/edge/handler.js');
  const { ulid } = await import('../src/edge/ulid.js');
  const { openCounterStore } = await import('../src/limits/open-store.js');
  const { TraceWriter } = await import('../src/ledger/writer.js');
  const { createMetrics } = await import('../src/telemetry/metrics.js');
  const runtime = createGatewayRuntime();
  const counters = await openCounterStore({ kind: store, ...(redisUrl ? { redisUrl } : {}), instance, onSwept: (ids) => runtime.onSwept(ids) });
  const traceDir = mkdtempSync(join(tmpdir(), 'tokenyard-bench-traces-'));
  const writer = new TraceWriter({ dir: traceDir, instanceId: instance, queueMax: 100_000, clock: Date.now });
  const added: number[] = [];
  const tokens = { output: 0 };
  const policy = benchPolicy(mockUrl);
  // As `tokenyard serve` builds it (traces written, metrics kept, a counter store round trip per request), with one
  // change: a sub-millisecond clock, so the gateway's own timings (addedTtfbMs) are not whole milliseconds.
  const gw = createGateway({
    policy: () => policy,
    store: counters.store,
    runtime,
    traces: {
      write: (r) => {
        if (r.outcome.status >= 200 && r.outcome.status < 300) {
          if (r.outcome.addedTtfbMs !== null) added.push(r.outcome.addedTtfbMs);
          tokens.output += r.outcome.usage?.output ?? 0;
        }
        return writer.write(r);
      },
    },
    traceSalt: 'bench-salt',
    clock: () => performance.timeOrigin + performance.now(),
    newId: () => ulid(),
    basePath: null,
    bodyCapBytes: 32 * 1024 * 1024,
    experimentalSubscription: false,
    metrics: createMetrics(),
  });
  const url = await gw.listen(0, '127.0.0.1');
  process.on('SIGTERM', () => {
    void (async () => {
      await gw.close();
      await writer.close();
      await counters.close();
      rmSync(traceDir, { recursive: true, force: true });
      process.exit(0);
    })();
  });
  serveStats(url, added, tokens);
}

/** Seconds per run: about 2,200 scheduled requests on the SLO levels (10 s to 180 s), about 300 elsewhere (5 s to 20 s). */
export function durationFor(s: Scenario, c: number, quick: boolean): number {
  if (quick) return 2;
  const [want, min, max] = SLO_LEVELS.includes(c) ? [2_200, 10, 180] : [300, 5, 20];
  return Math.min(max, Math.max(min, Math.ceil(want / (c * RATE[s]))));
}

const sumKinds = (k: Record<string, number>): number => Object.values(k).reduce((n, x) => n + x, 0);

/** One overhead row from the direct and the gateway run of a level and the gateway child's stats over its run. */
function overheadRow(o: { scenario: Scenario; store: 'memory' | 'redis'; concurrency: number; durationS: number; direct: Load; via: Load; stats: Stats }): OverheadRow {
  const { direct, via, stats: st } = o;
  const row: OverheadRow = {
    scenario: o.scenario,
    store: o.store,
    concurrency: o.concurrency,
    ratePerConnection: RATE[o.scenario],
    durationS: o.durationS,
    intended: { direct: direct.intended, gateway: via.intended },
    requests: { direct: direct.ok, gateway: via.ok },
    dropped: { direct: direct.dropped, gateway: via.dropped },
    errors: { direct: sumKinds(direct.errorKinds), gateway: sumKinds(via.errorKinds) },
    errorKinds: { direct: direct.errorKinds, gateway: via.errorKinds },
    addedTtfb: percentiles(st.addedTtfbMs),
    throughput: {
      direct: throughput({ answered: direct.ok, outputTokens: direct.ok * MOCK.outputTokens, firstScheduledMs: direct.firstScheduledMs, lastAnswerMs: direct.lastAnswerMs }),
      gateway: throughput({ answered: via.ok, outputTokens: st.outputTokens, firstScheduledMs: via.firstScheduledMs, lastAnswerMs: via.lastAnswerMs }),
    },
    direct: { ttfb: percentiles(direct.ttfb), outsideProvider: percentiles(direct.outside), total: percentiles(direct.total) },
    gateway: { ttfb: percentiles(via.ttfb), outsideProvider: percentiles(via.outside), total: percentiles(via.total) },
    addedTtfbMet: null,
    saturated: false,
    gatewayCpuPct: round(st.cpuPct, 1),
    ...(st.perProcessCpuPct ? { perProcessCpuPct: st.perProcessCpuPct } : {}),
    gatewayRssMb: round(st.peakRssMb, 1),
    rssGrowthMb: round(Math.max(0, st.peakRssMb - st.startRssMb), 1),
  };
  row.addedTtfbMet = ttfbVerdict(row.addedTtfb, row.gateway.outsideProvider);
  row.saturated = rowSaturated(row);
  return row;
}

function rowLog(row: OverheadRow, directKinds: Record<string, number>, viaKinds: Record<string, number>, label = ''): string {
  const dp = row.direct;
  return `overhead ${row.scenario} ${row.store}${label} c=${row.concurrency} ${row.durationS}s: added TTFB p50 ${row.addedTtfb.p50} p99 ${row.addedTtfb.p99} ms (n ${row.addedTtfb.n}), outside provider p50/p99 direct ${dp.outsideProvider.p50}/${dp.outsideProvider.p99} gateway ${row.gateway.outsideProvider.p50}/${row.gateway.outsideProvider.p99} ms, throughput ${row.throughput.direct.requestsPerS}/${row.throughput.gateway.requestsPerS} req/s ${row.throughput.direct.outputTokensPerS}/${row.throughput.gateway.outputTokensPerS} tok/s, cpu ${row.gatewayCpuPct}%${row.perProcessCpuPct ? ` (${row.perProcessCpuPct.join(', ')})` : ''}, errors ${JSON.stringify(directKinds)} / ${JSON.stringify(viaKinds)}, dropped ${row.dropped.direct} / ${row.dropped.gateway}`;
}

/** Every scenario at every concurrency, direct and through a gateway per store, interleaved per level. */
export async function benchOverhead(o: {
  redisUrl: string | null;
  quick: boolean;
  log: (s: string) => void;
  scenarios?: readonly Scenario[];
  concurrency?: readonly number[];
}): Promise<OverheadRow[]> {
  const mock = await spawn(['mock']);
  const gateways: Array<{ store: 'memory' | 'redis'; child: Child }> = [{ store: 'memory', child: await spawn(['gateway', 'memory', mock.url]) }];
  if (o.redisUrl) gateways.push({ store: 'redis', child: await spawn(['gateway', 'redis', mock.url], { ...process.env, BENCH_REDIS_URL: o.redisUrl }) });
  const rows: OverheadRow[] = [];
  let seed = 1;
  try {
    for (const s of o.scenarios ?? SCENARIOS) {
      const body = scenarioBody(s);
      // Warm-up (JIT, connection pools), discarded.
      await drive(mock.url, s, 10, 2, body, seed++);
      for (const g of gateways) await drive(g.child.url, s, 10, 2, body, seed++);
      for (const c of o.concurrency ?? CONCURRENCY) {
        const d = durationFor(s, c, o.quick);
        const direct = await drive(mock.url, s, c, d, body, seed++);
        for (const g of gateways) {
          await g.child.call('start');
          const via = await drive(g.child.url, s, c, d, body, seed++);
          const st = await g.child.call('stop');
          const row = overheadRow({ scenario: s, store: g.store, concurrency: c, durationS: d, direct, via, stats: st });
          rows.push(row);
          o.log(rowLog(row, direct.errorKinds, via.errorKinds));
        }
      }
    }
  } finally {
    for (const g of gateways) await g.child.close();
    await mock.close();
  }
  return rows;
}

/** Load generators in their own processes, so the generator is not the bottleneck when the gateway is several processes. */
interface LoadPool {
  /** One run split over the pool: every child opens its share of the connections, then all start at the same moment. */
  run(base: string, s: Scenario, connections: number, durationS: number, seed: number): Promise<{ load: Load; cpuPct: number[] }>;
  close(): Promise<void>;
}

async function loadPool(n: number): Promise<LoadPool> {
  const kids = await Promise.all(
    Array.from({ length: n }, () => {
      const child: ChildProcess = fork(join(import.meta.dirname, 'overhead.ts'), ['load'], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
      return new Promise<ChildProcess>((resolve, reject) => {
        child.once('error', reject);
        child.once('message', () => resolve(child));
      });
    }),
  );
  const ask = <T>(c: ChildProcess, m: LoadCmd): Promise<T> =>
    new Promise((r) => {
      c.once('message', (x: T) => r(x));
      c.send(m);
    });
  return {
    async run(base, s, connections, durationS, seed) {
      const shares = splitConnections(connections, n);
      const used = kids.slice(0, shares.length);
      await Promise.all(used.map((c, i) => ask(c, { cmd: 'prepare', base, scenario: s, connections: shares[i] as number, durationS, seed: seed * 1_000 + i })));
      const startAtEpochMs = performance.timeOrigin + performance.now() + 100;
      const out = await Promise.all(used.map((c) => ask<{ load: Load; cpuPct: number }>(c, { cmd: 'go', startAtEpochMs })));
      return { load: mergeLoads(out.map((x) => x.load)), cpuPct: out.map((x) => round(x.cpuPct, 1)) };
    },
    close: () =>
      Promise.all(kids.map((c) => new Promise<void>((r) => (c.once('exit', () => r()), c.kill('SIGTERM'))))).then(() => undefined),
  };
}

/** The levels of the multi-worker rows: the 500-stream SLO level, where one gateway process saturates. */
export const WORKERS_LEVELS: readonly number[] = [500];

/**
 * The multi-worker rows: the Redis gateway as each of `workers` process counts sharing one port (as `serve --workers`
 * runs it), against a mock of `mockProcesses` processes, driven by `loadProcesses` load processes; the direct path
 * through the same mock and load processes. A row with one worker is the control: the same harness, one gateway
 * process. Mock and load CPU per process are recorded so a saturated harness shows in the results.
 */
export async function benchOverheadWorkers(o: {
  redisUrl: string;
  quick: boolean;
  log: (s: string) => void;
  workers: readonly number[];
  mockProcesses: number;
  loadProcesses: number;
  scenarios?: readonly Scenario[];
  concurrency?: readonly number[];
}): Promise<WorkersRow[]> {
  const mock = await spawn(['mock', String(o.mockProcesses)]);
  const pool = await loadPool(o.loadProcesses);
  const gateways: Array<{ workers: number; child: Child }> = [];
  for (const w of o.workers) gateways.push({ workers: w, child: await spawn(['gateway', 'redis', mock.url, String(w)], { ...process.env, BENCH_REDIS_URL: o.redisUrl }) });
  const rows: WorkersRow[] = [];
  let seed = 10_000;
  try {
    for (const s of o.scenarios ?? SCENARIOS) {
      // Warm-up (JIT, connection pools in every process), discarded.
      await pool.run(mock.url, s, 30, 2, seed++);
      for (const g of gateways) await pool.run(g.child.url, s, 30, 2, seed++);
      for (const c of o.concurrency ?? WORKERS_LEVELS) {
        const d = durationFor(s, c, o.quick);
        await mock.call('start');
        const direct = await pool.run(mock.url, s, c, d, seed++);
        const mockDirect = await mock.call('stop');
        for (const g of gateways) {
          await mock.call('start');
          await g.child.call('start');
          const via = await pool.run(g.child.url, s, c, d, seed++);
          const st = await g.child.call('stop');
          const mockVia = await mock.call('stop');
          const row: WorkersRow = {
            ...overheadRow({ scenario: s, store: 'redis', concurrency: c, durationS: d, direct: direct.load, via: via.load, stats: st }),
            workers: g.workers,
            mockProcesses: o.mockProcesses,
            loadProcesses: o.loadProcesses,
            mockCpuPct: { direct: mockDirect.perProcessCpuPct ?? [round(mockDirect.cpuPct, 1)], gateway: mockVia.perProcessCpuPct ?? [round(mockVia.cpuPct, 1)] },
            loadCpuPct: { direct: direct.cpuPct, gateway: via.cpuPct },
          };
          rows.push(row);
          o.log(`${rowLog(row, direct.load.errorKinds, via.load.errorKinds, ` workers=${g.workers}`)}, mock cpu ${row.mockCpuPct.direct.join('/')} | ${row.mockCpuPct.gateway.join('/')}%, load cpu ${row.loadCpuPct.direct.join('/')} | ${row.loadCpuPct.gateway.join('/')}%`);
        }
      }
    }
  } finally {
    for (const g of gateways) await g.child.close();
    await pool.close();
    await mock.close();
  }
  return rows;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [role, ...rest] = process.argv.slice(2);
  if (role === 'mock' || role === 'gateway' || role === 'load') await childMain(role, rest);
  else {
    const list = (v: string | undefined): string[] | undefined => (v ? v.split(',') : undefined);
    const common = {
      quick: process.env.BENCH_QUICK === '1',
      log: (s: string) => console.error(s),
      scenarios: list(process.env.BENCH_SCENARIOS) as Scenario[] | undefined,
      concurrency: list(process.env.BENCH_CONCURRENCY)?.map(Number),
    };
    // BENCH_WORKERS (for example 1,4) runs only the multi-worker rows, on REDIS_URL.
    const workers = list(process.env.BENCH_WORKERS)?.map(Number);
    const rows =
      workers && process.env.REDIS_URL
        ? await benchOverheadWorkers({ ...common, redisUrl: process.env.REDIS_URL, workers, mockProcesses: Number(process.env.BENCH_MOCK_PROCS ?? '3'), loadProcesses: Number(process.env.BENCH_LOAD_PROCS ?? '3') })
        : await benchOverhead({ ...common, redisUrl: process.env.REDIS_URL ?? null });
    console.log(JSON.stringify(rows, null, 2));
  }
}
