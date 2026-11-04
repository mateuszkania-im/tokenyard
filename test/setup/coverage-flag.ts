// Vitest global setup: tells the tests whether this run collects coverage (`inject('coverageRun')`), read from the
// resolved config, so `--coverage`, `--coverage.enabled` and a config file that enables it all count. The CPU-time
// bounds are ten times looser under coverage instrumentation (test/helpers/timing.ts).
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    coverageRun: boolean;
  }
}

export default function setup(project: TestProject): void {
  project.provide('coverageRun', project.globalConfig.coverage.enabled === true);
}
