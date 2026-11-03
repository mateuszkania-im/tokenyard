// Shared pieces of `npm run bench` (spec 12.3): percentiles with coordinated-omission correction, the gateway policy
// the benchmarks run under, and the environment description that goes into bench/results.json.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { arch, cpus, release, totalmem } from 'node:os';
import { join } from 'node:path';
import type { PolicyDoc } from '../src/policy/schema.js';
import type { CompiledPolicy } from '../src/policy/types.js';
import { testPolicy } from '../test/helpers/policy.js';

export const ROOT = join(import.meta.dirname, '..');

export interface Percentiles {
  p50: number;
  p95: number;
  p99: number;
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
 * Latency samples with coordinated-omission correction, the HdrHistogram `recordValueWithExpectedInterval` rule: a
 * request that took L ms on a connection meant to send every I ms also stood for the requests that should have been
 * sent while it was outstanding, so L - I, L - 2I, ... down to I are added. autocannon 8.0.0 applies this rule with an
 * interval of `Math.ceil(1 / rate)` ms (1 ms for any rate of 1 per second or more), which floods the histogram with
 * small values; the benchmark therefore records raw samples itself and corrects them with the intended interval.
 */
export function coCorrected(samples: readonly number[], intervalMs: number): number[] {
  const out: number[] = [];
  for (const v of samples) {
    out.push(v);
    if (intervalMs <= 0) continue;
    for (let missing = v - intervalMs; missing >= intervalMs; missing -= intervalMs) out.push(missing);
  }
  return out.sort((a, b) => a - b);
}

export function percentiles(samples: readonly number[], intervalMs: number): Percentiles {
  const s = coCorrected(samples, intervalMs);
  return { p50: round(percentile(s, 50)), p95: round(percentile(s, 95)), p99: round(percentile(s, 99)) };
}

export const minus = (a: Percentiles, b: Percentiles): Percentiles => ({ p50: round(a.p50 - b.p50), p95: round(a.p95 - b.p95), p99: round(a.p99 - b.p99) });

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
    tools: { autocannon: pkgVersion('autocannon'), tsx: pkgVersion('tsx'), redis: redisVersion },
  };
}
