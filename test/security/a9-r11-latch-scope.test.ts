// A9 (security review A): R11 ("one violation turns the bytes bound off ... until the factor is understood", docs/security.md Limitations) is a
// per-process boolean: a second instance on the same Redis, or the same instance after a restart, keeps reserving
// with the bytes bound that was just shown not to hold. Nothing persists the violation (the trace has boundExceeded,
// but warm-up does not read it).
import { afterEach, expect, test } from 'vitest';
import { createGatewayRuntime } from '../../src/edge/handler.js';
import { createMemoryStore } from '../../src/limits/memory-store.js';
import { authHeaders, send } from '../helpers/conformance.js';
import { testPolicy } from '../helpers/policy.js';
import { closeAll, gw, raw, readJson } from './common.js';

afterEach(closeAll);

test('A9 a bytes-bound violation seen by instance A turns the bytes bound off for instance B on the same store', async () => {
  const MODEL = 'claude-haiku-5-5';
  const up = await raw(async (req, res) => {
    await readJson(req);
    // billed input far above the body's bytes + 4096 bound
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'm', type: 'message', model: MODEL, content: [], usage: { input_tokens: 100_000, output_tokens: 1 } }));
  });
  const store = createMemoryStore({ clock: Date.now });
  const policy = testPolicy({ upstream: up.url });
  const ra = createGatewayRuntime();
  const rb = createGatewayRuntime();
  const a = await gw(policy, store, { runtime: ra });
  const b = await gw(policy, store, { runtime: rb });
  const body = Buffer.from(JSON.stringify({ model: MODEL, max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }));
  await send(a.url, { path: '/v1/messages', headers: authHeaders, body });
  await expect.poll(() => a.outcomes.length).toBe(1);
  await send(b.url, { path: '/v1/messages', headers: authHeaders, body });
  await expect.poll(() => b.outcomes.length).toBe(1);
  console.log(`A9 A.boundExceeded=${a.outcomes[0]?.boundExceeded} A.latch=${ra.bytesBoundOff} B.latch=${rb.bytesBoundOff} B.inputBound=${JSON.stringify(b.outcomes[0]?.inputBound)}`);
  expect(ra.bytesBoundOff).toBe(true);
  expect(b.outcomes[0]?.inputBound?.kind).toBe('context-window');
});

test('A9 a restarted instance (fresh runtime) on the same store starts with the bytes bound off', async () => {
  const store = createMemoryStore({ clock: Date.now });
  await store.latchBoundOff?.();
  const up = await raw(async (req, res) => {
    await readJson(req);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'm', type: 'message', model: 'claude-haiku-5-5', content: [], usage: { input_tokens: 5, output_tokens: 1 } }));
  });
  const runtime = createGatewayRuntime();
  const g = await gw(testPolicy({ upstream: up.url }), store, { runtime });
  await send(g.url, { path: '/v1/messages', headers: authHeaders, body: Buffer.from(JSON.stringify({ model: 'claude-haiku-5-5', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] })) });
  await expect.poll(() => g.outcomes.length).toBe(1);
  expect(g.outcomes[0]?.inputBound?.kind).toBe('context-window');
  expect(runtime.bytesBoundOff).toBe(true);
  expect(store.keys()).toContain('ty:{_global}:r11');
});

// Run through `npm run test:redis` (scripts/local-redis.mjs sets REDIS_URL).
test.skipIf(!process.env.REDIS_URL)('A9 Redis: the latch is one shared key every instance reads', async () => {
  const { createClient } = await import('redis');
  const { createRedisStore } = await import('../../src/limits/redis-store.js');
  const client = createClient({ url: process.env.REDIS_URL });
  await client.connect();
  try {
    await client.sendCommand(['FLUSHDB']);
    const a = createRedisStore(client, { deadlineMs: 60_000 });
    const b = createRedisStore(client, { deadlineMs: 60_000 });
    expect(await b.boundOffLatched?.()).toBe(false);
    await a.latchBoundOff?.();
    expect(await b.boundOffLatched?.()).toBe(true);
    expect(String(await client.sendCommand(['EXISTS', 'ty:{_global}:r11']))).toBe('1');
  } finally {
    await client.close();
  }
});
