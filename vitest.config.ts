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
  },
});
