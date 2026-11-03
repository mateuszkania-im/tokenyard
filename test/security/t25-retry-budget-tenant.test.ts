// Task 25 checklist (cross-tenant breaker and retry-budget interference): the breaker half is S12-1
// (test/security/s12-1-per-credential-breaker.test.ts). The retry budget (spec 8) is kept per tenant, the key record's
// tenant, never a header: a tenant whose provider keeps failing spends only its own fallback retries, and another
// tenant's requests still get theirs.
import { expect, test } from 'vitest';
import { RetryBudget } from '../../src/upstream/retry-budget.js';

test('T25 one tenant exhausting its retry budget leaves another tenant its own', () => {
  const now = { t: 1_000_000 };
  const budget = new RetryBudget(0.1, () => now.t);
  for (let i = 0; i < 100; i++) budget.request('noisy');
  let spent = 0;
  while (budget.tryRetry('noisy')) spent++;
  expect(spent).toBe(10);
  expect(budget.tryRetry('noisy')).toBe(false);
  budget.request('quiet');
  expect(budget.tryRetry('quiet')).toBe(true);
});

test('T25 tenant names cannot collide with the budget table prototype', () => {
  const budget = new RetryBudget(0.1, () => 0);
  for (const t of ['__proto__', 'constructor', 'toString']) {
    budget.request(t);
    expect(budget.tryRetry(t), t).toBe(true);
    expect(budget.tryRetry(t), t).toBe(false);
  }
});
