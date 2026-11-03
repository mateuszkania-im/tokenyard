import { afterEach, expect, test } from 'vitest';
import { createMemoryStore } from '../../src/limits/memory-store.js';
import type { CounterStore } from '../../src/limits/store.js';
import { startAnthropicMock } from '../../src/mock/anthropic.js';
import { createMetrics, registerCollectors } from '../../src/telemetry/metrics.js';
import { Breaker } from '../../src/upstream/breaker.js';
import { authHeaders, msgBody, send } from '../helpers/conformance.js';
import { startGateway } from '../helpers/gateway.js';
import { PROVIDER_KEY_ENV, testPolicy } from '../helpers/policy.js';

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()?.();
  delete process.env[PROVIDER_KEY_ENV];
});

const get = (base: string, path: string) => send(base, { method: 'GET', path });
const down = (over: Partial<CounterStore> = {}): CounterStore => ({
  admit: async () => {
    throw new Error('ECONNREFUSED');
  },
  settle: async () => 'unknown',
  sweep: async () => 0,
  snapshot: async () => {
    throw new Error('ECONNREFUSED');
  },
  seed: async () => undefined,
  ...over,
});

async function stack(o: { store?: CounterStore | null; edit?: Parameters<typeof testPolicy>[0]['edit']; opsListener?: boolean } = {}) {
  process.env[PROVIDER_KEY_ENV] = 'sk-provider-test-value';
  const mock = await startAnthropicMock();
  closers.push(mock.close);
  const metrics = createMetrics();
  const policy = testPolicy({ upstream: mock.url, models: ['claude-haiku-*'], ...(o.edit ? { edit: o.edit } : {}) });
  registerCollectors(metrics, { revision: () => policy.revision, loadErrors: () => 0 });
  const gw = await startGateway({ policy, store: o.store === undefined ? createMemoryStore({ clock: Date.now }) : o.store, metrics, ...(o.opsListener ? { opsListener: true } : {}) });
  closers.push(gw.close);
  return { gw, mock, metrics };
}

test('/metrics serves tokenyard_* counters with no session, prompt or key labels', async () => {
  const { gw } = await stack();
  const ok = await send(gw.url, {
    path: '/v1/messages',
    headers: { ...authHeaders, 'x-claude-code-session-id': 'sess-SECRET-1', 'x-request-class': 'main' },
    body: msgBody({ model: 'claude-haiku-5-5' }),
  });
  expect(ok.status).toBe(200);
  const r = await get(gw.url, '/metrics');
  expect(r.status).toBe(200);
  expect(r.headers['content-type']).toMatch(/^text\/plain; version=0\.0\.4/);
  const text = r.body.toString();
  await new Promise((res) => setTimeout(res, 20));
  const text2 = (await get(gw.url, '/metrics')).body.toString();
  expect(text2).toMatch(/^tokenyard_requests_total\{route="claude-code",decision="forward",status_class="2xx"\} 1$/m);
  expect(text2).toMatch(/^tokenyard_cost_usd_total\{tenant="acme",team="platform",route="claude-code",request_class="[^"]*"\} \d/m);
  expect(text2).toMatch(/^tokenyard_tokens_total\{type="input",model="claude-haiku-5-5"\} \d+/m);
  expect(text2).toMatch(/^tokenyard_policy_revision_info\{revision="[^"]+"\} 1$/m);
  expect(text2).toMatch(/^tokenyard_policy_load_errors_total 0$/m);
  expect(text2).toMatch(/^tokenyard_reservations_open 0$/m);
  for (const t of [text, text2]) {
    expect(t).not.toMatch(/sess-SECRET|session|prompt|ty_live|sk-provider|req_0/i);
  }
});

test('/healthz is 200 without a policy; /readyz is 503 before a policy loads and 200 after', async () => {
  let loaded = false;
  const policy = testPolicy({ upstream: 'http://127.0.0.1:9' });
  const gw = await startGateway({
    policy: () => {
      if (!loaded) throw new Error('policy is not loaded');
      return policy;
    },
    store: null,
  });
  closers.push(gw.close);
  expect((await get(gw.url, '/healthz')).status).toBe(200);
  const before = await get(gw.url, '/readyz');
  expect(before.status).toBe(503);
  expect(JSON.parse(before.body.toString())).toEqual({ status: 'not ready', reason: 'policy not loaded' });
  loaded = true;
  expect((await get(gw.url, '/readyz')).status).toBe(200);
});

test('/readyz is 503 when the store is down with budgets closed, 200 when the policy fails open', async () => {
  const closed = await stack({ store: down() });
  const r = await get(closed.gw.url, '/readyz');
  expect(r.status).toBe(503);
  expect(r.body.toString()).not.toMatch(/ECONNREFUSED/);
  const open = await stack({ store: down(), edit: (p) => void (p.failure.counterStoreDown = { rateLimits: 'open', budgets: 'open' }) });
  expect((await get(open.gw.url, '/readyz')).status).toBe(200);
  const healthy = await stack();
  expect((await get(healthy.gw.url, '/readyz')).status).toBe(200);
});

test('store-down events, x-should-retry refusals and open reservations are counted', async () => {
  const slow = createMemoryStore({ clock: Date.now });
  const s = await stack({ store: down() });
  const blocked = await send(s.gw.url, { path: '/v1/messages', headers: authHeaders, body: msgBody({ model: 'claude-haiku-5-5' }) });
  expect(blocked.status).toBe(503);
  const refused = await stack({ store: slow });
  const r = await send(refused.gw.url, { path: '/v1/messages', headers: authHeaders, body: msgBody({ model: 'not-allowed-model-x' }) });
  expect(r.headers['x-should-retry']).toBe('false');
  await expect.poll(async () => (await get(s.gw.url, '/metrics')).body.toString()).toMatch(/^tokenyard_store_down_total\{op="admit"\} 1$/m);
  const t = (await get(refused.gw.url, '/metrics')).body.toString();
  expect(t).toMatch(/^tokenyard_should_retry_refusals_total\{reason="[a-z-]+"\} 1$/m);
  expect(t).toMatch(/^tokenyard_requests_total\{route="[^"]*",decision="block",status_class="4xx"\} 1$/m);
});

test('breaker openings are counted by scope, never by credential', () => {
  const m = createMetrics();
  const b = new Breaker({ minRequests: 2, failureRatio: 0.5, windowSeconds: 30, openSeconds: 30 }, () => 1000, (scope) => m.inc('tokenyard_breaker_opens_total', { scope }));
  b.record('anthropic', false);
  b.record('anthropic', false);
  b.open('anthropic|https://api.anthropic.com|ANTHROPIC_KEY', 5000, 'credential');
  const text = m.render();
  expect(text).toMatch(/^tokenyard_breaker_opens_total\{scope="provider"\} 1$/m);
  expect(text).toMatch(/^tokenyard_breaker_opens_total\{scope="credential"\} 1$/m);
  expect(text).not.toMatch(/ANTHROPIC_KEY|api\.anthropic/);
});

test('with an ops listener /metrics is served there only; health stays on both', async () => {
  const { gw } = await stack({ opsListener: true });
  expect((await get(gw.url, '/metrics')).status).toBe(404);
  expect((await get(gw.url, '/healthz')).status).toBe(200);
  const ops = gw.opsUrl as string;
  const m = await get(ops, '/metrics');
  expect(m.status).toBe(200);
  expect((await get(ops, '/readyz')).status).toBe(200);
  expect((await get(ops, '/v1/messages')).status).toBe(404);
});

test('the gateway hands the span sink the record and one entry per upstream attempt', async () => {
  process.env[PROVIDER_KEY_ENV] = 'sk-provider-test-value';
  const mock = await startAnthropicMock();
  closers.push(mock.close);
  const seen: Array<{ model: string; attempts: number | undefined; status: number | null | undefined }> = [];
  const gw = await startGateway({
    policy: testPolicy({ upstream: mock.url }),
    traceSalt: 'salt',
    spans: { requestSpan: (r, a) => seen.push({ model: r.features.model, attempts: a?.length, status: a?.[0]?.status }), shutdown: async () => undefined },
  });
  closers.push(gw.close);
  await send(gw.url, { path: '/v1/messages', headers: authHeaders, body: msgBody({ model: 'claude-haiku-5-5' }) });
  await expect.poll(() => seen.length).toBe(1);
  expect(seen[0]).toEqual({ model: 'claude-haiku-5-5', attempts: 1, status: 200 });
});
