// CI concurrency (V5 review): a newer push cancels the superseded push run, but never a mutation run started by hand,
// which takes up to two hours and shares the ref with the pushes.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { parse } from 'yaml';

const ci = parse(readFileSync(join(import.meta.dirname, '..', '..', '.github', 'workflows', 'ci.yml'), 'utf8')) as {
  concurrency: { group: string; 'cancel-in-progress': string };
  jobs: Record<string, { if?: string; concurrency?: { group: string; 'cancel-in-progress': boolean } }>;
};

test('a manual run is in its own concurrency group, and the mutation job is never cancelled by a newer run', () => {
  // The workflow group keys on the event, so a push to the ref does not cancel a workflow_dispatch run of it, and only
  // runs not started by hand cancel their predecessor.
  expect(ci.concurrency.group).toContain('github.event_name');
  expect(ci.concurrency['cancel-in-progress']).toBe("${{ github.event_name != 'workflow_dispatch' }}");
  const mutation = ci.jobs.mutation;
  expect(mutation?.if).toBe("github.event_name == 'workflow_dispatch'");
  expect(mutation?.concurrency?.group).toMatch(/^mutation-/);
  expect(mutation?.concurrency?.['cancel-in-progress']).toBe(false);
});
