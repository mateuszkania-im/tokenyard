// S-V4-1 (V4 SSE fuzz, Medium, availability): the SSE parser that reads every upstream stream for usage concatenated
// the unfinished line with each new chunk and rescanned it from its start, so a long line in small chunks held the
// event loop for quadratic time (1 MiB in 64-byte chunks 20 s, 2 MiB 76 s), and a line or an event's data had no
// bound. A Responses `response.completed` event carries the whole response on one data line, so a long legitimate
// answer delivered in small TCP segments was enough. Each byte is now scanned once, and a line or an event's data past
// MAX_SSE_LINE_BYTES (16 MiB) is dropped with its event (its usage is then missing: the request settles at the
// reservation).
import { expect, test } from 'vitest';
import { MAX_SSE_LINE_BYTES, SseParser, type SseEvent } from '../../src/stream/sse.js';

function parseChunks(chunks: readonly Buffer[], p = new SseParser()): SseEvent[] {
  const out: SseEvent[] = [];
  for (const c of chunks) out.push(...p.push(c));
  out.push(...p.end());
  return out;
}

test('S-V4-1 a long line delivered in small chunks parses in linear time (was quadratic: 1 MiB in 64-byte chunks took 20 s)', () => {
  const p = new SseParser();
  const chunk = Buffer.alloc(64, 0x61);
  const started = performance.now();
  expect(p.push(Buffer.from('event: response.completed\ndata: '))).toEqual([]);
  for (let i = 0; i < (2 * 1024 * 1024) / 64; i++) expect(p.push(chunk)).toEqual([]);
  const events = p.push(Buffer.from('\n\n'));
  expect(performance.now() - started).toBeLessThan(1_000);
  expect(events).toHaveLength(1);
  expect(events[0]?.event).toBe('response.completed');
  expect(events[0]?.data.length).toBe(2 * 1024 * 1024);
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
