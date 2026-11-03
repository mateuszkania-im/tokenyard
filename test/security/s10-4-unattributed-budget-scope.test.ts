// S10-4 (coordinator finding, Task 10, MEDIUM): a request that omits the session or repo header must not dodge an
// enforced budget scoped to it. It is charged to the "(unattributed)" bucket, shared by every request without the
// header, so leaving the header out is never cheaper than sending one.
import { expect, test } from 'vitest';
import { createMemoryStore } from '../../src/limits/memory-store.js';
import { compilePolicy } from '../../src/policy/compile.js';
import { decide } from '../../src/policy/decide.js';
import { features, HEAD, source } from '../policy/helpers.js';

const STORE = 'failure:\n  counterStoreDown: { rateLimits: open, budgets: closed }\n  unpricedModel: allow-and-flag\n';
const p = compilePolicy(source(`${HEAD}routes:\n  - { name: all, chain: [a] }
budgets:
  - { name: repo-day, scope: repo, window: day, usd: 20 }
  - { name: session, scope: session, usd: 25 }
  - { name: audit-repo, scope: repo, window: day, usd: 5, mode: audit }
${STORE}`), 'r1', { experimentalSubscription: false });

test('S10-4 enforced session and repo budgets still apply with no session and no repo header', () => {
  const plan = decide(p, features());
  expect(plan.reservations.map((r) => [r.budget, r.key, r.enforce])).toEqual([
    ['repo-day', 'ty:{acme}:b:repo-day:(unattributed):2026-11-04', true],
    ['session', 'ty:{acme}:b:session:(unattributed)', true],
  ]);
});

test('S10-4 an audit-mode level without a value is skipped, not charged to a sentinel', () => {
  expect(decide(p, features()).reservations.some((r) => r.budget === 'audit-repo')).toBe(false);
});

test('S10-4 requests without the header share one bucket: the second is refused when the first filled it', async () => {
  const plan = decide(p, features());
  const limit = plan.reservations[0]?.estMicroUsd ?? 0;
  const tight = { ...plan, reservations: plan.reservations.map((r) => ({ ...r, limitMicroUsd: limit + 1 })) };
  const store = createMemoryStore({ clock: () => 1_000 });
  const first = await store.admit({ ...tight, id: 'req_1' });
  const second = await store.admit({ ...tight, id: 'req_2' });
  expect(first.admitted).toBe(true);
  expect(second.admitted).toBe(false);
  expect(second.failed).toMatchObject({ kind: 'budget' });
});
