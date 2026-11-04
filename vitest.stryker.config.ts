// Vitest config for Stryker (stryker.config.mjs). Each mutant reruns the tests that reach it, so this set is the
// in-process tests of the mutated modules and their callers: no real gateway over sockets, no child processes, no
// git history (the sandbox copy under .stryker-tmp/ has none of its own) and no process.chdir (Stryker runs Vitest in
// worker threads, which do not support it). With the gateway-level suites the run was estimated at five hours; those
// suites run in `npm test`. Timing bounds are off here (test/helpers/timing.ts).
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'test/policy/**/*.test.ts',
      'test/limits/**/*.test.ts',
      'test/guardrails/**/*.test.ts',
      'test/surfaces/**/*.test.ts',
      'test/stream/**/*.test.ts',
      'test/pricing/**/*.test.ts',
      'test/replay/**/*.test.ts',
      'test/fuzz/**/*.test.ts',
      'test/property/store.property.test.ts',
      'test/property/admit-concurrency.property.test.ts',
      'test/security/a1-*.test.ts',
      'test/security/a3-*.test.ts',
      'test/security/a4-*.test.ts',
      'test/security/a10-*.test.ts',
      'test/security/c8-*.test.ts',
      'test/security/s16-*.test.ts',
      'test/security/s-v3-1-*.test.ts',
      'test/security/s-v3-3-scan-work-budget.test.ts',
      'test/security/s25-2-*.test.ts',
      'test/security/s6-*.test.ts',
      'test/security/s10-*.test.ts',
      'test/security/s20-1-*.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/*.live.*', 'test/guardrails/fp-corpus.test.ts', 'test/policy-loader/**'],
    testTimeout: 30_000,
    env: { TOKENYARD_TIMING_BOUNDS: 'off' },
  },
});
