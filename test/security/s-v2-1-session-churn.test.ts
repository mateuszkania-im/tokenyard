// S-V2-1 (V2 soak): every new client-chosen session id created counter state (the session budget level, 30 days) and
// nothing bounded how many a key could create. Now a key may start `sessions.newPerKeyPerHour` new sessions (checked
// inside admit, one round trip) and session keys idle out after `sessions.idleTtlHours`. A hostile client sending a new
// session id on every request is refused (429 session-churn, x-should-retry: false, traced) once its allowance is used,
// and the store stops growing; another key with a few sessions is unaffected. Memory store here; Redis with
// `npm run test:redis`.
import { createClient } from 'redis';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { hashKey } from '../../src/edge/auth.js';
import type { TraceRecord } from '../../src/ledger/record.js';
import { createMemoryStore } from '../../src/limits/memory-store.js';
import { createRedisStore } from '../../src/limits/redis-store.js';
import type { CounterStore } from '../../src/limits/store.js';
import { startAnthropicMock } from '../../src/mock/anthropic.js';
import type { MockServer } from '../../src/mock/anthropic.js';
import { send } from '../helpers/conformance.js';
import { startGateway, type TestGateway } from '../helpers/gateway.js';
import { PROVIDER_KEY_ENV, TEST_KEY, testPolicy } from '../helpers/policy.js';

const HOSTILE_KEY = 'ty_live_hostile';
const ALLOWANCE = 20;

let mock: MockServer | undefined;
let gw: TestGateway | undefined;
afterEach(async () => {
  await gw?.close();
  await mock?.close();
  gw = mock = undefined;
  delete process.env[PROVIDER_KEY_ENV];
});

async function stack(store: CounterStore): Promise<{ url: string; traces: Array<Omit<TraceRecord, 'instance' | 'seq'>> }> {
  process.env[PROVIDER_KEY_ENV] = 'provider-key';
  mock = await startAnthropicMock({ keepReceived: 0 });
  const traces: Array<Omit<TraceRecord, 'instance' | 'seq'>> = [];
  const policy = testPolicy({
    upstream: mock.url,
    extraKeys: [{ hash: hashKey(HOSTILE_KEY), keyId: 'key_hostile', tenant: 'acme', team: 'platform', name: 'hostile', kind: 'developer', billing: 'api' }],
    edit: (p) => {
      p.sessions = { idleTtlHours: 24, newPerKeyPerHour: ALLOWANCE };
      p.rateLimits = [];
    },
  });
  gw = await startGateway({ policy, store, traceSalt: 'salt', traces: { write: (r) => (traces.push(r), true) } });
  return { url: gw.url, traces };
}

const call = (url: string, key: string, session: string) =>
  send(url, {
    path: '/v1/messages',
    headers: { 'x-api-key': key, 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'user-agent': 'claude-cli/2.1.316 (external, cli)', 'x-claude-code-session-id': session },
    body: JSON.stringify({ model: 'claude-haiku-5-5', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] }),
  });

/** Runs the hostile client and a legitimate one; returns the store's key count after each hostile phase. */
async function scenario(store: CounterStore, countKeys: () => Promise<number>): Promise<void> {
  const { url, traces } = await stack(store);
  // A hostile client: a new session id on every request.
  const first = [];
  for (let i = 0; i < 3 * ALLOWANCE; i++) first.push(await call(url, HOSTILE_KEY, `hostile-${i}`));
  expect(first.filter((r) => r.status === 200)).toHaveLength(ALLOWANCE);
  const refused = first.filter((r) => r.status === 429);
  expect(refused).toHaveLength(2 * ALLOWANCE);
  const r = refused[0] as (typeof refused)[number];
  expect(r.headers['x-should-retry']).toBe('false');
  expect(r.headers['retry-after']).toBeUndefined();
  expect(r.body.toString('utf8')).toContain(`more than ${ALLOWANCE} new sessions per hour (sessions.newPerKeyPerHour)`);
  expect(traces.filter((t) => t.decision.reason === 'session-churn')).toHaveLength(2 * ALLOWANCE);
  const keysAfterFirst = await countKeys();
  // A thousand more new sessions: all refused, and the store does not grow at all.
  for (let i = 0; i < 1_000; i++) expect((await call(url, HOSTILE_KEY, `more-${i}`)).status).toBe(429);
  expect(await countKeys()).toBe(keysAfterFirst);
  // A session the hostile key already started keeps working.
  expect((await call(url, HOSTILE_KEY, 'hostile-0')).status).toBe(200);
  // A legitimate key with three sessions is unaffected by the other key's churn.
  for (let i = 0; i < 30; i++) expect((await call(url, TEST_KEY, `dev-${i % 3}`)).status).toBe(200);
}

test('S-V2-1 memory store: a new session id per request is refused past the allowance and the store stops growing', async () => {
  const store = createMemoryStore({ clock: Date.now });
  await scenario(store, async () => store.keys().length);
  // Session state is bounded by the allowance: one marker and one session budget level per admitted session.
  expect(store.keys().filter((k) => k.includes(':sess:'))).toHaveLength(ALLOWANCE + 3);
  expect(store.keys().filter((k) => k.includes(':b:session:'))).toHaveLength(ALLOWANCE + 3);
}, 60_000);

const url = process.env.REDIS_URL;
describe.skipIf(!url)('S-V2-1 redis store (REDIS_URL)', () => {
  const client = createClient({ url });
  beforeAll(async () => {
    await client.connect();
  });
  afterAll(async () => {
    await client.flushDb();
    await client.close();
  });

  test('a new session id per request is refused past the allowance; Redis keys and memory stop growing', async () => {
    await client.flushDb();
    const store = createRedisStore(client, { deadlineMs: 600_000 });
    const memory = async (): Promise<number> => Number(/used_memory:(\d+)/.exec(await client.info('memory'))?.[1]);
    const samples: number[] = [];
    await scenario(store, async () => {
      samples.push(await memory());
      return Number(await client.dbSize());
    });
    const keys = (await client.keys('*')).filter((k) => k.includes(':sess:'));
    expect(keys).toHaveLength(ALLOWANCE + 3);
    for (const k of keys) expect(await client.pTTL(k)).toBeLessThanOrEqual(24 * 3_600_000);
    // The thousand refused new sessions wrote nothing: used_memory moved by allocator noise only.
    expect(Math.abs((samples[1] as number) - (samples[0] as number))).toBeLessThan(64 * 1024);
  }, 60_000);
});
