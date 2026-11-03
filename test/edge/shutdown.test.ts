// FR-I1 (final review): graceful shutdown. On shutdown(graceMs) the gateway stops accepting connections, /readyz answers
// 503 (draining), requests and streams in flight finish within the grace period and settle at their actual cost, idle
// keep-alive connections close at once, and what is still running when the grace ends is cut and settles as a cut
// stream does (at the reservation). close() during a drain cuts at once.
import { Agent, request } from 'node:http';
import { afterEach, expect, test } from 'vitest';
import type { RequestOutcome } from '../../src/edge/handler.js';
import { createMemoryStore } from '../../src/limits/memory-store.js';
import { costMicroUsd } from '../../src/pricing/cost.js';
import { authHeaders, msgBody, send, startRawUpstream } from '../helpers/conformance.js';
import { startGateway, type TestGateway } from '../helpers/gateway.js';
import { PROVIDER_KEY_ENV, testPolicy } from '../helpers/policy.js';

const MODEL = 'claude-haiku-5-5';
const sse = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c().catch(() => undefined);
  delete process.env[PROVIDER_KEY_ENV];
});

/** An upstream that starts a stream, then finishes it (final usage, message_stop) only when `release()` is called. */
async function heldStream() {
  let release: () => void = () => undefined;
  const released = new Promise<void>((r) => (release = r));
  const up = await startRawUpstream(async (req, res) => {
    for await (const _ of req);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(sse('message_start', { type: 'message_start', message: { model: MODEL, usage: { input_tokens: 40, output_tokens: 1 } } }));
    res.write(sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
    res.write(sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } }));
    res.write(': marker-sent\n\n');
    await released;
    if (res.destroyed) return;
    res.write(sse('content_block_stop', { type: 'content_block_stop', index: 0 }));
    res.write(sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 40, output_tokens: 7 } }));
    res.end(sse('message_stop', { type: 'message_stop' }));
  });
  closers.push(up.close);
  return { url: up.url, release };
}

async function gateway(upstream: string): Promise<{ g: TestGateway; outcomes: RequestOutcome[]; policy: ReturnType<typeof testPolicy> }> {
  process.env[PROVIDER_KEY_ENV] = 'k';
  const policy = testPolicy({ upstream });
  const outcomes: RequestOutcome[] = [];
  const g = await startGateway({ policy, store: createMemoryStore({ clock: Date.now }), onSettled: (o) => outcomes.push(o), opsListener: true });
  closers.push(g.close);
  return { g, outcomes, policy };
}

/** Starts a streamed request; `marker` resolves once the stream is running, `done` with the whole body (or what came). */
function startStream(url: string, agent?: Agent): { marker: Promise<void>; done: Promise<string> } {
  let onMarker: () => void = () => undefined;
  const marker = new Promise<void>((r) => (onMarker = r));
  const done = new Promise<string>((resolve) => {
    const u = new URL(url);
    let text = '';
    const req = request({ host: u.hostname, port: u.port, method: 'POST', path: '/v1/messages', headers: authHeaders, ...(agent ? { agent } : {}) }, (res) => {
      res.on('data', (c: Buffer) => {
        text += c.toString();
        if (text.includes('marker-sent')) onMarker();
      });
      res.on('end', () => resolve(text));
      res.on('error', () => resolve(text));
      res.on('aborted', () => resolve(text));
    });
    req.on('error', () => resolve(text));
    req.end(msgBody({ model: MODEL, stream: true, max_tokens: 1_000 }));
  });
  return { marker, done };
}

const readyz = async (opsUrl: string): Promise<{ status: number; reason: string }> => {
  const r = await fetch(`${opsUrl}/readyz`);
  return { status: r.status, reason: ((await r.json()) as { reason: string }).reason };
};

test('FR-I1 a stream in flight at shutdown completes and settles at its actual cost; readyz 503 and no new connections while draining', async () => {
  const up = await heldStream();
  const { g, outcomes, policy } = await gateway(up.url);
  expect((await readyz(g.opsUrl!)).status).toBe(200);
  const agent = new Agent({ keepAlive: true });
  const s = startStream(g.url, agent);
  await s.marker;
  const drained = g.shutdown(10_000);
  let drainedAt = 0;
  void drained.then(() => (drainedAt = Date.now()));
  expect(await readyz(g.opsUrl!)).toEqual({ status: 503, reason: 'draining' });
  await expect(fetch(`${g.url}/v1/models`, { headers: authHeaders })).rejects.toThrow();
  const releasedAt = Date.now();
  up.release();
  const body = await s.done;
  expect(body).toContain('message_stop');
  await drained;
  // The finished stream's keep-alive socket is closed at once, not after the keep-alive timeout (5 s).
  expect(drainedAt - releasedAt).toBeLessThan(2_000);
  expect(outcomes).toHaveLength(1);
  const o = outcomes[0]!;
  expect(o.settledAtEstimate).toBeUndefined();
  expect(o.costMicroUsd).toBe(costMicroUsd(policy.prices, MODEL, { input: 40, output: 7, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }));
  expect(o.costMicroUsd ?? 0).toBeLessThan(o.reservedMicroUsd ?? 0);
  agent.destroy();
});

test('FR-I1 a stream still running when the grace period ends is cut and settles at its reservation', async () => {
  const up = await heldStream();
  const { g, outcomes } = await gateway(up.url);
  const s = startStream(g.url);
  await s.marker;
  const t0 = Date.now();
  await g.shutdown(300);
  expect(Date.now() - t0).toBeGreaterThanOrEqual(290);
  expect(Date.now() - t0).toBeLessThan(3_000);
  expect(await s.done).not.toContain('message_stop');
  expect(outcomes).toHaveLength(1);
  expect(outcomes[0]!.settledAtEstimate).toBe(true);
  expect(outcomes[0]!.costMicroUsd).toBe(outcomes[0]!.reservedMicroUsd);
  up.release();
});

test('FR-I1 an idle keep-alive connection does not hold the drain', async () => {
  const up = await heldStream();
  const { g } = await gateway(up.url);
  const agent = new Agent({ keepAlive: true });
  expect((await send(g.url, { method: 'GET', path: '/v1/models', headers: authHeaders, agent })).status).toBe(200);
  const t0 = Date.now();
  await g.shutdown(10_000);
  expect(Date.now() - t0).toBeLessThan(1_000);
  agent.destroy();
});

test('FR-I1 close() during a drain cuts what is in flight at once; shutdown(0) is the immediate close', async () => {
  const up = await heldStream();
  const { g, outcomes } = await gateway(up.url);
  const s = startStream(g.url);
  await s.marker;
  const drained = g.shutdown(30_000);
  const t0 = Date.now();
  await g.close();
  await drained;
  expect(Date.now() - t0).toBeLessThan(2_000);
  expect(await s.done).not.toContain('message_stop');
  expect(outcomes[0]?.settledAtEstimate).toBe(true);

  const up2 = await heldStream();
  const second = await gateway(up2.url);
  const s2 = startStream(second.g.url);
  await s2.marker;
  const t1 = Date.now();
  await second.g.shutdown(0);
  expect(Date.now() - t1).toBeLessThan(2_000);
  expect(second.outcomes[0]?.settledAtEstimate).toBe(true);
  up.release();
  up2.release();
});
