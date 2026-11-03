// Shared pieces of `npm run bench` (spec 12.3): percentiles, the open-loop schedule, CPU and RSS slopes, the gateway policy
// the benchmarks run under, and the environment description that goes into bench/results.json.
import { execFileSync } from 'node:child_process';
import { type Agent, request } from 'node:http';
import { readFileSync } from 'node:fs';
import { arch, cpus, release, totalmem } from 'node:os';
import { join } from 'node:path';
import type { PolicyDoc } from '../src/policy/schema.js';
import type { CompiledPolicy } from '../src/policy/types.js';
import { testPolicy } from '../test/helpers/policy.js';

export const ROOT = join(import.meta.dirname, '..');

export interface Percentiles {
  p50: number | null;
  p95: number | null;
  p99: number | null;
  n: number;
}

/** Nearest-rank percentile of an ascending array. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(sorted.length, rank) - 1] as number;
}

export const round = (n: number, digits = 2): number => {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};

/**
 * Nearest-rank p50, p95 and p99 of raw samples, with their count. Coordinated omission is handled where the samples
 * are taken (latency counted from each request's intended send time), so no synthetic values are added here.
 */
export function percentiles(samples: readonly number[]): Percentiles {
  if (samples.length === 0) return { p50: null, p95: null, p99: null, n: 0 };
  const s = [...samples].sort((a, b) => a - b);
  return { p50: round(percentile(s, 50)), p95: round(percentile(s, 95)), p99: round(percentile(s, 99)), n: s.length };
}

/**
 * Open-loop schedule of one connection: intended send times `startMs + phaseMs + k * intervalMs` before `endMs`. The
 * phase (in [0, interval)) differs per connection, so connections do not fire together.
 */
export function intendedStarts(o: { startMs: number; endMs: number; intervalMs: number; phaseMs: number }): number[] {
  if (!(o.phaseMs >= 0 && o.phaseMs < o.intervalMs)) throw new Error(`phase ${o.phaseMs} is outside [0, ${o.intervalMs})`);
  const out: number[] = [];
  for (let t = o.startMs + o.phaseMs; t < o.endMs; t += o.intervalMs) out.push(t);
  return out;
}

export interface Throughput {
  requestsPerS: number;
  outputTokensPerS: number;
  /** From the run's first scheduled send to its last answer: longer than the window when a saturated path drains. */
  elapsedS: number;
}

/** Answered (2xx) requests and output tokens per second of one run, over the time it actually took. */
export function throughput(o: { answered: number; outputTokens: number; firstScheduledMs: number; lastAnswerMs: number }): Throughput {
  const elapsedMs = o.answered > 0 ? Math.max(0, o.lastAnswerMs - o.firstScheduledMs) : 0;
  if (elapsedMs === 0) return { requestsPerS: 0, outputTokensPerS: 0, elapsedS: 0 };
  return { requestsPerS: round((o.answered * 1000) / elapsedMs, 1), outputTokensPerS: round((o.outputTokens * 1000) / elapsedMs, 0), elapsedS: round(elapsedMs / 1000, 2) };
}

/**
 * A run in which the gateway could not keep up: a full core (the gateway is single-threaded), or, when throughput was
 * measured, fewer than 90% of the offered requests answered per second, or a drain more than 20% past the window.
 */
export function rowSaturated(r: { concurrency: number; ratePerConnection?: number; durationS?: number; gatewayCpuPct: number; throughput?: { gateway: Throughput } }): boolean {
  if (r.gatewayCpuPct >= 95) return true;
  const t = r.throughput?.gateway;
  if (!t || r.ratePerConnection === undefined || r.durationS === undefined) return false;
  return t.requestsPerS < 0.9 * r.concurrency * r.ratePerConnection || t.elapsedS > 1.2 * r.durationS;
}

/**
 * Gateway CPU and RSS growth per 100 streams as the slope between two concurrency levels of the same store and
 * scenario, so the fixed cost of an idle process does not scale with the stream count.
 */
export function cpuRssSlopes(
  rows: ReadonlyArray<{ store: string; scenario: string; concurrency: number; gatewayCpuPct: number; rssGrowthMb: number } & Parameters<typeof rowSaturated>[0]>,
  from: number,
  to: number,
): Array<{ store: string; scenario: string; from: number; to: number; cpuPctPer100Streams: number; rssMbPer100Streams: number; saturated: boolean }> {
  const out: Array<{ store: string; scenario: string; from: number; to: number; cpuPctPer100Streams: number; rssMbPer100Streams: number; saturated: boolean }> = [];
  for (const lo of rows.filter((r) => r.concurrency === from)) {
    const hi = rows.find((r) => r.concurrency === to && r.store === lo.store && r.scenario === lo.scenario);
    if (!hi) continue;
    const per100 = 100 / (to - from);
    out.push({
      store: lo.store,
      scenario: lo.scenario,
      from,
      to,
      cpuPctPer100Streams: round((hi.gatewayCpuPct - lo.gatewayCpuPct) * per100, 1),
      rssMbPer100Streams: round((hi.rssGrowthMb - lo.rssGrowthMb) * per100, 1),
      // A gateway that could not keep up at the upper level cannot spend more CPU: the slope then understates the cost.
      saturated: rowSaturated(hi),
    });
  }
  return out;
}

/** The provider key variable the test policy reads; the mock never checks its value. */
export const BENCH_PROVIDER_KEY = 'bench-not-a-key';

/**
 * examples/policy with the benchmark's budgets: the route, guardrails and price table as shipped, every budget level
 * enforced with a limit the load never reaches (so admit really reserves and settles on each level), and no rate
 * limits (they would turn load into 429s).
 */
export function benchPolicy(upstream: string, edit?: (p: PolicyDoc) => void): CompiledPolicy {
  return testPolicy({
    upstream,
    edit: (p) => {
      p.budgets = [
        { name: 'org-month', scope: 'tenant', window: 'month', usd: 1_000_000_000, onExceed: 'block', mode: 'enforce' },
        { name: 'team-day', scope: 'team', window: 'day', usd: 1_000_000_000, onExceed: 'block', mode: 'enforce' },
        { name: 'dev-day', scope: 'key', window: 'day', usd: 1_000_000_000, onExceed: 'block', mode: 'enforce' },
      ];
      p.rateLimits = [];
      edit?.(p);
    },
  });
}

function tryRun(cmd: string, args: string[]): string | null {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

const pkgVersion = (name: string): string => (JSON.parse(readFileSync(join(ROOT, 'node_modules', name, 'package.json'), 'utf8')) as { version: string }).version;

export function environment(redisVersion: string | null): {
  runAt: string;
  git: { commit: string; dirty: boolean };
  hardware: { cpu: string; cores: number; memoryGb: number; arch: string };
  os: { platform: string; release: string };
  node: string;
  tools: Record<string, string | null>;
} {
  const commit = tryRun('git', ['-C', ROOT, 'rev-parse', '--short', 'HEAD']) ?? 'unknown';
  // Only the files the benchmark runs count: the results file and README written by this run do not make it dirty.
  const dirty = (tryRun('git', ['-C', ROOT, 'status', '--porcelain', '--', 'src', 'bench', 'test/helpers', 'examples', 'package.json', 'package-lock.json']) ?? '')
    .split('\n')
    .filter((l) => l.trim() !== '' && !l.endsWith('bench/results.json')).length > 0;
  return {
    runAt: new Date().toISOString(),
    git: { commit, dirty },
    hardware: { cpu: cpus()[0]?.model.trim() ?? 'unknown', cores: cpus().length, memoryGb: Math.round(totalmem() / 1024 ** 3), arch: arch() },
    os: { platform: process.platform, release: release() },
    node: process.version,
    tools: { tsx: pkgVersion('tsx'), redis: redisVersion },
  };
}

/**
 * Opens one keep-alive connection per agent (`GET /healthz`, any answer will do), 64 at a time: macOS caps the listen
 * backlog at kern.ipc.somaxconn (128), and a few hundred connects at once get reset. Each agent should have
 * maxSockets 1, so its next request reuses that connection.
 */
export async function preconnect(agents: Agent[], base: string): Promise<void> {
  const url = new URL(base);
  for (let i = 0; i < agents.length; i += 64) {
    await Promise.all(
      agents.slice(i, i + 64).map(
        (agent) =>
          new Promise<void>((resolve) => {
            const req = request({ host: url.hostname, port: url.port, method: 'GET', path: '/healthz', agent }, (res) => {
              res.resume();
              res.on('end', () => resolve());
            });
            req.on('error', () => resolve());
            req.end();
          }),
      ),
    );
  }
}

/** The `soak` section of an existing results file: written by `npm run soak` (V2), which this run does not repeat. */
export function keptSoak(file: string): { soak?: unknown } {
  try {
    const soak = (JSON.parse(readFileSync(file, 'utf8')) as { soak?: unknown }).soak;
    return soak === undefined ? {} : { soak };
  } catch {
    return {};
  }
}

/** SLO target for added TTFB (spec 12.1), ms. */
export const ADDED_TTFB_TARGET = { p50: 5, p99: 25 } as const;

/**
 * Added TTFB verdict: met only when the gateway's own per-request measure and the client-side TTFB outside the
 * provider through the gateway are both under target. The second is an upper bound on what the gateway adds (it
 * also holds the client's and the loopback's share) and, unlike the first, includes time a request waits before the
 * gateway starts handling it. Null when there are no samples.
 */
export function ttfbVerdict(gatewayMeasured: Percentiles, clientOutsideProvider: Percentiles): boolean | null {
  const all = [gatewayMeasured.p50, gatewayMeasured.p99, clientOutsideProvider.p50, clientOutsideProvider.p99];
  if (all.some((x) => x === null)) return null;
  const under = (p: Percentiles): boolean => (p.p50 as number) < ADDED_TTFB_TARGET.p50 && (p.p99 as number) < ADDED_TTFB_TARGET.p99;
  return under(gatewayMeasured) && under(clientOutsideProvider);
}
