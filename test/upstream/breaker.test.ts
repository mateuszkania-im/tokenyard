import { expect, test } from 'vitest';
import fc from 'fast-check';
import { Breaker } from '../../src/upstream/breaker.js';
import { RetryBudget } from '../../src/upstream/retry-budget.js';
import { cpuBoundMs, cpuMs } from '../helpers/timing.js';
import { fuzz } from '../helpers/fuzz.js';

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

/** The breaker's window as first written (filter the whole window on every outcome), kept as the reference behaviour. */
class ReferenceBreaker {
  private readonly states = new Map<string, { events: Array<{ at: number; ok: boolean }>; openUntil: number; halfOpen: boolean }>();
  constructor(
    private readonly o: typeof opts,
    private readonly clock: () => number,
  ) {}
  private state(p: string): { events: Array<{ at: number; ok: boolean }>; openUntil: number; halfOpen: boolean } {
    let s = this.states.get(p);
    if (!s) this.states.set(p, (s = { events: [], openUntil: 0, halfOpen: false }));
    return s;
  }
  allow(p: string): boolean {
    const s = this.states.get(p);
    if (!s || s.openUntil === 0) return true;
    if (this.clock() < s.openUntil) return false;
    s.openUntil = 0;
    s.halfOpen = true;
    s.events = [];
    return true;
  }
  record(p: string, ok: boolean): void {
    const s = this.state(p);
    const now = this.clock();
    if (s.openUntil > now) return;
    if (s.halfOpen) {
      s.halfOpen = false;
      if (!ok) this.open(p, now + this.o.openSeconds * 1000);
      return;
    }
    const cutoff = now - this.o.windowSeconds * 1000;
    s.events = s.events.filter((e) => e.at > cutoff);
    s.events.push({ at: now, ok });
    const failures = s.events.filter((e) => !e.ok).length;
    if (s.events.length >= this.o.minRequests && failures / s.events.length >= this.o.failureRatio) this.open(p, now + this.o.openSeconds * 1000);
  }
  open(p: string, untilMs: number): void {
    const s = this.state(p);
    s.openUntil = untilMs;
    s.halfOpen = false;
    s.events = [];
  }
}

test('breaker decisions match the whole-window reference for any outcome sequence, clock steps backwards included (V1)', () => {
  type Op = { kind: 'record'; ok: boolean; dt: number } | { kind: 'allow'; dt: number } | { kind: 'open'; dt: number; forMs: number };
  const op: fc.Arbitrary<Op> = fc.oneof(
    { weight: 6, arbitrary: fc.record({ kind: fc.constant('record' as const), ok: fc.boolean(), dt: fc.integer({ min: -2_000, max: 8_000 }) }) },
    { weight: 3, arbitrary: fc.record({ kind: fc.constant('allow' as const), dt: fc.integer({ min: 0, max: 8_000 }) }) },
    { weight: 1, arbitrary: fc.record({ kind: fc.constant('open' as const), dt: fc.integer({ min: 0, max: 1_000 }), forMs: fc.integer({ min: 0, max: 20_000 }) }) },
  );
  fc.assert(
    fc.property(fc.array(op, { maxLength: 400 }), fc.integer({ min: 1, max: 6 }), fc.double({ min: 0.1, max: 1, noNaN: true }), (ops, minRequests, failureRatio) => {
      const o = { minRequests, failureRatio, windowSeconds: 10, openSeconds: 5 };
      let t = 1_000_000;
      const b = new Breaker(o, () => t);
      const ref = new ReferenceBreaker(o, () => t);
      for (const x of ops) {
        t += x.dt;
        if (x.kind === 'record') {
          b.record('p', x.ok);
          ref.record('p', x.ok);
        } else if (x.kind === 'open') {
          b.open('p', t + x.forMs);
          ref.open('p', t + x.forMs);
        }
        expect(b.allow('p')).toBe(ref.allow('p'));
      }
    }),
    fuzz(5141, 300),
  );
});

test('recording an outcome does not scan the whole window: 30,000 outcomes inside one 30 s window in well under 250 ms (V1)', () => {
  let t = 0;
  const b = new Breaker({ minRequests: 20, failureRatio: 0.5, windowSeconds: 30, openSeconds: 30 }, () => t);
  // CPU time: a loaded machine stretches the wall clock, not the work (V5)
  const ms = cpuMs(() => {
    for (let i = 0; i < 30_000; i++) {
      t += 0.5; // 2,000 outcomes per second (500 streams at 4 requests a second): the whole run stays inside the window
      b.record('p', i % 4 !== 0);
    }
  });
  expect(ms).toBeLessThan(cpuBoundMs(250));
  expect(b.allow('p')).toBe(true);
});

test('long outcome sequences that compact the window (more than 1,024 expired outcomes) match the reference (V1 fix round)', () => {
  fc.assert(
    fc.property(fc.array(fc.tuple(fc.boolean(), fc.integer({ min: 0, max: 40 })), { minLength: 3_000, maxLength: 5_000 }), fc.integer({ min: -5_000, max: 0 }), (outcomes, backstep) => {
      const o = { minRequests: 50, failureRatio: 0.9, windowSeconds: 10, openSeconds: 5 };
      let t = 0;
      const b = new Breaker(o, () => t);
      const ref = new ReferenceBreaker(o, () => t);
      for (const [i, [ok, dt]] of outcomes.entries()) {
        t += dt + (i === 2_500 ? backstep : 0);
        b.record('p', ok);
        ref.record('p', ok);
        expect(b.allow('p')).toBe(ref.allow('p'));
      }
    }),
    fuzz(5142, 20),
  );
});
