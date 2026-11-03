// Task 10 deferred item (Task 25 checklist): rate and stream limits scoped to a header-derived value (session or repo)
// would skip when the client omits the header, the same dodge as S10-4 for budgets. The policy schema scopes them to
// tenant, team or key only (values from the key record), so such a policy does not load; budgets scoped to session or
// repo charge `(unattributed)` instead (test/security/s10-4-unattributed-budget-scope.test.ts).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { parsePolicyFiles } from '../../src/policy/load-dir.js';

const EXAMPLE = join(import.meta.dirname, '..', '..', 'examples', 'policy');
const read = (f: string): string => readFileSync(join(EXAMPLE, f), 'utf8');
const LINE = '  - { name: dev-streams, scope: key, concurrentStreams: 8 }';

function load(scope: string) {
  const policy = read('policy.yaml');
  if (!policy.includes(LINE)) throw new Error('examples/policy/policy.yaml changed; update this test');
  const edited = policy.replace(LINE, `${LINE}\n  - { name: per-x, scope: ${scope}, rpm: 10, concurrentStreams: 2 }`);
  return parsePolicyFiles('examples/policy', { 'policy.yaml': edited, 'prices.yaml': read('prices.yaml'), 'keys.yaml': read('keys.yaml') });
}

for (const scope of ['session', 'repo', 'feature', 'agentType']) {
  test(`T10 a rate or stream limit scoped to the client-chosen ${scope} is refused at load`, () => {
    expect(() => load(scope)).toThrow(/scope/);
  });
}

test('T10 the same limit scoped to the key loads (the refusal above is the scope, not the limit)', () => {
  expect(load('key').policy.rateLimits.some((r) => r.name === 'per-x')).toBe(true);
});
