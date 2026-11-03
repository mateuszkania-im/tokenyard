// Work bounds for tests that must hold on a loaded machine. Wall-clock time grows with every process competing for the
// cores; the CPU time this process spends does not (much), so a bound on work is a bound on CPU time. Vitest runs each
// test file in its own worker process, so the process CPU time is the test's own work plus its garbage collector.

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
