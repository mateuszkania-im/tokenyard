import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // `*.live.*` files spend real money and run only through `npm run live` (spec 14.1), never in `vitest run`.
    include: ['test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/*.live.*'],
    // The timeout is a hang guard, not a time bound: no test asserts time through it (time bounds are CPU-time or ratio
    // checks, docs/quality-gates.md). At 5 s, tests that run git and the bundle in subprocesses for 1 to 1.5 s timed out
    // with every core busy (S19-1, C8c, C11, C12, the Action's base policy case).
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Children and wildcard listeners started by tests are tracked; leftovers fail the run (test/setup/process-guard.ts).
    globalSetup: ['test/setup/global-guard.ts'],
    setupFiles: ['test/setup/process-guard.ts'],
    // CPU-time bounds scale under coverage instrumentation (test/helpers/timing.ts).
    env: process.argv.includes('--coverage') ? { TOKENYARD_COVERAGE: '1' } : {},
    // `npm run test:coverage`: V8 coverage of src (tests that run the bundle in a child process add nothing here).
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text', 'json-summary', 'html'],
      reportsDirectory: 'coverage',
      // Measured (V5) and rounded down; decide, the budget accounting, the estimator and the scanner at least 85% of
      // lines and branches. Two runs differed by 0.1 point on paths that depend on timing (aborts, deadlines), so the
      // global numbers and handler.ts sit one point below the lowest run. redis-store.ts runs only in `npm run test:redis` (a real Redis), so it has no threshold here.
      thresholds: {
        lines: 89,
        branches: 81,
        functions: 88,
        statements: 87,
        'src/policy/decide.ts': { lines: 100, branches: 94, functions: 100, statements: 98 },
        'src/policy/resolve.ts': { lines: 98, branches: 89, functions: 100, statements: 98 },
        'src/limits/memory-store.ts': { lines: 100, branches: 94, functions: 100, statements: 98 },
        'src/limits/store.ts': { lines: 100, branches: 94, functions: 100, statements: 96 },
        'src/limits/estimator.ts': { lines: 100, branches: 97, functions: 100, statements: 99 },
        'src/guardrails/scan.ts': { lines: 98, branches: 90, functions: 100, statements: 96 },
        'src/stream/sse.ts': { lines: 100, branches: 98, functions: 100, statements: 100 },
        'src/edge/handler.ts': { lines: 93, branches: 88, functions: 89, statements: 91 },
      },
    },
  },
});
