import { defineConfig } from 'vitest/config';

export default defineConfig({
  // `*.live.*` files spend real money and run only through `npm run live` (spec 14.1), never in `vitest run`.
  test: { include: ['test/**/*.test.ts'], exclude: ['**/node_modules/**', '**/*.live.*'] },
});
