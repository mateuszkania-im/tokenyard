import { createClient } from 'redis';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { budgetKey, gcraKey, taintKey } from '../../src/limits/keys.js';
import { createRedisStore, redisSweepLock } from '../../src/limits/redis-store.js';
import type { Plan } from '../../src/policy/types.js';
import { runStoreContract } from './store-contract.js';

const url = process.env.REDIS_URL;
const plan = (over: Partial<Plan>): Plan => ({ id: `req_${Math.random()}`, policyRevision: 'r1', route: 'r', chain: [], reservations: [], rateChecks: [], streamSlots: [], taint: null, preBlock: null, warnings: [], ...over });

// Skipped, visibly, without REDIS_URL. `npm run test:redis` runs it against a real Redis (docker run -p 6379:6379 redis:7).
describe.skipIf(!url)('redis store (REDIS_URL)', () => {
  const client = createClient({ url });
  beforeAll(async () => {
    await client.connect();
  });
  afterAll(async () => {
    await client.flushDb();
    await client.close();
  });
  const make = async () => {
    await client.flushDb();
    return createRedisStore(client, { deadlineMs: 600_000 });
  };
  const keys = async () => (await client.keys('*')).sort();

  runStoreContract('redis', make, keys);

  test('NOSCRIPT after SCRIPT FLUSH falls back to EVAL', async () => {
    const s = await make();
    const key = budgetKey('acme', 'org', 'v', null);
    const p = plan({ reservations: [{ budget: 'org', key, limitMicroUsd: 1_000, estMicroUsd: 10, enforce: true, resetsAt: null }] });
    expect((await s.admit(p)).admitted).toBe(true);
    await client.scriptFlush();
    expect((await s.admit({ ...p, id: 'other' })).admitted).toBe(true);
    expect(await s.settle('other', 3)).toBe('settled');
    expect((await s.snapshot([key]))[key]).toEqual({ spent: 3, reserved: 10 });
  });

  test('taint set and budget keys carry a TTL; money fields are integers', async () => {
    const s = await make();
    const tk = taintKey('acme', 's1');
    await s.admit(plan({ taint: { key: tk, check: [], add: [{ rule: 'gh', valueHmac: 'h1' }], ttlMs: 60_000 } }));
    const ttl = await client.pTTL(tk);
    expect(ttl).toBeGreaterThan(59_000);
    expect(ttl).toBeLessThanOrEqual(60_000);
    const bk = budgetKey('acme', 'd', 'v', '2026-11-02');
    const resetsAt = new Date(Date.now() + 3_600_000).toISOString();
    await s.admit(plan({ reservations: [{ budget: 'd', key: bk, limitMicroUsd: 10_000_000_000_000, estMicroUsd: 9_007_199_254_740, enforce: true, resetsAt }] }));
    expect(await client.hGet(bk, 'r')).toBe('9007199254740');
    const exp = await client.pTTL(bk);
    expect(exp).toBeGreaterThan(3_600_000 + 86_000_000);
  });

  test('GCRA runs on the Redis clock, not the caller nowMs', async () => {
    const s = await make();
    const rate = { limit: 'rpm', key: gcraKey('acme', 'rpm', 'k'), emissionMs: 60_000, burst: 1, quantity: 1 };
    expect((await s.admit(plan({ rateChecks: [rate] }), 0)).admitted).toBe(true);
    expect((await s.admit(plan({ rateChecks: [rate] }), Date.now() + 3_600_000)).failed?.kind).toBe('rate');
  });

  test('sweep lock: SET NX PX, one holder at a time', async () => {
    await make();
    const a = redisSweepLock(client, { tenant: 'acme', instance: 'i1' });
    const b = redisSweepLock(client, { tenant: 'acme', instance: 'i2' });
    expect(await a.acquire()).toBe(true);
    expect(await b.acquire()).toBe(false);
    expect(await client.get('ty:{acme}:sweep-lock')).toBe('i1');
    const ttl = await client.pTTL('ty:{acme}:sweep-lock');
    expect(ttl).toBeGreaterThan(24_000);
    expect(ttl).toBeLessThanOrEqual(25_000);
  });
});
