import fc from 'fast-check';
import { expect, test } from 'vitest';
import { gcra } from '../../src/limits/gcra.js';

test('a fresh key allows `burst` requests at once, then asks to wait one emission interval', () => {
  let tat: number | null = null;
  for (let i = 0; i < 3; i++) {
    const r = gcra(tat, 1_000, 500, 3, 1);
    expect(r.allowed).toBe(true);
    expect(r.retryAfterMs).toBe(0);
    tat = r.tatMs;
  }
  expect(tat).toBe(2_500);
  const denied = gcra(tat, 1_000, 500, 3, 1);
  expect(denied).toEqual({ allowed: false, tatMs: 2_500, retryAfterMs: 500 });
  // After waiting retryAfterMs the request fits.
  expect(gcra(tat, 1_500, 500, 3, 1).allowed).toBe(true);
});

test('quantity q consumes q emission intervals', () => {
  const a = gcra(null, 0, 100, 5, 4);
  expect(a).toEqual({ allowed: true, tatMs: 400, retryAfterMs: 0 });
  const b = gcra(a.tatMs, 0, 100, 5, 2);
  expect(b).toEqual({ allowed: false, tatMs: 400, retryAfterMs: 100 });
  expect(gcra(a.tatMs, 0, 100, 5, 1).allowed).toBe(true);
});

test('a TAT in the past counts as now', () => {
  expect(gcra(10, 1_000, 100, 1, 1)).toEqual({ allowed: true, tatMs: 1_100, retryAfterMs: 0 });
});

test('property: never more than burst + elapsed/emission requests are allowed', () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 1000 }), fc.integer({ min: 1, max: 10 }), fc.array(fc.integer({ min: 0, max: 2000 }), { maxLength: 60 }), (e, burst, gaps) => {
      let tat: number | null = null;
      let now = 0;
      let allowed = 0;
      for (const g of gaps) {
        now += g;
        const r = gcra(tat, now, e, burst, 1);
        if (r.allowed) {
          allowed++;
          tat = r.tatMs;
        } else {
          expect(r.retryAfterMs).toBeGreaterThan(0);
          expect(gcra(tat, now + r.retryAfterMs, e, burst, 1).allowed).toBe(true);
        }
      }
      expect(allowed).toBeLessThanOrEqual(burst + Math.floor(now / e));
    }),
  );
});
