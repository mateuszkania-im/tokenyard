// The admit sequence the gateway runs and replay mirrors (spec 5.3 steps 7 and 8), shared from src/policy/admission.ts.
import { expect, test } from 'vitest';
import { holdsCounters, isAdmitted, planAdmission } from '../../src/policy/admission.js';
import { compilePolicy } from '../../src/policy/compile.js';
import { decide } from '../../src/policy/decide.js';
import type { Admission } from '../../src/policy/types.js';
import { features, HEAD, source } from './helpers.js';

const policy = (budgets = '') =>
  compilePolicy(
    source(`${HEAD}routes:
  - { name: all, chain: [a] }
${budgets}failure:
  counterStoreDown: { rateLimits: open, budgets: closed }
`),
    'r1',
    { experimentalSubscription: false },
  );
const OK: Admission = { admitted: true, failed: null, audit: [], totals: [] };
const DOWN: Admission = { admitted: false, failed: null, audit: [], totals: [], storeDown: true };

test('a plan with reservations calls admit; a plan with nothing to check does not', () => {
  const p = policy('budgets:\n  - { name: team-day, scope: team, window: day, usd: 100 }\n');
  const plan = decide(p, features());
  expect(holdsCounters(plan)).toBe(true);
  expect(planAdmission(p, plan)).toMatchObject({ taintWrite: false, callsAdmit: true, pre: { action: 'forward' } });
  expect(isAdmitted(plan, OK)).toBe(true);
  expect(isAdmitted(plan, DOWN)).toBe(false);
  expect(isAdmitted(plan, null)).toBe(false);
  const free = decide(policy(), features());
  expect(holdsCounters(free)).toBe(false);
  expect(planAdmission(policy(), free).callsAdmit).toBe(false);
});

test('a last-turn secret calls admit to write the taint, and is never admitted', () => {
  const p = policy();
  const plan = decide(p, features({ attribution: { session: 's' }, guardrail: { hits: [{ rule: 'r', action: 'block', valueHmac: 'h', where: 'last-turn' }] } }));
  expect(plan.preBlock).toBe('secret');
  expect(planAdmission(p, plan)).toMatchObject({ taintWrite: true, callsAdmit: true, pre: { action: 'block' } });
  expect(isAdmitted(plan, OK)).toBe(false);
});

test('a reservation larger than its budget is refused before admit', () => {
  const p = policy('budgets:\n  - { name: tiny, scope: team, window: day, usd: 0.000001 }\n');
  const plan = decide(p, features());
  expect(planAdmission(p, plan)).toMatchObject({ callsAdmit: false, pre: { action: 'block', block: { reason: 'budget' } } });
});
