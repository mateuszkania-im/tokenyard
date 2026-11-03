// Spec 5.3 steps 7 to 12 with a real counter store: admit before forwarding, settle after the end with the computed
// cost, and what the trace records about both (spec 9.1).
import { Agent, request } from 'node:http';
import { afterEach, expect, test, vi } from 'vitest';
import { createGatewayRuntime } from '../../src/edge/handler.js';
import type { TraceRecord } from '../../src/ledger/record.js';
import { createMemoryStore } from '../../src/limits/memory-store.js';
import type { CounterStore } from '../../src/limits/store.js';
import { startAnthropicMock } from '../../src/mock/anthropic.js';
import { costMicroUsd } from '../../src/pricing/cost.js';
import { createGateway } from '../../src/edge/server.js';
import { authHeaders, msgBody, send, sendTolerant, startRawUpstream } from '../helpers/conformance.js';
import { startGateway } from '../helpers/gateway.js';
import { PROVIDER_KEY_ENV, testPolicy } from '../helpers/policy.js';
import { spyStore } from '../helpers/store-spy.js';

type Rec = Omit<TraceRecord, 'instance' | 'seq'>;
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  delete process.env[PROVIDER_KEY_ENV];
  vi.restoreAllMocks();
});

async function gateway(o: { upstream: string; store: CounterStore; policy?: Omit<Parameters<typeof testPolicy>[0], 'upstream'>; runtime?: ReturnType<typeof createGatewayRuntime> }) {
  process.env[PROVIDER_KEY_ENV] = 'k';
  const traces: Rec[] = [];
  const policy = testPolicy({ upstream: o.upstream, ...o.policy });
  const experimentalSubscription = o.policy?.billing === 'subscription';
  const gw = await startGateway({ policy, store: o.store, traces: { write: (r) => (traces.push(r), true) }, traceSalt: 's', runtime: o.runtime, experimentalSubscription });
  closers.push(gw.close);
  return { url: gw.url, traces, policy };
}

async function raw(handler: Parameters<typeof startRawUpstream>[0]) {
  const up = await startRawUpstream(handler);
  closers.push(up.close);
  return up;
}

const sse = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const start = (model: string, usage: Record<string, number>) => sse('message_start', { type: 'message_start', message: { model, usage } });
const json = (model: string, usage: Record<string, unknown>) => JSON.stringify({ id: 'msg_1', type: 'message', model, content: [], usage });

test('aborted stream after message_start settles input from message_start and output at the reserved bound (A3), never zero', async () => {
  const up = await raw((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(start('claude-haiku-5-5', { input_tokens: 120, cache_read_input_tokens: 30, output_tokens: 1 }));
    res.write(sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } }));
  });
  const spy = spyStore(createMemoryStore({ clock: Date.now }));
  const g = await gateway({ upstream: up.url, store: spy.store });
  const u = new URL(g.url);
  await new Promise<void>((done) => {
    const req = request({ host: u.hostname, port: u.port, method: 'POST', path: '/v1/messages', headers: authHeaders }, (res) => {
      res.on('data', (c: Buffer) => {
        if (c.toString().includes('content_block_delta')) {
          req.destroy();
          done();
        }
      });
    });
    req.on('error', () => undefined);
    req.end(msgBody({ model: 'claude-haiku-5-5', stream: true }));
  });
  await expect.poll(() => g.traces.length).toBe(1);
  const t = g.traces[0] as Rec;
  // No message_delta output count: streamed characters bound nothing, so output is the request's max_tokens (64).
  const expected = costMicroUsd(g.policy.prices, 'claude-haiku-5-5', { input: 120, cacheRead: 30, cacheWrite5m: 0, cacheWrite1h: 0, output: 64 });
  expect(expected).toBeGreaterThan(0);
  expect(spy.settles).toEqual([{ id: t.id, actual: expected, result: 'settled' }]);
  expect(t.outcome).toMatchObject({ aborted: true, usageSource: 'estimated', costMicroUsd: expected, settledBy: 'request', overrun: false });
  expect(t.decision.reservedMicroUsd).toBe(spy.admits[0]?.plan.reservations[0]?.estMicroUsd);
});

test('client abort before upstream headers: upstream aborted, settled 0, slot freed, aborted true', async () => {
  const rejections: unknown[] = [];
  const onRejection = (e: unknown): void => void rejections.push(e);
  process.on('unhandledRejection', onRejection);
  closers.push(async () => void process.off('unhandledRejection', onRejection));
  let arrived: () => void = () => undefined;
  const reached = new Promise<void>((r) => (arrived = r));
  let upstreamClosed: () => void = () => undefined;
  const closed = new Promise<void>((r) => (upstreamClosed = r));
  let hang = true;
  const up = await raw((req, res) => {
    req.resume();
    if (!hang) return void res.writeHead(200, { 'content-type': 'application/json' }).end(json('claude-haiku-5-5', { input_tokens: 5, output_tokens: 1 }));
    res.on('close', () => upstreamClosed());
    arrived(); // never answers
  });
  const spy = spyStore(createMemoryStore({ clock: Date.now }));
  const g = await gateway({
    upstream: up.url,
    store: spy.store,
    policy: { edit: (p) => void (p.rateLimits = [{ name: 'one-stream', scope: 'key', concurrentStreams: 1 }]) },
  });
  const u = new URL(g.url);
  const req = request({ host: u.hostname, port: u.port, method: 'POST', path: '/v1/messages', headers: authHeaders });
  req.on('error', () => undefined);
  req.end(msgBody({ model: 'claude-haiku-5-5', stream: true }));
  await reached;
  expect(spy.admits).toHaveLength(1);
  req.destroy();
  await closed;
  await expect.poll(() => g.traces.length).toBe(1);
  expect(spy.settles).toEqual([{ id: g.traces[0]?.id, actual: 0, result: 'settled' }]);
  expect(g.traces[0]?.outcome).toMatchObject({ aborted: true, status: 499, costMicroUsd: 0, settledBy: 'request' });
  // The only stream slot is free again.
  hang = false;
  const next = await send(g.url, { path: '/v1/messages', headers: authHeaders, body: msgBody({ model: 'claude-haiku-5-5' }) });
  expect(next.status).toBe(200);
  await new Promise((r) => setTimeout(r, 20));
  expect(rejections).toEqual([]);
});

test('request whose own reservation exceeds the limit gets 429 naming reservation and limit, nothing reserved', async () => {
  const mock = await startAnthropicMock();
  closers.push(mock.close);
  const spy = spyStore(createMemoryStore({ clock: Date.now }));
  const g = await gateway({
    upstream: mock.url,
    store: spy.store,
    policy: { edit: (p) => void (p.budgets = [{ name: 'tiny', scope: 'tenant', window: 'day', usd: 0.01, onExceed: 'block', mode: 'enforce' }]) },
  });
  const res = await send(g.url, { path: '/v1/messages', headers: authHeaders, body: msgBody({ model: 'claude-opus-5-5', max_tokens: 32_000 }) });
  expect(res.status).toBe(429);
  expect(res.headers['retry-after']).toBeUndefined();
  const err = JSON.parse(res.body.toString()).error as { type: string; message: string };
  expect(err.type).toBe('rate_limit_error');
  expect(err.message).toMatch(/reservation of \$\d+\.\d{2}/);
  expect(err.message).toContain('budget "tiny"');
  expect(err.message).toContain('$0.01');
  expect(spy.admits).toHaveLength(0); // refused before the store: nothing reserved
  expect(mock.received).toHaveLength(0);
  await expect.poll(() => g.traces.length).toBe(1);
  expect(g.traces[0]?.decision).toMatchObject({ action: 'block', reason: 'budget', reservedMicroUsd: 0 });
});

test('budget exhausted by spend: 429 without retry-after naming the budget and its reset', async () => {
  const mock = await startAnthropicMock();
  closers.push(mock.close);
  const store = createMemoryStore({ clock: Date.now });
  const g = await gateway({
    upstream: mock.url,
    store,
    policy: { edit: (p) => void (p.budgets = [{ name: 'day', scope: 'tenant', window: 'day', usd: 1, onExceed: 'block', mode: 'enforce' }]) },
  });
  expect((await send(g.url, { path: '/v1/messages', headers: authHeaders, body: msgBody({ model: 'claude-haiku-5-5' }) })).status).toBe(200);
  await expect.poll(() => g.traces.length).toBe(1);
  const key = (await store.keys()).find((k) => k.includes(':b:day:')) as string;
  await store.seed([{ key, spentMicroUsd: 1_000_000, ttlMs: 3_600_000 }]);
  const res = await send(g.url, { path: '/v1/messages', headers: authHeaders, body: msgBody({ model: 'claude-haiku-5-5' }) });
  expect(res.status).toBe(429);
  expect(res.headers['retry-after']).toBeUndefined();
  expect(JSON.parse(res.body.toString()).error.message).toMatch(/budget "day" is exhausted \(spent \$1\.00 of \$1\.00; this request.s reservation is \$\d+\.\d+\); it resets at /);
});

test('store down: budgets closed gives 503 retry-after 5; rate limits open; trace marks storeDown', async () => {
  const mock = await startAnthropicMock();
  closers.push(mock.close);
  const down: CounterStore = {
    admit: async () => {
      throw new Error('ECONNREFUSED');
    },
    settle: async () => {
      throw new Error('settle must not be called without a reservation');
    },
    sweep: async () => 0,
    snapshot: async () => ({}),
    seed: async () => undefined,
  };
  // The example policy: enforced budgets, counterStoreDown { rateLimits: open, budgets: closed }.
  const closedG = await gateway({ upstream: mock.url, store: down });
  const res = await send(closedG.url, { path: '/v1/messages', headers: authHeaders, body: msgBody({ model: 'claude-haiku-5-5' }) });
  expect(res.status).toBe(503);
  expect(res.headers['retry-after']).toBe('5');
  expect(JSON.parse(res.body.toString()).error.type).toBe('api_error');
  expect(mock.received).toHaveLength(0);
  await expect.poll(() => closedG.traces.length).toBe(1);
  expect(closedG.traces[0]?.decision).toMatchObject({ action: 'block', reason: 'store-down', storeDown: true, reservedMicroUsd: 0 });

  // Only audit budgets and rate limits: rate limits fail open, the request goes through, taint was not checked.
  const openG = await gateway({
    upstream: mock.url,
    store: down,
    policy: { edit: (p) => void (p.budgets = p.budgets.map((b) => ({ ...b, mode: 'audit' as const }))) },
  });
  const ok = await send(openG.url, { path: '/v1/messages', headers: { ...authHeaders, 'x-claude-code-session-id': 'sess-1' }, body: msgBody({ model: 'claude-haiku-5-5' }) });
  expect(ok.status).toBe(200);
  await expect.poll(() => openG.traces.length).toBe(1);
  expect(openG.traces[0]?.decision).toMatchObject({ action: 'forward', storeDown: true, taintUnchecked: true, reservedMicroUsd: 0 });
  expect(openG.traces[0]?.outcome.settledBy).toBe('request');
});

test('count_tokens is forwarded without any store call even with a session (no reservation, slot or taint)', async () => {
  const mock = await startAnthropicMock();
  closers.push(mock.close);
  const spy = spyStore(createMemoryStore({ clock: Date.now }));
  const g = await gateway({ upstream: mock.url, store: spy.store });
  const headers = { ...authHeaders, 'x-claude-code-session-id': 'sess-1' };
  const res = await send(g.url, { path: '/v1/messages/count_tokens', headers, body: msgBody({ model: 'claude-haiku-5-5' }) });
  expect(res.status).toBe(200);
  expect(spy.admits).toHaveLength(0);
  expect(spy.settles).toHaveLength(0);
  // The same request to /v1/messages does reserve.
  expect((await send(g.url, { path: '/v1/messages', headers, body: msgBody({ model: 'claude-haiku-5-5' }) })).status).toBe(200);
  expect(spy.admits).toHaveLength(1);
});

test('a reservation that cannot be priced fails closed: 500 envelope, store never called', async () => {
  const mock = await startAnthropicMock();
  closers.push(mock.close);
  const spy = spyStore(createMemoryStore({ clock: Date.now }));
  process.env[PROVIDER_KEY_ENV] = 'k';
  const base = testPolicy({ upstream: mock.url });
  const traces: Rec[] = [];
  const gw = await startGateway({ policy: { ...base, prices: { ...base.prices, models: {} } }, store: spy.store, traces: { write: (r) => (traces.push(r), true) }, traceSalt: 's' });
  closers.push(gw.close);
  const res = await send(gw.url, { path: '/v1/messages', headers: authHeaders, body: msgBody({ model: 'claude-haiku-5-5' }) });
  expect(res.status).toBe(500);
  expect(JSON.parse(res.body.toString()).error).toMatchObject({ type: 'api_error' });
  expect(spy.admits).toHaveLength(0);
  expect(mock.received).toHaveLength(0);
  await expect.poll(() => traces.length).toBe(1);
  expect(traces[0]?.outcome.errorClass).toBe('reservation_error');
});

test('cost that cannot be computed settles at the reservation estimate and marks the trace', async () => {
  // The upstream answers with a model the table does not price: the actual cost is unknown, so the estimate stands.
  const up = await raw((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' }).end(json('claude-unknown-9', { input_tokens: 10, output_tokens: 5 }));
  });
  const spy = spyStore(createMemoryStore({ clock: Date.now }));
  const g = await gateway({ upstream: up.url, store: spy.store });
  expect((await send(g.url, { path: '/v1/messages', headers: authHeaders, body: msgBody({ model: 'claude-haiku-5-5' }) })).status).toBe(200);
  await expect.poll(() => g.traces.length).toBe(1);
  const est = spy.admits[0]?.plan.reservations[0]?.estMicroUsd as number;
  expect(est).toBeGreaterThan(0);
  expect(spy.settles).toEqual([{ id: g.traces[0]?.id, actual: est, result: 'settled' }]);
  expect(g.traces[0]?.outcome).toMatchObject({ settledAtEstimate: true, costMicroUsd: est, overrun: false });
});

test('fast mode from the response usage.speed is priced at the fast rates', async () => {
  const usage = { input_tokens: 1_000, output_tokens: 500, speed: 'fast' };
  const up = await raw((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' }).end(json('claude-opus-5-5', usage));
  });
  const spy = spyStore(createMemoryStore({ clock: Date.now }));
  const g = await gateway({ upstream: up.url, store: spy.store });
  // The request itself does not ask for fast mode, so only the response tells.
  expect((await send(g.url, { path: '/v1/messages', headers: authHeaders, body: msgBody({ model: 'claude-opus-5-5' }) })).status).toBe(200);
  await expect.poll(() => spy.settles.length).toBe(1);
  const u = { input: 1_000, output: 500, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
  const fast = costMicroUsd(g.policy.prices, 'claude-opus-5-5', u, { fast: true });
  expect(fast).toBeGreaterThan(costMicroUsd(g.policy.prices, 'claude-opus-5-5', u));
  expect(spy.settles[0]?.actual).toBe(fast);
});

test('a final stream that also carried a mid-stream error is settled on its usage and traced with the error', async () => {
  const up = await raw((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(start('claude-haiku-5-5', { input_tokens: 50, output_tokens: 1 }));
    res.write(sse('error', { type: 'error', error: { type: 'overloaded_error', message: 'x' } }));
    res.write(sse('message_delta', { type: 'message_delta', delta: {}, usage: { output_tokens: 7 } }));
    res.end(sse('message_stop', { type: 'message_stop' }));
  });
  const spy = spyStore(createMemoryStore({ clock: Date.now }));
  const g = await gateway({ upstream: up.url, store: spy.store });
  await send(g.url, { path: '/v1/messages', headers: authHeaders, body: msgBody({ model: 'claude-haiku-5-5', stream: true }) });
  await expect.poll(() => g.traces.length).toBe(1);
  const cost = costMicroUsd(g.policy.prices, 'claude-haiku-5-5', { input: 50, output: 7, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 });
  expect(spy.settles[0]?.actual).toBe(cost);
  expect(g.traces[0]?.outcome).toMatchObject({ usageSource: 'final', midStreamError: 'overloaded_error', costMicroUsd: cost });
});

test('a final stream without a message_delta output count settles output at the bound, flagged on the trace (A3)', async () => {
  const up = await raw((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(start('claude-haiku-5-5', { input_tokens: 50, output_tokens: 1 }));
    res.write(sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'abcdefgh' } }));
    res.end(sse('message_stop', { type: 'message_stop' }));
  });
  const spy = spyStore(createMemoryStore({ clock: Date.now }));
  const g = await gateway({ upstream: up.url, store: spy.store });
  await send(g.url, { path: '/v1/messages', headers: authHeaders, body: msgBody({ model: 'claude-haiku-5-5', stream: true }) });
  await expect.poll(() => g.traces.length).toBe(1);
  expect(g.traces[0]?.outcome).toMatchObject({ usageSource: 'final', outputEstimated: true, usage: { output: 64 } });
  expect(spy.settles[0]?.actual).toBe(g.traces[0]?.outcome.costMicroUsd);
});

test('R11: actual input above the bytes bound is logged, counted, traced, and turns the bytes bound off until restart', async () => {
  const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const up = await raw((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' }).end(json('claude-haiku-5-5', { input_tokens: 90_000, output_tokens: 1 }));
  });
  const runtime = createGatewayRuntime();
  const spy = spyStore(createMemoryStore({ clock: Date.now }));
  const g = await gateway({ upstream: up.url, store: spy.store, runtime });
  const secret = 'do-not-log-this-prompt';
  await send(g.url, { path: '/v1/messages', headers: authHeaders, body: msgBody({ model: 'claude-haiku-5-5', messages: [{ role: 'user', content: secret }] }) });
  await expect.poll(() => g.traces.length).toBe(1);
  expect(g.traces[0]?.features.boundKind).toBe('bytes');
  expect(g.traces[0]?.outcome.boundExceeded).toBe(true);
  expect(runtime.boundViolations).toBe(1);
  expect(runtime.bytesBoundOff).toBe(true);
  const logged = err.mock.calls.map((c) => c.join(' ')).join('\n');
  expect(logged).toContain('bytes bound');
  expect(logged).not.toContain(secret);
  // Every later request is decided with the context-window bound.
  await send(g.url, { path: '/v1/messages', headers: authHeaders, body: msgBody({ model: 'claude-haiku-5-5' }) });
  await expect.poll(() => g.traces.length).toBe(2);
  expect(g.traces[1]?.features).toMatchObject({ boundKind: 'context-window', inputTokensBound: 1_000_000 });
  expect(spy.admits[1]?.plan.reservations[0]?.estMicroUsd).toBeGreaterThan(spy.admits[0]?.plan.reservations[0]?.estMicroUsd as number);
});

test('subscription keys: budgets without onExceed warn (not enforced); a stated block is enforced', async () => {
  const mock = await startAnthropicMock();
  closers.push(mock.close);
  const spy = spyStore(createMemoryStore({ clock: Date.now }));
  const g = await gateway({
    upstream: mock.url,
    store: spy.store,
    policy: {
      billing: 'subscription',
      edit: (p) => {
        p.budgets = [
          { name: 'unstated', scope: 'tenant', window: 'day', usd: 0.01, mode: 'enforce' },
          { name: 'stated', scope: 'key', window: 'day', usd: 100, onExceed: 'block', mode: 'enforce' },
        ];
      },
    },
  });
  // The provider credential is passed through in subscription mode; the mock does not care.
  const res = await send(g.url, { path: '/v1/messages', headers: authHeaders, body: msgBody({ model: 'claude-opus-5-5', max_tokens: 32_000 }) });
  expect(res.status).toBe(200);
  expect(spy.admits[0]?.plan.reservations.map((r) => [r.budget, r.enforce])).toEqual([
    ['unstated', false],
    ['stated', true],
  ]);
  expect(spy.admits[0]?.admission.audit).toEqual([{ name: 'unstated', wouldFail: true }]);
});

test('the sweeper settles an overdue request: its slot frees and its trace says settledBy sweeper', async () => {
  let release: () => void = () => undefined;
  const held = new Promise<void>((r) => (release = r));
  let first = true;
  const up = await raw((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    if (!first) return void res.end(json('claude-haiku-5-5', { input_tokens: 5, output_tokens: 1 }));
    first = false;
    void held.then(() => res.end(json('claude-haiku-5-5', { input_tokens: 5, output_tokens: 1 })));
  });
  const runtime = createGatewayRuntime();
  const store = createMemoryStore({ clock: Date.now, onSwept: runtime.onSwept });
  const g = await gateway({
    upstream: up.url,
    store,
    runtime,
    policy: { edit: (p) => void (p.rateLimits = [{ name: 'one', scope: 'key', concurrentStreams: 1 }]) },
  });
  const slow = send(g.url, { path: '/v1/messages', headers: authHeaders, body: msgBody({ model: 'claude-haiku-5-5' }) });
  await expect.poll(() => store.keys().some((k) => k.includes(':res:'))).toBe(true);
  expect((await send(g.url, { path: '/v1/messages', headers: authHeaders, body: msgBody({ model: 'claude-haiku-5-5' }) })).status).toBe(429);
  expect(await store.sweep(Date.now() + 3_600_000)).toBe(1);
  expect((await send(g.url, { path: '/v1/messages', headers: authHeaders, body: msgBody({ model: 'claude-haiku-5-5' }) })).status).toBe(200);
  release();
  expect((await slow).status).toBe(200);
  await expect.poll(() => g.traces.length).toBe(3);
  const slowTrace = g.traces.find((t) => t.id === 'req_000001');
  expect(slowTrace?.outcome.settledBy).toBe('sweeper');
  // The store charged the estimate (the sweeper's settle), whatever the request computed later: warm-up seeds that.
  expect(slowTrace?.outcome.chargedMicroUsd).toBe(slowTrace?.decision.reservedMicroUsd);
  expect(slowTrace?.outcome.chargedMicroUsd).not.toBe(slowTrace?.outcome.costMicroUsd);
  expect(g.traces.filter((t) => t.outcome.settledBy === 'sweeper')).toHaveLength(1);
});

// Fix round 1, item 1: a non-streamed 2xx whose usage cannot be read was billed; it settles at the estimate.
async function jsonCase(handler: Parameters<typeof startRawUpstream>[0], client: (url: string) => Promise<unknown>) {
  const up = await raw(handler);
  const spy = spyStore(createMemoryStore({ clock: Date.now }));
  const g = await gateway({ upstream: up.url, store: spy.store });
  await client(g.url);
  await expect.poll(() => g.traces.length).toBe(1);
  const est = spy.admits[0]?.plan.reservations[0]?.estMicroUsd as number;
  expect(est).toBeGreaterThan(0);
  expect(spy.settles).toEqual([{ id: g.traces[0]?.id, actual: est, result: 'settled' }]);
  expect(g.traces[0]?.outcome).toMatchObject({ settledAtEstimate: true, costMicroUsd: est, chargedMicroUsd: est });
}
const FULL = json('claude-haiku-5-5', { input_tokens: 500, output_tokens: 900 }).replace('"content":[]', `"content":[{"type":"text","text":"${'x'.repeat(2000)}"}]`);

test('a 200 JSON answer cut off mid-body by the upstream settles at the estimate, not 0', async () => {
  await jsonCase(
    (req, res) => {
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(FULL.length) });
      res.write(FULL.slice(0, 100));
      setTimeout(() => res.socket?.destroy(), 50);
    },
    (url) => sendTolerant(url, '/v1/messages', authHeaders, msgBody({ model: 'claude-haiku-5-5' })),
  );
});

test('a client abort in the middle of a 200 JSON body settles at the estimate, not 0', async () => {
  await jsonCase(
    (req, res) => {
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(FULL.length) });
      res.write(FULL.slice(0, 100)); // the rest never comes
    },
    (url) =>
      new Promise<void>((done) => {
        const u = new URL(url);
        const req = request({ host: u.hostname, port: u.port, method: 'POST', path: '/v1/messages', headers: authHeaders }, (res) => {
          res.once('data', () => {
            req.destroy();
            done();
          });
        });
        req.on('error', () => undefined);
        req.end(msgBody({ model: 'claude-haiku-5-5' }));
      }),
  );
});

test('a 200 JSON answer without usage settles at the estimate, not 0', async () => {
  await jsonCase(
    (req, res) => {
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'm', type: 'message', model: 'claude-haiku-5-5', content: [] }));
    },
    (url) => send(url, { path: '/v1/messages', headers: authHeaders, body: msgBody({ model: 'claude-haiku-5-5' }) }),
  );
});

// Item 2: a throw anywhere after admit still releases the reservation and the stream slot.
test('a fault after admit still settles (at the estimate) and frees the stream slot', async () => {
  let n = 0;
  // Every gateway clock read after the upstream got the request throws, until the request has failed out of handle().
  let faults = 0;
  const up = await raw((req, res) => {
    req.resume();
    if (n === 1) faults = 2;
    res.writeHead(200, { 'content-type': 'application/json' }).end(json('claude-haiku-5-5', { input_tokens: 5, output_tokens: 1 }));
  });
  const spy = spyStore(createMemoryStore({ clock: Date.now }));
  process.env[PROVIDER_KEY_ENV] = 'k';
  const policy = testPolicy({ upstream: up.url, edit: (p) => void (p.rateLimits = [{ name: 'one', scope: 'key', concurrentStreams: 1 }]) });
  const gw = createGateway({
    policy: () => policy,
    store: spy.store,
    traces: null,
    clock: () => {
      if (faults > 0) {
        faults--;
        throw new Error('injected fault');
      }
      return Date.now();
    },
    newId: () => `req_${++n}`,
    basePath: null,
    bodyCapBytes: 1 << 20,
  });
  const url = await gw.listen(0);
  closers.push(gw.close);
  await sendTolerant(url, '/v1/messages', authHeaders, msgBody({ model: 'claude-haiku-5-5' }));
  await expect.poll(() => spy.settles.length).toBe(1);
  expect(spy.settles[0]).toEqual({ id: 'req_1', actual: spy.admits[0]?.plan.reservations[0]?.estMicroUsd, result: 'settled' });
  // A fresh connection: the faulted request's socket was destroyed.
  const fresh = new Agent({ keepAlive: false });
  expect((await send(url, { path: '/v1/messages', headers: authHeaders, body: msgBody({ model: 'claude-haiku-5-5' }), agent: fresh })).status).toBe(200);
});

// Item 3: an unanswering store must not hang requests: admit is raced against a short deadline.
test('a store that never answers is treated as down within the admit deadline (503 retry-after 5), and a late admission is released', async () => {
  const mock = await startAnthropicMock();
  closers.push(mock.close);
  const inner = createMemoryStore({ clock: Date.now });
  let late: () => void = () => undefined;
  const lateAdmit = new Promise<void>((r) => (late = r));
  const settled: string[] = [];
  const slow: CounterStore = {
    admit: async (plan) => {
      await lateAdmit;
      return inner.admit(plan);
    },
    settle: async (id, x) => (settled.push(id), inner.settle(id, x)),
    sweep: (n) => inner.sweep(n),
    snapshot: (k) => inner.snapshot(k),
    seed: (e) => inner.seed(e),
  };
  process.env[PROVIDER_KEY_ENV] = 'k';
  const traces: Rec[] = [];
  const gw = await startGateway({ policy: testPolicy({ upstream: mock.url }), store: slow, traces: { write: (r) => (traces.push(r), true) }, traceSalt: 's', admitTimeoutMs: 200 });
  closers.push(gw.close);
  const t0 = Date.now();
  const res = await send(gw.url, { path: '/v1/messages', headers: authHeaders, body: msgBody({ model: 'claude-haiku-5-5' }) });
  expect(Date.now() - t0).toBeLessThan(1_500);
  expect(res.status).toBe(503);
  expect(res.headers['retry-after']).toBe('5');
  expect(mock.received).toHaveLength(0);
  await expect.poll(() => traces.length).toBe(1);
  expect(traces[0]?.decision.storeDown).toBe(true);
  late();
  await expect.poll(() => settled).toEqual(['req_000001']);
  expect(inner.keys().some((k) => k.includes(':res:'))).toBe(false);
});

// Item 4: every modifier the request selects is in the actual cost.
test('inference_geo "us" in the body settles at the inferenceGeoUs rate (1.1x)', async () => {
  const up = await raw((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' }).end(json('claude-haiku-5-5', { input_tokens: 10_000, output_tokens: 2_000 }));
  });
  const spy = spyStore(createMemoryStore({ clock: Date.now }));
  const g = await gateway({ upstream: up.url, store: spy.store });
  await send(g.url, { path: '/v1/messages', headers: authHeaders, body: msgBody({ model: 'claude-haiku-5-5', inference_geo: 'us' }) });
  await send(g.url, { path: '/v1/messages', headers: authHeaders, body: msgBody({ model: 'claude-haiku-5-5', inference_geo: 'global' }) });
  await expect.poll(() => spy.settles.length).toBe(2);
  const u = { input: 10_000, output: 2_000, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
  expect(spy.settles[0]?.actual).toBe(costMicroUsd(g.policy.prices, 'claude-haiku-5-5', u, { modifiers: ['inferenceGeoUs'] }));
  expect(spy.settles[1]?.actual).toBe(costMicroUsd(g.policy.prices, 'claude-haiku-5-5', u));
  expect(spy.settles[0]?.actual).toBeGreaterThan(spy.settles[1]?.actual as number);
});

// Task 15 carried item: inference_geo is matched without regard to case ("US" is the us modifier).
test('inference_geo "US" (any case) settles at the inferenceGeoUs rate', async () => {
  const up = await raw((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' }).end(json('claude-haiku-5-5', { input_tokens: 10_000, output_tokens: 2_000 }));
  });
  const spy = spyStore(createMemoryStore({ clock: Date.now }));
  const g = await gateway({ upstream: up.url, store: spy.store });
  await send(g.url, { path: '/v1/messages', headers: authHeaders, body: msgBody({ model: 'claude-haiku-5-5', inference_geo: 'US' }) });
  await send(g.url, { path: '/v1/messages', headers: authHeaders, body: msgBody({ model: 'claude-haiku-5-5', inference_geo: 'Us' }) });
  await expect.poll(() => spy.settles.length).toBe(2);
  const u = { input: 10_000, output: 2_000, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
  const geo = costMicroUsd(g.policy.prices, 'claude-haiku-5-5', u, { modifiers: ['inferenceGeoUs'] });
  expect(spy.settles.map((s) => s.actual)).toEqual([geo, geo]);
});

// Task 15 carried item: the fault path writes a trace line charged at the estimate, so warm-up sees that charge.
test('a fault after admit queues a trace line with chargedMicroUsd equal to the estimate', async () => {
  let n = 0;
  let faults = 0;
  const up = await raw((req, res) => {
    req.resume();
    if (n === 1) faults = 2;
    res.writeHead(200, { 'content-type': 'application/json' }).end(json('claude-haiku-5-5', { input_tokens: 5, output_tokens: 1 }));
  });
  const spy = spyStore(createMemoryStore({ clock: Date.now }));
  process.env[PROVIDER_KEY_ENV] = 'k';
  const traces: Rec[] = [];
  const policy = testPolicy({ upstream: up.url });
  const gw = createGateway({
    policy: () => policy,
    store: spy.store,
    traces: { write: (r) => (traces.push(r), true) },
    traceSalt: 's',
    clock: () => {
      if (faults > 0) {
        faults--;
        throw new Error('injected fault');
      }
      return Date.now();
    },
    newId: () => `req_${++n}`,
    basePath: null,
    bodyCapBytes: 1 << 20,
  });
  const url = await gw.listen(0);
  closers.push(gw.close);
  await sendTolerant(url, '/v1/messages', authHeaders, msgBody({ model: 'claude-haiku-5-5' }));
  await expect.poll(() => traces.length).toBe(1);
  const est = spy.admits[0]?.plan.reservations[0]?.estMicroUsd;
  expect(est).toBeGreaterThan(0);
  const t = traces[0] as Rec;
  expect(t.id).toBe('req_1');
  expect(t.tenant).toBe('acme');
  expect(t.outcome).toMatchObject({ chargedMicroUsd: est, costMicroUsd: est, settledAtEstimate: true, errorClass: 'internal_error' });
  expect(t.decision.reservedMicroUsd).toBe(est);
  expect(spy.settles).toEqual([{ id: 'req_1', actual: est, result: 'settled' }]);
});
