// Spec 12.3 item 1: gateway overhead. autocannon drives the same load at the mock provider directly and through the
// gateway; added TTFB and added total time are the gateway's percentiles minus the direct ones. The mock and the gateway
// each run in their own child process, so the gateway's CPU and RSS are its own.
//   npx tsx bench/overhead.ts mock                          (child: the mock provider)
//   npx tsx bench/overhead.ts gateway <memory|redis> <mockUrl>   (child: the gateway; Redis URL in BENCH_REDIS_URL)
import { type ChildProcess, fork } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import autocannon from 'autocannon';
import { BENCH_PROVIDER_KEY, benchPolicy, minus, type Percentiles, percentiles, round } from './lib.js';
import { PROVIDER_KEY_ENV, TEST_KEY } from '../test/helpers/policy.js';

export type Scenario = 'non-streaming' | 'streaming-500' | 'body-150kb';
export const SCENARIOS: readonly Scenario[] = ['non-streaming', 'streaming-500', 'body-150kb'];
/** 10, 100 and 500 from spec 12.3; 1, 16, 64 and 256 for the extended verification (V1). */
export const CONCURRENCY = [1, 10, 16, 64, 100, 256, 500] as const;
/** Mock provider timing, fixed for every run. */
export const MOCK = { ttftMs: 100, tokensPerSec: 1_000, outputTokens: 500 } as const;
/**
 * Requests per second each connection is meant to send. Each is set below what one connection can complete against
 * the direct mock (non-streaming about 100 ms, streaming about 600 ms), so a slower gateway shows up as latency, and
 * the coordinated-omission correction uses 1000 / rate ms as the intended interval.
 */
const RATE: Record<Scenario, number> = { 'non-streaming': 4, 'streaming-500': 1, 'body-150kb': 1 };

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
  requests: { direct: number; gateway: number };
  errors: { direct: number; gateway: number };
  errorKinds: { direct: Record<string, number>; gateway: Record<string, number> };
  direct: { ttfb: Percentiles; total: Percentiles };
  gateway: { ttfb: Percentiles; total: Percentiles };
  added: { ttfb: Percentiles; total: Percentiles };
  gatewayCpuPct: number;
  cpuPctPer100Streams: number;
  gatewayRssMb: number;
  rssMbPer100Streams: number;
}

interface Load {
  ttfb: number[];
  total: number[];
  ok: number;
  errors: number;
  /** Non-2xx responses by status, and socket errors and timeouts as `socket` and `timeout`. */
  errorKinds: Record<string, number>;
}

/**
 * Connections are opened in groups of this size, 50 ms apart: macOS caps the listen backlog at kern.ipc.somaxconn (128),
 * and a few hundred connects at once get reset and retried in a storm that measures the OS, not the gateway.
 */
const CONNECT_GROUP = 64;

/**
 * One load run: autocannon instances of up to CONNECT_GROUP connections each, started 50 ms apart, each running
 * `durationS`. TTFB (response headers complete) and total time are recorded per request from the client's events.
 */
async function drive(url: string, s: Scenario, connections: number, durationS: number, body: Buffer): Promise<Load> {
  const ttfb: number[] = [];
  const total: number[] = [];
  let ok = 0;
  const kinds: Record<string, number> = {};
  const add = (k: string, n: number): void => {
    if (n > 0) kinds[k] = (kinds[k] ?? 0) + n;
  };
  const runs: Array<Promise<{ errors: number; timeouts: number }>> = [];
  for (let opened = 0; opened < connections; opened += CONNECT_GROUP) {
    if (opened > 0) await new Promise((r) => setTimeout(r, 50));
    runs.push(
      autocannon({
        url: `${url}/v1/messages`,
        connections: Math.min(CONNECT_GROUP, connections - opened),
        connectionRate: RATE[s],
        duration: durationS,
        method: 'POST',
        headers: HEADERS,
        body,
        timeout: 60,
        ignoreCoordinatedOmission: true, // corrected with the intended interval instead (see coCorrected)
        setupClient(client) {
          let start = 0n;
          let first = -1;
          client.on('request', () => {
            start = process.hrtime.bigint();
            first = -1;
          });
          client.on('headers', () => {
            first = Number(process.hrtime.bigint() - start) / 1e6;
          });
          client.on('response', (status: number) => {
            const t = Number(process.hrtime.bigint() - start) / 1e6;
            if (status >= 200 && status < 300 && first >= 0) {
              ok++;
              ttfb.push(first);
              total.push(t);
            } else add(String(status), 1);
          });
        },
      }),
    );
  }
  for (const r of await Promise.all(runs)) {
    add('timeout', r.timeouts);
    add('socket', r.errors - r.timeouts);
  }
  return { ttfb, total, ok, errors: Object.values(kinds).reduce((n, k) => n + k, 0), errorKinds: kinds };
}

interface Child {
  url: string;
  call(cmd: 'start' | 'stop'): Promise<{ cpuPct: number; peakRssMb: number; baselineRssMb: number }>;
  close(): Promise<void>;
}

function spawn(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<Child> {
  const child: ChildProcess = fork(join(import.meta.dirname, 'overhead.ts'), args, { execArgv: ['--import', 'tsx'], env, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`bench child ${args[0]} exited with ${code}`)));
    child.once('message', (m: { url: string }) => {
      child.removeAllListeners('exit');
      resolve({
        url: m.url,
        call: (cmd) =>
          new Promise((r) => {
            child.once('message', r);
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

/** Child side: CPU over a measured window, and RSS sampled every 50 ms against the RSS at the window's start. */
function serveStats(url: string): void {
  let baselineRssMb = 0;
  let cpu0 = process.cpuUsage();
  let t0 = process.hrtime.bigint();
  let peak = 0;
  let sampler: NodeJS.Timeout | undefined;
  process.on('message', (cmd: string) => {
    if (cmd === 'start') {
      cpu0 = process.cpuUsage();
      t0 = process.hrtime.bigint();
      peak = process.memoryUsage.rss();
      // RSS of the warmed-up process just before this run's load: the growth above it is what the load costs.
      baselineRssMb = peak / 1024 / 1024;
      sampler = setInterval(() => (peak = Math.max(peak, process.memoryUsage.rss())), 50);
      process.send?.({});
    } else if (cmd === 'stop') {
      clearInterval(sampler);
      const c = process.cpuUsage(cpu0);
      const wallUs = Number(process.hrtime.bigint() - t0) / 1e3;
      process.send?.({ cpuPct: ((c.user + c.system) / wallUs) * 100, peakRssMb: Math.max(peak, process.memoryUsage.rss()) / 1024 / 1024, baselineRssMb });
    }
  });
  process.send?.({ url });
}

async function childMain(role: string, args: string[]): Promise<void> {
  if (role === 'mock') {
    const { startAnthropicMock } = await import('../src/mock/anthropic.js');
    const mock = await startAnthropicMock({ scenario: { kind: 'ok', ttftMs: MOCK.ttftMs, tokensPerSec: MOCK.tokensPerSec, pingEveryMs: null, outputTokens: MOCK.outputTokens } });
    setInterval(() => (mock.received.length = 0), 1000).unref(); // the mock keeps every request it saw
    process.on('SIGTERM', () => void mock.close().then(() => process.exit(0)));
    serveStats(mock.url);
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
  const counters = await openCounterStore({ kind: store, ...(redisUrl ? { redisUrl } : {}), instance: 'bench', onSwept: (ids) => runtime.onSwept(ids) });
  const traceDir = mkdtempSync(join(tmpdir(), 'tokenyard-bench-traces-'));
  const writer = new TraceWriter({ dir: traceDir, instanceId: 'bench0001', queueMax: 100_000, clock: Date.now });
  const policy = benchPolicy(mockUrl);
  // As `tokenyard serve` builds it: traces written, metrics kept, a counter store round trip per request.
  const gw = createGateway({
    policy: () => policy,
    store: counters.store,
    runtime,
    traces: writer,
    traceSalt: 'bench-salt',
    clock: Date.now,
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
  serveStats(url);
}

const durationFor = (s: Scenario, c: number, quick: boolean): number => (quick ? 2 : Math.min(20, Math.max(5, Math.ceil(300 / (c * RATE[s])))));

/** Every scenario at every concurrency, direct and through a gateway per store. */
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
  try {
    for (const s of o.scenarios ?? SCENARIOS) {
      const body = scenarioBody(s);
      // Warm-up (JIT, connection pools), discarded.
      await drive(mock.url, s, 10, 2, body);
      for (const g of gateways) await drive(g.child.url, s, 10, 2, body);
      for (const c of o.concurrency ?? CONCURRENCY) {
        const d = durationFor(s, c, o.quick);
        const interval = 1000 / RATE[s];
        const direct = await drive(mock.url, s, c, d, body);
        const dp = { ttfb: percentiles(direct.ttfb, interval), total: percentiles(direct.total, interval) };
        for (const g of gateways) {
          await g.child.call('start');
          const via = await drive(g.child.url, s, c, d, body);
          const st = await g.child.call('stop');
          const gp = { ttfb: percentiles(via.ttfb, interval), total: percentiles(via.total, interval) };
          const row: OverheadRow = {
            scenario: s,
            store: g.store,
            concurrency: c,
            ratePerConnection: RATE[s],
            durationS: d,
            requests: { direct: direct.ok, gateway: via.ok },
            errors: { direct: direct.errors, gateway: via.errors },
            errorKinds: { direct: direct.errorKinds, gateway: via.errorKinds },
            direct: dp,
            gateway: gp,
            added: { ttfb: minus(gp.ttfb, dp.ttfb), total: minus(gp.total, dp.total) },
            gatewayCpuPct: round(st.cpuPct, 1),
            cpuPctPer100Streams: round((st.cpuPct * 100) / c, 1),
            gatewayRssMb: round(st.peakRssMb, 1),
            rssMbPer100Streams: round((Math.max(0, st.peakRssMb - st.baselineRssMb) * 100) / c, 1),
          };
          rows.push(row);
          o.log(`overhead ${s} ${g.store} c=${c}: added TTFB p50 ${row.added.ttfb.p50} p99 ${row.added.ttfb.p99} ms, added total p99 ${row.added.total.p99} ms, cpu ${row.gatewayCpuPct}%, errors ${JSON.stringify(direct.errorKinds)} / ${JSON.stringify(via.errorKinds)}`);
        }
      }
    }
  } finally {
    for (const g of gateways) await g.child.close();
    await mock.close();
  }
  return rows;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [role, ...rest] = process.argv.slice(2);
  if (role === 'mock' || role === 'gateway') await childMain(role, rest);
  else {
    const list = (v: string | undefined): string[] | undefined => (v ? v.split(',') : undefined);
    const rows = await benchOverhead({
      redisUrl: process.env.REDIS_URL ?? null,
      quick: process.env.BENCH_QUICK === '1',
      log: (s) => console.error(s),
      scenarios: list(process.env.BENCH_SCENARIOS) as Scenario[] | undefined,
      concurrency: list(process.env.BENCH_CONCURRENCY)?.map(Number),
    });
    console.log(JSON.stringify(rows, null, 2));
  }
}
