// Mutation testing (V5): `npm run test:mutation`. Scope: the policy decision (decide), the budget accounting of the
// reference counter store (memory-store and the store helpers it uses), the cost estimator and the guardrail scanner.
// The vitest runner runs only the test files that import a mutated module (vitest.related) and, with perTest coverage,
// only the tests that reach each mutant. Equivalent mutants are listed in docs/quality-gates.md.
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: 'vitest',
  plugins: ['@stryker-mutator/vitest-runner'],
  vitest: { configFile: 'vitest.stryker.config.ts', related: true },
  mutate: ['src/policy/decide.ts', 'src/limits/memory-store.ts', 'src/limits/store.ts', 'src/limits/estimator.ts', 'src/guardrails/scan.ts'],
  coverageAnalysis: 'perTest',
  // Static mutants (module-level values: the rule tables, budget constants) run every test once per mutant: 33 of the
  // 1,963 mutants in the last full run, an estimated 61% of its time. They are ignored (reported as such); the rule
  // tables are pinned by the rule fixtures and the false-positive corpus, which check each rule's matches directly, and
  // the scan budget caps by test/guardrails/scan-budget-caps.test.ts (each cap at its boundary, values written out).
  ignoreStatic: true,
  incremental: true,
  incrementalFile: 'reports/stryker-incremental.json',
  thresholds: { high: 90, low: 80, break: 80 },
  reporters: ['clear-text', 'progress', 'html', 'json'],
  htmlReporter: { fileName: 'reports/mutation/mutation.html' },
  jsonReporter: { fileName: 'reports/mutation/mutation.json' },
  timeoutMS: 20_000,
  // Two test runners: with Stryker's default (one per CPU, four on a GitHub runner), each with its own Vitest workers
  // on the 1 MiB fuzz and scan bodies, the hosted runner was shut down a minute into the run, twice.
  concurrency: 2,
  tempDirName: '.stryker-tmp',
  // Stryker rewrites the sandbox's tsconfig through the TypeScript JS API, which TypeScript 7 (the native compiler)
  // does not ship. tsconfig.json has no extends or references, so there is nothing to rewrite: point the option at a
  // file that does not exist and the step is skipped. Vitest does not type-check, so the mutants run either way.
  tsconfigFile: 'tsconfig.stryker-unused.json',
  cleanTempDir: 'always',
};
