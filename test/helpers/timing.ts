// Work bounds for tests that must hold on a loaded machine. Wall-clock time grows with every process competing for the
// cores; the CPU time this process spends does not (much), so a bound on work is a bound on CPU time. Vitest runs each
// test file in its own worker process (the forks pool, pinned in vitest.config.ts), so the process CPU time is the
// test's own work plus its garbage collector.
import { inject } from 'vitest';

/** Process CPU time (user plus system), in ms, that a synchronous call takes. */
export function cpuMs(fn: () => void): number {
  const t0 = process.cpuUsage();
  fn();
  const d = process.cpuUsage(t0);
  return (d.user + d.system) / 1000;
}

/** The least CPU time of `runs` calls: one call caught by a GC pause or a page fault storm does not decide a ratio. */
export function minCpuMs(fn: () => void, runs = 3): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < runs; i++) best = Math.min(best, cpuMs(fn));
  return best;
}

/**
 * False under mutation testing (vitest.stryker.config.ts): Stryker runs instrumented code in worker threads, which
 * share one process's CPU time, so neither a CPU-time bound nor a growth ratio measures one test's work there. The
 * bounds are checked in `npm test` and `npm run test:coverage`; mutation testing is about behaviour. Tests that only
 * bound time over 1 to 32 MiB bodies are skipped there (`test.skipIf(!TIMING_BOUNDS)`): instrumented, they take minutes.
 */
export const TIMING_BOUNDS = process.env.TOKENYARD_TIMING_BOUNDS !== 'off';

/**
 * A CPU-time bound for this run (no bound when TIMING_BOUNDS is false): `ms` as measured uninstrumented, ten times that
 * when the run collects coverage (`npm run test:coverage`, or coverage.enabled set any other way; the flag comes from
 * test/setup/coverage-flag.ts), whose per-block counters made the byte loops of the scanner up to about 8 times
 * slower. Still far below the quadratic or unbounded behaviour each bound rules out.
 */
export const cpuBoundMs = (ms: number): number => (!TIMING_BOUNDS ? Number.POSITIVE_INFINITY : inject('coverageRun') === true ? ms * 10 : ms);
