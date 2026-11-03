// The Vitest settings the CPU-time bounds rely on (test/helpers/timing.ts): one test file per process, so the process
// CPU time is that file's work (the forks pool), and the ten times looser bound under coverage, keyed on the resolved
// coverage.enabled rather than on a `--coverage` argument (V5 review).
import { expect, inject, test } from 'vitest';
import type { TestProject } from 'vitest/node';
import config from '../../vitest.config.js';
import setup from '../setup/coverage-flag.js';

test('the default suite pins the forks pool', () => {
  expect(config.test?.pool).toBe('forks');
});

test('the coverage flag tests see is the resolved coverage.enabled, however coverage was turned on', () => {
  for (const enabled of [true, false]) {
    const provided: Record<string, unknown> = {};
    const project = { globalConfig: { coverage: { enabled } }, provide: (k: string, v: unknown) => (provided[k] = v) };
    setup(project as unknown as TestProject);
    expect(provided).toEqual({ coverageRun: enabled });
  }
  expect(config.test?.globalSetup).toContain('test/setup/coverage-flag.ts');
  expect(typeof inject('coverageRun')).toBe('boolean');
});
