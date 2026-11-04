import { request, type ServerResponse } from 'node:http';
import { afterEach, expect, test } from 'vitest';
import { createGatewayRuntime } from '../../../src/edge/handler.js';
import type { TraceRecord } from '../../../src/ledger/record.js';
import { createMemoryStore } from '../../../src/limits/memory-store.js';
import { authHeaders, msgBody, send, startRawUpstream } from '../../helpers/conformance.js';
import { startGateway } from '../../helpers/gateway.js';
import { PROVIDER_KEY_ENV, testPolicy } from '../../helpers/policy.js';
import { spyStore } from '../../helpers/store-spy.js';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  delete process.env[PROVIDER_KEY_ENV];
});

const frame = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const START = frame('message_start', { type: 'message_start', message: { model: 'claude-haiku-5-5', usage: { input_tokens: 10, output_tokens: 1 } } });
const END = frame('message_delta', { type: 'message_delta', delta: {}, usage: { output_tokens: 3 } }) + frame('message_stop', { type: 'message_stop' });

test('C18 per-key stream cap: third concurrent stream gets 429 retry-after 1; slot frees on end, abort and sweep [https://code.claude.com/docs/en/llm-gateway-protocol.md]', async () => {
  // Every stream stays open after message_start until the test ends it.
  const open: ServerResponse[] = [];
  const up = await startRawUpstream((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(START);
    open.push(res);
  });
  closers.push(up.close);
  process.env[PROVIDER_KEY_ENV] = 'k';
  const runtime = createGatewayRuntime();
  const memory = createMemoryStore({ clock: Date.now, onSwept: runtime.onSwept });
  const spy = spyStore(memory);
  const traces: Array<Omit<TraceRecord, 'instance' | 'seq'>> = [];
  const policy = testPolicy({ upstream: up.url, edit: (p) => void (p.rateLimits = [{ name: 'dev-streams', scope: 'key', concurrentStreams: 2 }]) });
  const gw = await startGateway({ policy, store: spy.store, runtime, traces: { write: (r) => (traces.push(r), true) }, traceSalt: 's' });
  closers.push(gw.close);
  const u = new URL(gw.url);
  const body = msgBody({ model: 'claude-haiku-5-5', stream: true });

  /** Starts a stream and resolves once its message_start arrived; `abort` drops the client side. */
  const stream = (): Promise<{ abort(): void; done: Promise<void> }> =>
    new Promise((resolve, reject) => {
      let finish: () => void = () => undefined;
      const done = new Promise<void>((r) => (finish = r));
      const req = request({ host: u.hostname, port: u.port, method: 'POST', path: '/v1/messages?beta=true', headers: authHeaders }, (res) => {
        if (res.statusCode !== 200) return reject(new Error(`status ${res.statusCode}`));
        res.once('data', () => resolve({ abort: () => req.destroy(), done }));
        res.on('end', finish);
        res.on('close', finish);
      });
      req.on('error', () => undefined);
      req.end(body);
    });
  const third = () => send(gw.url, { path: '/v1/messages?beta=true', headers: authHeaders, body });

  const a = await stream();
  const b = await stream();
  const refused = await third();
  expect(refused.status).toBe(429);
  expect(refused.headers['retry-after']).toBe('1');
  expect(JSON.parse(refused.body.toString()).error.type).toBe('rate_limit_error');
  expect(open).toHaveLength(2);

  // End: the first stream finishes normally and its slot is released with the settle.
  open[0]?.end(END);
  await a.done;
  await expect.poll(() => spy.settles.length).toBe(1);
  const c = await stream();
  expect((await third()).status).toBe(429);

  // Abort: the client drops the second stream.
  b.abort();
  await expect.poll(() => spy.settles.length).toBe(2);
  expect(spy.settles[1]?.actual).toBeGreaterThan(0); // partial usage, never zero
  const d = await stream();
  expect((await third()).status).toBe(429);

  // Sweep: both open reservations pass their deadline; the sweeper frees the slots while the streams still run.
  expect(await memory.sweep(Date.now() + 3_600_000)).toBe(2);
  const e = await stream();
  // The swept requests settle late: the store no longer knows them, the trace says the sweeper settled them.
  for (const r of [open[2], open[3]]) r?.end(END);
  await Promise.all([c.done, d.done]);
  await expect.poll(() => traces.filter((t) => t.outcome.settledBy === 'sweeper').length).toBe(2);
  e.abort();
  await expect.poll(() => spy.settles.length).toBe(5);
  expect(spy.settles.filter((s) => s.result === 'unknown')).toHaveLength(2);
});
