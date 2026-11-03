// G4 (spec 7.4): the budget proof. 1,000 requests issued at once (up to 100 in flight) through the gateway against a $1 budget, actual cost
// drawn (seeded) between 0 and each request's reservation, on the memory store always and on Redis with REDIS_URL.
import { Agent } from 'node:http';
import fc from 'fast-check';
import { createClient } from 'redis';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import type { TraceRecord } from '../../src/ledger/record.js';
import { budgetKey } from '../../src/limits/keys.js';
import { createMemoryStore } from '../../src/limits/memory-store.js';
import { createRedisStore } from '../../src/limits/redis-store.js';
import type { CounterStore } from '../../src/limits/store.js';
import { startAnthropicMock } from '../../src/mock/anthropic.js';
import type { Plan } from '../../src/policy/types.js';
import { authHeaders, send } from '../helpers/conformance.js';
import { startGateway } from '../helpers/gateway.js';
import { PROVIDER_KEY_ENV, testPolicy } from '../helpers/policy.js';
import { spyStore } from '../helpers/store-spy.js';

type Rec = Omit<TraceRecord, 'instance' | 'seq'>;
const LIMIT = 1_000_000;
const N = 1_000;

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  delete process.env[PROVIDER_KEY_ENV];
});

/** Deterministic request shapes: body size and max_tokens vary, so reservations differ (each well under $1). */
function body(i: number): Buffer {
  const text = 'x'.repeat(100 + ((i * 7919) % 3_900));
  return Buffer.from(JSON.stringify({ model: 'claude-opus-5-5', max_tokens: 16 + ((i * 104_729) % 2_000), stream: i % 2 === 0, messages: [{ role: 'user', content: text }] }));
}

async function proof(inner: CounterStore): Promise<void> {
  process.env[PROVIDER_KEY_ENV] = 'k';
  const mock = await startAnthropicMock({ scenario: { kind: 'randomUsage', seed: 42 } });
  closers.push(mock.close);
  const spy = spyStore(inner);
  const traces: Rec[] = [];
  const policy = testPolicy({
    upstream: mock.url,
    edit: (p) => {
      p.budgets = [{ name: 'proof', scope: 'tenant', window: 'day', usd: 1, onExceed: 'block', mode: 'enforce' }];
      p.rateLimits = [];
    },
  });
  const gw = await startGateway({ policy, store: spy.store, traces: { write: (r) => (traces.push(r), true) }, traceSalt: 's' });
  closers.push(gw.close);

  // All 1,000 are issued at once; the client keeps at most 100 connections open, below the default listen backlog
  // (128 on macOS), so the OS never resets a connection. Admission still sees about 100 requests in flight.
  const agent = new Agent({ keepAlive: true, maxSockets: 100 });
  closers.push(async () => agent.destroy());
  const results = await Promise.all(Array.from({ length: N }, (_, i) => send(gw.url, { path: '/v1/messages', headers: authHeaders, body: body(i), agent })));
  await expect.poll(() => traces.length, { timeout: 20_000 }).toBe(N);
  await expect.poll(() => spy.settles.length, { timeout: 20_000 }).toBe(spy.admits.filter((a) => a.admission.admitted).length);

  const admitted = spy.admits.filter((a) => a.admission.admitted);
  const rejected = spy.admits.filter((a) => !a.admission.admitted);
  expect(admitted.length).toBeGreaterThan(10);
  expect(rejected.length).toBeGreaterThan(10); // the budget really ran out
  for (const a of spy.admits) expect((a.plan.reservations[0]?.estMicroUsd ?? 0) <= LIMIT).toBe(true);

  // (a) invariant 1 after every admit, from the post-admit totals the store returned.
  const maxObservedSpentPlusReserved = Math.max(...admitted.flatMap((a) => a.admission.totals.map((t) => t.spentMicroUsd + t.reservedMicroUsd)));
  expect(maxObservedSpentPlusReserved).toBeLessThanOrEqual(LIMIT);

  const key = spy.admits[0]?.plan.reservations[0]?.key as string;
  const final = (await inner.snapshot([key]))[key] as { spent: number; reserved: number };
  const sumOfSettledCosts = spy.settles.filter((s) => s.result === 'settled').reduce((n, s) => n + s.actual, 0);
  // (b) invariant 2 and (c) no lost update.
  expect(final.spent).toBeLessThanOrEqual(LIMIT);
  expect(final.spent).toBe(sumOfSettledCosts);
  expect(final.reserved).toBe(0);
  expect(spy.settles.every((s) => s.result === 'settled')).toBe(true);
  // (d) every rejection was over the limit as its own admit saw it.
  for (const r of rejected) {
    expect(r.admission.failed?.kind).toBe('budget');
    const t = r.admission.totals.find((x) => x.key === key) as { spentMicroUsd: number; reservedMicroUsd: number };
    const est = r.plan.reservations[0]?.estMicroUsd as number;
    expect(t.spentMicroUsd + t.reservedMicroUsd + est).toBeGreaterThan(LIMIT);
  }
  // Every request got an answer: 200 when admitted, the budget 429 otherwise; traces agree with the store.
  expect(results.filter((r) => r.status === 200)).toHaveLength(admitted.length);
  expect(results.filter((r) => r.status === 429)).toHaveLength(rejected.length);
  expect(traces.some((t) => t.outcome.overrun)).toBe(false);
  expect(traces.filter((t) => t.decision.reservedMicroUsd > 0)).toHaveLength(admitted.length);
  expect(traces.reduce((n, t) => n + (t.decision.reservedMicroUsd > 0 ? (t.outcome.costMicroUsd ?? 0) : 0), 0)).toBe(sumOfSettledCosts);
  expect(traces.every((t) => t.outcome.settledBy === 'request')).toBe(true);
}

test('G4: 1,000 requests issued at once, up to 100 in flight, $1 budget, random actual cost up to each reservation (memory store)', async () => {
  await proof(createMemoryStore({ clock: Date.now }));
}, 60_000);

const url = process.env.REDIS_URL;
describe.skipIf(!url)('G4 on Redis (REDIS_URL)', () => {
  const client = createClient({ url });
  beforeAll(async () => {
    await client.connect();
    await client.flushDb();
  });
  afterAll(async () => {
    await client.flushDb();
    await client.close();
  });
  test('G4: 1,000 requests issued at once, up to 100 in flight, $1 budget, random actual cost up to each reservation (redis store)', async () => {
    await proof(createRedisStore(client, { deadlineMs: 600_000 }));
  }, 60_000);
});

// The precise form of "behaves like a sequential run" (spec 7.4): every admit's outcome on the memory store equals what
// a sequential model returns when it applies the same operations in the store's commit order.
type Op = { kind: 'admit'; est: number } | { kind: 'settle'; target: number; frac: number };

test('property: memory store admit outcomes equal a sequential model applied in commit order', async () => {
  const op = fc.oneof(
    fc.record({ kind: fc.constant('admit' as const), est: fc.integer({ min: 0, max: 400 }) }),
    fc.record({ kind: fc.constant('settle' as const), target: fc.nat(60), frac: fc.double({ min: 0, max: 1, noNaN: true }) }),
  );
  await fc.assert(
    fc.asyncProperty(fc.array(op, { maxLength: 60 }), async (ops: Op[]) => {
      const store = createMemoryStore({ clock: Date.now });
      const limits = [1_000, 600];
      const keys = [budgetKey('acme', 'org', 'acme', '2026-11-02'), budgetKey('acme', 'sess', 's1', null)];
      const resetsAt = new Date(Date.now() + 86_400_000).toISOString();
      const model = { s: [0, 0], r: [0, 0], open: new Map<string, number>() };
      const ids: Array<{ id: string; est: number }> = [];
      const pending: Array<Promise<unknown>> = [];
      const expected: boolean[] = [];
      const got: Array<Promise<boolean>> = [];
      // Every call is issued without awaiting in between: the commit order is the issue order.
      ops.forEach((o, i) => {
        if (o.kind === 'admit') {
          const id = `r${i}`;
          ids.push({ id, est: o.est });
          const plan: Plan = {
            id, policyRevision: 'r', route: 'r', chain: [], rateChecks: [], streamSlots: [], taint: null, preBlock: null, warnings: [],
            reservations: keys.map((key, j) => ({ budget: `b${j}`, key, limitMicroUsd: limits[j] as number, estMicroUsd: o.est, enforce: true, resetsAt: j === 0 ? resetsAt : null })),
          };
          const fits = limits.every((l, j) => (model.s[j] as number) + (model.r[j] as number) + o.est <= l);
          if (fits) {
            for (const j of [0, 1]) model.r[j] = (model.r[j] as number) + o.est;
            model.open.set(id, o.est);
          }
          expected.push(fits);
          got.push(store.admit(plan).then((a) => a.admitted));
        } else {
          const t = ids[o.target % Math.max(1, ids.length)];
          if (!t) return;
          const actual = Math.floor(t.est * o.frac);
          const est = model.open.get(t.id);
          if (est !== undefined) {
            for (const j of [0, 1]) {
              model.r[j] = (model.r[j] as number) - est;
              model.s[j] = (model.s[j] as number) + actual;
            }
            model.open.delete(t.id);
          }
          pending.push(store.settle(t.id, actual));
        }
      });
      await Promise.all(pending);
      expect(await Promise.all(got)).toEqual(expected);
      const snap = await store.snapshot(keys);
      expect(keys.map((k) => snap[k])).toEqual([0, 1].map((j) => ({ spent: model.s[j], reserved: model.r[j] })));
    }),
    { numRuns: 200 },
  );
});
