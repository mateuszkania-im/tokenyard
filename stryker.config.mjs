// Mutation testing (V5): `npm run test:mutation`. Scope: the policy decision (decide), the budget accounting of the
// reference counter store (memory-store and the store helpers it uses), the cost estimator and the guardrail scanner.
// The vitest runner runs only the test files that import a mutated module (vitest.related) and, with perTest coverage,
// only the tests that reach each mutant. Equivalent mutants are listed in docs/quality.md.
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: 'vitest',
  plugins: ['@stryker-mutator/vitest-runner'],
  vitest: { configFile: 'vitest.config.ts', related: true },
  mutate: ['src/policy/decide.ts', 'src/limits/memory-store.ts', 'src/limits/store.ts', 'src/limits/estimator.ts', 'src/guardrails/scan.ts'],
  coverageAnalysis: 'perTest',
  incremental: true,
  incrementalFile: 'reports/stryker-incremental.json',
  thresholds: { high: 90, low: 80, break: 80 },
  reporters: ['clear-text', 'progress', 'html', 'json'],
  htmlReporter: { fileName: 'reports/mutation/mutation.html' },
  jsonReporter: { fileName: 'reports/mutation/mutation.json' },
  timeoutMS: 20_000,
  tempDirName: '.stryker-tmp',
  cleanTempDir: 'always',
};
