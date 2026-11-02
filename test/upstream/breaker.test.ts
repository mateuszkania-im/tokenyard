import { expect, test } from 'vitest';
import { Breaker } from '../../src/upstream/breaker.js';
import { RetryBudget } from '../../src/upstream/retry-budget.js';

const opts = { minRequests: 4, failureRatio: 0.5, windowSeconds: 30, openSeconds: 10 };

test('breaker opens at the failure ratio once minRequests were seen, and closes after openSeconds', () => {
  let t = 1_000;
  const b = new Breaker(opts, () => t);
  b.record('a', false);
  b.record('a', false);
  b.record('a', true);
  expect(b.allow('a')).toBe(true); // 3 outcomes, below minRequests
  b.record('a', false); // 4 outcomes, 3 failures
  expect(b.allow('a')).toBe(false);
  expect(b.allow('other')).toBe(true);
  t += 9_999;
  expect(b.allow('a')).toBe(false);
  t += 1;
  expect(b.allow('a')).toBe(true); // half open
  b.record('a', false); // the probe fails: open again at once
  expect(b.allow('a')).toBe(false);
  t += 10_000;
  expect(b.allow('a')).toBe(true);
  b.record('a', true); // the probe succeeds: closed with a clean window
  b.record('a', false);
  expect(b.allow('a')).toBe(true);
});

test('breaker counts only the trailing window and open(provider, untilMs) opens until then', () => {
  let t = 0;
  const b = new Breaker(opts, () => t);
  for (let i = 0; i < 3; i++) b.record('a', false);
  t += 31_000; // those failures left the window
  b.record('a', false);
  expect(b.allow('a')).toBe(true);
  b.open('a', t + 5_000);
  expect(b.allow('a')).toBe(false);
  t += 5_000;
  expect(b.allow('a')).toBe(true);
});

test('retry budget allows retries up to the ratio of requests in the trailing minute, at least one', () => {
  let t = 0;
  const r = new RetryBudget(0.1, () => t);
  r.request('acme');
  expect(r.tryRetry('acme')).toBe(true); // the floor of one
  expect(r.tryRetry('acme')).toBe(false);
  for (let i = 0; i < 99; i++) r.request('acme'); // 100 requests: 10 retries in all
  let granted = 0;
  while (r.tryRetry('acme')) granted++;
  expect(granted).toBe(9);
});

test('retry budget is per tenant, forgets after a minute, and a ratio of 0 allows none', () => {
  let t = 0;
  const r = new RetryBudget(0.1, () => t);
  r.request('a');
  expect(r.tryRetry('a')).toBe(true);
  expect(r.tryRetry('a')).toBe(false);
  r.request('b');
  expect(r.tryRetry('b')).toBe(true);
  t += 60_001;
  r.request('a');
  expect(r.tryRetry('a')).toBe(true);
  const none = new RetryBudget(0, () => t);
  none.request('a');
  expect(none.tryRetry('a')).toBe(false);
});
