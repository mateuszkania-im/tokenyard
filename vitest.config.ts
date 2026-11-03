import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // `*.live.*` files spend real money and run only through `npm run live` (spec 14.1), never in `vitest run`.
    include: ['test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/*.live.*'],
    // Children and wildcard listeners started by tests are tracked; leftovers fail the run (test/setup/process-guard.ts).
    globalSetup: ['test/setup/global-guard.ts'],
    setupFiles: ['test/setup/process-guard.ts'],
  },
});
