// A10: a second admit for an id that already holds a reservation must never answer admitted: true without
// reserving anything. It is refused as a duplicate (kind 'duplicate'), so the handler never forwards it.
import { expect, test } from 'vitest';
import { budgetKey, streamKey } from '../../src/limits/keys.js';
import { createMemoryStore } from '../../src/limits/memory-store.js';
import type { CounterStore } from '../../src/limits/store.js';
import type { Plan } from '../../src/policy/types.js';
import { resolve } from '../../src/policy/resolve.js';
import { testPolicy } from '../helpers/policy.js';

const plan = (est: number): Plan => ({
  id: 'same-id', policyRevision: 'r', route: 'x', chain: [], preBlock: null, warnings: [], taint: null, rateChecks: [],
  reservations: [{ budget: 'b', key: budgetKey('acme', 'b', 'acme', null), limitMicroUsd: 1_000_000, enforce: true, resetsAt: null, estMicroUsd: est }],
  streamSlots: [{ limit: 's', key: streamKey('acme', 's', 'k'), max: 1 }],
});

async function check(store: CounterStore): Promise<void> {
  const first = await store.admit(plan(600_000));
  const second = await store.admit(plan(900_000));
  expect(first.admitted).toBe(true);
  expect(second.admitted).toBe(false);
  expect(second.failed?.kind).toBe('duplicate');
  // The first reservation is untouched and still settles once.
  const snap = await store.snapshot([budgetKey('acme', 'b', 'acme', null)]);
  expect(snap[budgetKey('acme', 'b', 'acme', null)]).toEqual({ spent: 0, reserved: 600_000 });
  expect(await store.settle('same-id', 10)).toBe('settled');
  expect(await store.settle('same-id', 10)).toBe('unknown');
}

test('A10 memory store: a duplicate admit id is refused, never admitted without a reservation', async () => {
  await check(createMemoryStore({ clock: Date.now }));
});

test('A10 a duplicate admission resolves to a non-retryable block', () => {
  const policy = testPolicy({ upstream: 'http://127.0.0.1:9' });
  const d = resolve(policy, plan(1), { admitted: false, failed: { kind: 'duplicate', name: 'duplicate' }, audit: [], totals: [] });
  expect(d.action).toBe('block');
  expect(d.block?.reason).toBe('duplicate');
  expect(d.block?.status).toBe(409);
});

// Run through `npm run test:redis` (scripts/local-redis.mjs sets REDIS_URL).
test.skipIf(!process.env.REDIS_URL)('A10 Redis store: a duplicate admit id is refused, never admitted without a reservation', async () => {
  const { createClient } = await import('redis');
  const { createRedisStore } = await import('../../src/limits/redis-store.js');
  const client = createClient({ url: process.env.REDIS_URL });
  await client.connect();
  try {
    await client.sendCommand(['FLUSHDB']);
    await check(createRedisStore(client, { deadlineMs: 60_000 }));
  } finally {
    await client.close();
  }
});
