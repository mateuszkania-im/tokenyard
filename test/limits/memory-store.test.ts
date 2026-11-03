import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { budgetKey, gcraKey, newSessionsKey, sessionKey, streamKey, taintKey } from '../../src/limits/keys.js';
import { createMemoryStore, type MemoryCounterStore } from '../../src/limits/memory-store.js';
import type { CounterStore } from '../../src/limits/store.js';
import type { Plan } from '../../src/policy/types.js';
import { runStoreContract } from './store-contract.js';

runStoreContract('memory', async (o) => createMemoryStore({ clock: () => Date.now(), ...o }), { listKeys: async (s: CounterStore) => (s as MemoryCounterStore).keys() });

const plan = (over: Partial<Plan>): Plan => ({ id: 'req_1', policyRevision: 'r1', route: 'r', chain: [], reservations: [], rateChecks: [], streamSlots: [], taint: null, preBlock: null, warnings: [], ...over });

test('admit has no await: check and write happen in one synchronous section', () => {
  const src = readFileSync(join(import.meta.dirname, '..', '..', 'src', 'limits', 'memory-store.ts'), 'utf8');
  expect(src).not.toMatch(/\bawait\b/);
});

test('taint expires after its TTL on the store clock', async () => {
  let now = 1_000_000;
  const s = createMemoryStore({ clock: () => now });
  const key = taintKey('acme', 's1');
  await s.admit(plan({ taint: { key, check: [], add: [{ rule: 'gh', valueHmac: 'h1' }], ttlMs: 60_000 } }));
  const check = plan({ id: 'req_2', taint: { key, check: ['h1'], add: [], ttlMs: 60_000 } });
  now += 59_999;
  expect((await s.admit(check)).failed?.kind).toBe('taint');
  now += 1;
  expect((await s.admit({ ...check, id: 'req_3' })).admitted).toBe(true);
  expect(s.keys()).not.toContain(key);
});

test('budget keys expire one day after their window ends; session keys after the idle TTL (S-V2-1: 24 h by default, was 30 days)', async () => {
  let now = Date.UTC(2026, 10, 2, 12);
  const s = createMemoryStore({ clock: () => now });
  const day = budgetKey('acme', 'd', 'v', '2026-11-02');
  const sess = budgetKey('acme', 's', 'v', null);
  await s.admit(plan({
    reservations: [
      { budget: 'd', key: day, limitMicroUsd: 1_000, estMicroUsd: 10, enforce: true, resetsAt: '2026-11-03T00:00:00.000Z' },
      { budget: 's', key: sess, limitMicroUsd: 1_000, estMicroUsd: 10, enforce: true, resetsAt: null },
    ],
  }));
  await s.settle('req_1', 10);
  now = Date.UTC(2026, 10, 3, 23, 59);
  expect((await s.snapshot([day]))[day]).toEqual({ spent: 10, reserved: 0 });
  expect((await s.snapshot([sess]))[sess]).toEqual({ spent: 0, reserved: 0 }); // idle since 12:00 on 11-02, past 24 h
  now = Date.UTC(2026, 10, 4);
  expect((await s.snapshot([day]))).toEqual({ [day]: { spent: 0, reserved: 0 } });
});

test('admit uses nowMs when given (sim store on a virtual clock)', async () => {
  const s = createMemoryStore({ clock: () => 0 });
  const rate = { limit: 'rpm', key: gcraKey('acme', 'rpm', 'k1'), emissionMs: 1_000, burst: 1, quantity: 1 };
  expect((await s.admit(plan({ id: 'a', rateChecks: [rate] }), 10_000)).admitted).toBe(true);
  expect((await s.admit(plan({ id: 'b', rateChecks: [rate] }), 10_500)).failed).toEqual({ kind: 'rate', name: 'rpm', retryAfterMs: 500 });
  expect((await s.admit(plan({ id: 'c', rateChecks: [rate] }), 11_000)).admitted).toBe(true);
});

test('sweep uses the deadline option and returns how many it settled', async () => {
  const s = createMemoryStore({ clock: () => 0, deadlineMs: 1_000 });
  const slot = { limit: 'st', key: streamKey('acme', 'st', 'k1'), max: 1 };
  await s.admit(plan({ id: 'a', streamSlots: [slot] }));
  expect(await s.sweep(999)).toBe(0);
  expect(await s.sweep(1_000)).toBe(1);
  expect((await s.admit(plan({ id: 'b', streamSlots: [slot] }))).admitted).toBe(true);
});

test('prototype-like names are plain keys', async () => {
  const s = createMemoryStore({ clock: () => 0 });
  const key = budgetKey('__proto__', 'constructor', 'toString', null);
  const p = plan({
    id: '__proto__',
    reservations: [{ budget: 'constructor', key, limitMicroUsd: 100, estMicroUsd: 10, enforce: true, resetsAt: null }],
    rateChecks: [{ limit: 'hasOwnProperty', key: gcraKey('__proto__', 'hasOwnProperty', '__proto__'), emissionMs: 1, burst: 1, quantity: 1 }],
    streamSlots: [{ limit: 'valueOf', key: streamKey('__proto__', 'valueOf', 'constructor'), max: 1 }],
    taint: { key: taintKey('__proto__', '__proto__'), check: ['__proto__', 'constructor'], add: [], ttlMs: 1_000 },
  });
  expect((await s.admit(p)).admitted).toBe(true);
  expect(await s.settle('__proto__', 7)).toBe('settled');
  expect(await s.settle('constructor', 7)).toBe('unknown');
  expect((await s.snapshot([key]))[key]).toEqual({ spent: 7, reserved: 0 });
  expect(({} as Record<string, unknown>).s).toBeUndefined();
});

test('S-V2-1: a session budget key and the session marker expire after the idle TTL from their last admit, not after 30 days', async () => {
  let now = 1_000_000;
  const s = createMemoryStore({ clock: () => now });
  const key = budgetKey('acme', 'session', 's1', null);
  const marker = sessionKey('acme', 's1');
  const p = (id: string): Plan =>
    plan({
      id,
      sessionIdleTtlMs: 3_600_000,
      reservations: [{ budget: 'session', key, limitMicroUsd: 1_000_000, estMicroUsd: 10, enforce: true, resetsAt: null }],
      newSession: { limit: 'new-sessions', markerKey: marker, key: newSessionsKey('acme', 'k1'), emissionMs: 3_600, burst: 1_000, ttlMs: 3_600_000 },
    });
  await s.admit(p('a'));
  await s.settle('a', 5);
  now += 3_599_999;
  await s.admit(p('b')); // used again just before it expires: the TTL slides
  await s.settle('b', 5);
  now += 3_599_999;
  expect(s.keys()).toEqual(expect.arrayContaining([key, marker]));
  expect((await s.snapshot([key]))[key]).toEqual({ spent: 10, reserved: 0 });
  now += 1;
  await s.sweep(now);
  expect(s.keys()).not.toContain(key);
  expect(s.keys()).not.toContain(marker);
});

test('S-V2-1: without sessionIdleTtlMs a session budget key lives 24 hours after its last admit', async () => {
  let now = 1_000_000;
  const s = createMemoryStore({ clock: () => now });
  const key = budgetKey('acme', 'session', 's1', null);
  await s.admit(plan({ id: 'a', reservations: [{ budget: 'session', key, limitMicroUsd: 1_000_000, estMicroUsd: 10, enforce: true, resetsAt: null }] }));
  await s.settle('a', 1);
  now += 86_400_000;
  await s.sweep(now);
  expect(s.keys()).not.toContain(key);
});
