// A8 (security review A): the sweeper settles a reservation older than 20 minutes and frees its stream slot, but
// nothing ended a request at 20 minutes (undici's timeouts are per idle gap), so a stream that kept sending outlived
// its reservation and the concurrent stream cap was exceeded. Every request now has a total deadline below the
// reservation deadline: when it fires the upstream is aborted and the request settles at its reservation.
import { afterEach, expect, test, vi } from 'vitest';
import { DEFAULT_REQUEST_DEADLINE_MS } from '../../src/edge/handler.js';
import { createMemoryStore } from '../../src/limits/memory-store.js';
import { RESERVATION_DEADLINE_MS } from '../../src/limits/open-store.js';
import { authHeaders, send } from '../helpers/conformance.js';
import { testPolicy } from '../helpers/policy.js';
import { closeAll, gw, raw, readJson, sendAndAbort, sse } from './common.js';

afterEach(async () => {
  vi.useRealTimers();
  await closeAll();
});

const MODEL = 'claude-haiku-5-5';

test('A8 the request deadline is below the reservation deadline the sweeper uses', () => {
  expect(DEFAULT_REQUEST_DEADLINE_MS).toBeLessThan(RESERVATION_DEADLINE_MS);
  expect(DEFAULT_REQUEST_DEADLINE_MS).toBeGreaterThanOrEqual(10 * 60_000); // Claude Code's own request timeout fits
});

test('A8 fake clock: a stream that keeps sending holds its slot until the deadline, which ends it before the sweeper could', async () => {
  let calls = 0;
  let upstreamClosed = false;
  const up = await raw(async (req, res) => {
    const { raw: b } = await readJson(req);
    calls++;
    if (!(JSON.parse(b.toString()) as { stream?: boolean }).stream) {
      return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'm', type: 'message', model: MODEL, content: [], usage: { input_tokens: 5, output_tokens: 5 } }));
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(sse('message_start', { type: 'message_start', message: { model: MODEL, usage: { input_tokens: 5, output_tokens: 1 } } }));
    res.write(sse('ping', { type: 'ping' }));
    res.on('close', () => void (upstreamClosed = true));
  });
  const clock = (): number => Date.now();
  const store = createMemoryStore({ clock, deadlineMs: RESERVATION_DEADLINE_MS });
  const policy = testPolicy({ upstream: up.url, edit: (p) => void (p.rateLimits = [{ name: 'one-stream', scope: 'key', concurrentStreams: 1 }]) });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const g = await gw(policy, store, { clock });
  const body = Buffer.from(JSON.stringify({ model: MODEL, max_tokens: 128_000, stream: true, messages: [{ role: 'user', content: 'long' }] }));
  const small = Buffer.from(JSON.stringify({ model: MODEL, max_tokens: 16, messages: [{ role: 'user', content: 'x' }] }));
  // Stream 1 stays open from the client side for the whole test (the gateway ends it).
  void sendAndAbort(g.url, '/v1/messages', authHeaders, body, { until: () => false });
  await vi.waitFor(() => expect(calls).toBe(1), { timeout: 5000 });

  // 18 minutes in: still live, nothing to sweep, the cap holds.
  vi.setSystemTime(Date.now() + 18 * 60_000);
  expect(await store.sweep(Date.now())).toBe(0);
  expect((await send(g.url, { path: '/v1/messages', headers: authHeaders, body: small })).status).toBe(429);

  // The request deadline fires before the reservation deadline: upstream aborted, settled at the reservation.
  await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_DEADLINE_MS);
  await vi.waitFor(() => expect(g.outcomes.length).toBe(2), { timeout: 5000 });
  const o = g.outcomes.find((x) => x.status === 200)!;
  expect(o.errorClass).toBe('request_deadline');
  expect(o.settledAtEstimate).toBe(true);
  expect(o.costMicroUsd).toBe(o.reservedMicroUsd);
  expect(o.settledBy).toBe('request');

  // Past 20 minutes the sweeper finds nothing: no live stream ever lost its slot to it.
  vi.setSystemTime(Date.now() + 3 * 60_000);
  expect(await store.sweep(Date.now())).toBe(0);
  vi.useRealTimers();
  await vi.waitFor(() => expect(upstreamClosed).toBe(true), { timeout: 5000 });
});
