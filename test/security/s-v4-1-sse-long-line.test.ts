// S-V4-1 (V4 SSE fuzz, Medium, availability): the SSE parser that reads every upstream stream for usage concatenated
// the unfinished line with each new chunk and rescanned it from its start, so a long line in small chunks held the
// event loop for quadratic time (1 MiB in 64-byte chunks 20 s, 2 MiB 76 s), and a line or an event's data had no
// bound. A Responses `response.completed` event carries the whole response on one data line, so a long legitimate
// answer delivered in small TCP segments was enough. Each byte is now scanned once, and a line or an event's data past
// MAX_SSE_LINE_BYTES (16 MiB) is dropped with its event (its usage is then missing: the request settles at the
// reservation).
import { afterEach, expect, test } from 'vitest';
import type { TraceRecord } from '../../src/ledger/record.js';
import { createMemoryStore } from '../../src/limits/memory-store.js';
import { MAX_SSE_LINE_BYTES, SseParser, type SseEvent } from '../../src/stream/sse.js';
import { createMetrics } from '../../src/telemetry/metrics.js';
import { authHeaders, send, startRawUpstream } from '../helpers/conformance.js';
import { startGateway } from '../helpers/gateway.js';
import { PROVIDER_KEY_ENV, testPolicy } from '../helpers/policy.js';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  delete process.env[PROVIDER_KEY_ENV];
});

function parseChunks(chunks: readonly Buffer[], p = new SseParser()): SseEvent[] {
  const out: SseEvent[] = [];
  for (const c of chunks) out.push(...p.push(c));
  out.push(...p.end());
  return out;
}

/** Fastest of three runs of one long line of `bytes` in 64-byte chunks, in ms; checks the event it yields. */
function longLineMs(bytes: number): number {
  let best = Number.POSITIVE_INFINITY;
  for (let run = 0; run < 3; run++) {
    const p = new SseParser();
    const chunk = Buffer.alloc(64, 0x61);
    const started = performance.now();
    let early = p.push(Buffer.from('event: response.completed\ndata: ')).length;
    for (let i = 0; i < bytes / 64; i++) early += p.push(chunk).length;
    const events = p.push(Buffer.from('\n\n'));
    best = Math.min(best, performance.now() - started);
    expect(early).toBe(0);
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe('response.completed');
    expect(events[0]?.data.length).toBe(bytes);
  }
  return best;
}

// Timing bounds that hold on a slow CI runner (V4 review M6): the time for 8 times the bytes is compared with the
// small run's (linear: about 8 times; the old quadratic parser: about 64 times), and the absolute bound is far above
// a linear run (milliseconds) and far below the old parser (76 s for 2 MiB).
test('S-V4-1 a long line delivered in small chunks parses in linear time (was quadratic: 1 MiB in 64-byte chunks took 20 s)', () => {
  const small = longLineMs(256 * 1024);
  const large = longLineMs(2 * 1024 * 1024);
  expect(large).toBeLessThan(10_000);
  expect(large / Math.max(small, 1)).toBeLessThan(32);
});

test('S-V4-1 a line longer than the cap is dropped with its event, holds no more than the cap, and later events parse', () => {
  expect(MAX_SSE_LINE_BYTES).toBeGreaterThanOrEqual(8 * 1024 * 1024);
  const p = new SseParser({ maxLineBytes: 1024 });
  const out: SseEvent[] = [];
  out.push(...p.push(Buffer.from('event: a\ndata: ok\n\nevent: big\ndata: first\ndata: ')));
  for (let i = 0; i < 100; i++) out.push(...p.push(Buffer.alloc(100, 0x62)));
  expect(p.pendingBytes()).toBeLessThanOrEqual(1024);
  out.push(...p.push(Buffer.from('\ndata: tail\n\nevent: c\ndata: after\n\n')));
  out.push(...p.end());
  expect(out).toEqual([
    { event: 'a', data: 'ok' },
    { event: 'c', data: 'after' },
  ]);
  // A line exactly at the cap is kept.
  const q = new SseParser({ maxLineBytes: 16 });
  expect(parseChunks([Buffer.from('data: 0123456789\n\n')], q)).toEqual([{ event: null, data: '0123456789' }]);
});

test('S-V4-1 an event made of many data lines is held to the same cap and dropped past it', () => {
  const p = new SseParser({ maxLineBytes: 1024 });
  const out: SseEvent[] = [];
  out.push(...p.push(Buffer.from('event: many\n')));
  for (let i = 0; i < 500; i++) out.push(...p.push(Buffer.from('data: abcdefgh\n')));
  out.push(...p.push(Buffer.from('\nevent: next\ndata: fine\n\n')));
  expect(out).toEqual([{ event: 'next', data: 'fine' }]);
});

// V4 review (R-V4-3): the cap counts UTF-8 bytes, as its name says, not UTF-16 units: an event of many data lines of
// three-byte characters held up to three times the cap.
test('S-V4-1 the event data cap counts bytes: multi-byte characters reach it three times sooner than ASCII', () => {
  const p = new SseParser({ maxLineBytes: 1024 });
  const out: SseEvent[] = [];
  out.push(...p.push(Buffer.from('event: euro\n')));
  // 8 lines of 60 euro signs: 480 characters, 1,440 bytes of data.
  for (let i = 0; i < 8; i++) out.push(...p.push(Buffer.from(`data: ${'€'.repeat(60)}\n`)));
  out.push(...p.push(Buffer.from('\nevent: next\ndata: fine\n\n')));
  expect(out).toEqual([{ event: 'next', data: 'fine' }]);
  expect(p.droppedEvents).toBe(1);
  // The same character count in ASCII stays under the cap and is kept.
  const q = new SseParser({ maxLineBytes: 1024 });
  const kept = parseChunks([Buffer.from(`event: ascii\n${`data: ${'e'.repeat(60)}\n`.repeat(8)}\n`)], q);
  expect(kept).toHaveLength(1);
  expect(q.droppedEvents).toBe(0);
});

test('S-V4-1 a stream that lost an event to the cap is marked in its trace (errorClass) and counted on /metrics', async () => {
  process.env[PROVIDER_KEY_ENV] = 'k';
  const big = 'x'.repeat(MAX_SSE_LINE_BYTES + 1);
  const up = await startRawUpstream((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const ev = (e: string, d: string): string => `event: ${e}\ndata: ${d}\n\n`;
      res.write(ev('message_start', JSON.stringify({ type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [], usage: { input_tokens: 10, output_tokens: 1 } } })));
      res.write(ev('ping', big));
      res.end(ev('message_delta', JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } })) + ev('message_stop', '{"type":"message_stop"}'));
    });
  });
  closers.push(up.close);
  const metrics = createMetrics();
  const traces: TraceRecord[] = [];
  const gw = await startGateway({ policy: testPolicy({ upstream: up.url }), store: createMemoryStore({ clock: Date.now }), traces: { write: (r) => (traces.push(r as TraceRecord), true) }, traceSalt: 's', metrics });
  closers.push(gw.close);
  const body = JSON.stringify({ model: 'claude-haiku-5-5', max_tokens: 8, stream: true, messages: [{ role: 'user', content: 'hi' }] });
  const res = await send(gw.url, { path: '/v1/messages', headers: authHeaders, body });
  expect(res.status).toBe(200);
  expect(res.body.length).toBeGreaterThan(MAX_SSE_LINE_BYTES); // forwarded unchanged
  await expect.poll(() => traces.length).toBe(1);
  expect(traces[0]?.outcome.errorClass).toBe('sse_event_too_large');
  expect(metrics.render()).toMatch(/^tokenyard_sse_events_dropped_total 1$/m);
}, 30_000);
