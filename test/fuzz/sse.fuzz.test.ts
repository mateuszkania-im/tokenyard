// V4 fuzz: the SSE parser (src/stream/sse.ts) reads every upstream stream for usage. Any split of the same bytes into
// chunks gives the events of the unsplit input, and both match a whole-input reference; malformed input never throws;
// long lines cost linear time and bounded memory (S-V4-1).
import fc from 'fast-check';
import { expect, test } from 'vitest';
import { AnthropicUsageAccumulator } from '../../src/stream/anthropic-usage.js';
import { ResponsesUsageAccumulator } from '../../src/stream/responses-usage.js';
import { MAX_SSE_LINE_BYTES, SseParser, type SseEvent } from '../../src/stream/sse.js';
import { fuzz, fuzzTimeout } from '../helpers/fuzz.js';

function parseChunks(chunks: readonly Buffer[], p = new SseParser()): SseEvent[] {
  const out: SseEvent[] = [];
  for (const c of chunks) out.push(...p.push(c));
  out.push(...p.end());
  return out;
}

/** The SSE rules applied to the whole input at once: decode, split on CRLF, LF or CR, dispatch on blank lines. */
function reference(bytes: Buffer): SseEvent[] {
  const lines = bytes.toString('utf8').split(/\r\n|\r|\n/);
  const tail = lines.pop() as string; // unterminated: processed at end, can never dispatch (it is not blank)
  const out: SseEvent[] = [];
  let event: string | null = null;
  let data: string[] | null = null;
  for (const line of tail === '' ? lines : [...lines, tail]) {
    if (line === '') {
      if (data) out.push({ event, data: data.join('\n') });
      event = null;
      data = null;
      continue;
    }
    if (line.startsWith(':')) continue;
    const i = line.indexOf(':');
    const field = i < 0 ? line : line.slice(0, i);
    let value = i < 0 ? '' : line.slice(i + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') (data ??= []).push(value);
  }
  return out;
}

/** Cuts `b` at the given offsets (any order, duplicates make empty chunks). */
function cut(b: Buffer, at: readonly number[]): Buffer[] {
  const points = at.map((x) => x % (b.length + 1)).sort((x, y) => x - y);
  const out: Buffer[] = [];
  let prev = 0;
  for (const p of points) {
    out.push(b.subarray(prev, p));
    prev = p;
  }
  out.push(b.subarray(prev));
  return out;
}

const eol = fc.constantFrom('\n', '\r\n', '\r');
const value = fc.oneof(fc.string({ maxLength: 20 }), fc.string({ unit: 'grapheme', maxLength: 8 }), fc.constantFrom('{"type":"message_delta","usage":{"output_tokens":5}}', ' lead', '', ':'));
const line = fc.oneof(
  value.map((v) => `data: ${v}`),
  value.map((v) => `data:${v}`),
  fc.constantFrom('message_start', 'ping', 'response.completed', '').map((v) => `event: ${v}`),
  value.map((v) => `: ${v}`),
  fc.constantFrom('data', 'event', 'id: 7', 'retry: 10', 'unknown: x', ' data: x'),
  fc.constant(''),
);
/** Text shaped like SSE: lines with mixed line ends; raw strings may hold CR or LF of their own. */
const sseText = fc.array(fc.tuple(fc.oneof({ weight: 6, arbitrary: line }, { weight: 1, arbitrary: fc.string({ maxLength: 6 }) }), eol), { maxLength: 30 }).map((xs) => xs.map(([l, e]) => l + e).join(''));
/** Bytes: SSE-shaped UTF-8, sometimes with arbitrary bytes inside (invalid UTF-8, lone CR, NUL) and an unterminated tail. */
const input = fc.tuple(sseText, fc.uint8Array({ maxLength: 24 }), fc.nat(), fc.string({ maxLength: 10 })).map(([t, junk, at, tail]) => {
  const b = Buffer.from(t);
  const p = at % (b.length + 1);
  return Buffer.concat([b.subarray(0, p), Buffer.from(junk), b.subarray(p), Buffer.from(tail)]);
});

test('fuzz: any chunk split gives the events of the unsplit input, which match the whole-input reference', () => {
  fc.assert(
    fc.property(input, fc.array(fc.nat(), { maxLength: 12 }), (b, at) => {
      const whole = parseChunks([b]);
      expect(whole).toEqual(reference(b));
      expect(parseChunks(cut(b, at))).toEqual(whole);
    }),
    fuzz(0x55e1, 2_000),
  );
}, fuzzTimeout(10_000));

test('fuzz: byte-at-a-time and CR LF split across chunks give the same events', () => {
  fc.assert(
    fc.property(input, (b) => {
      const bytes = [...b].map((x) => Buffer.from([x]));
      expect(parseChunks(bytes)).toEqual(parseChunks([b]));
    }),
    fuzz(0x55e2, 300),
  );
}, fuzzTimeout(10_000));

test('fuzz: arbitrary bytes never throw, and the usage accumulators never throw on what the parser yields', () => {
  const event = fc.oneof(
    fc.constantFrom('message_start', 'message_delta', 'message_stop', 'content_block_delta', 'error', 'response.completed', 'response.failed', 'response.incomplete', 'response.output_text.delta'),
    fc.string({ maxLength: 8 }),
  );
  const data = fc.oneof(fc.json({ maxDepth: 4 }), fc.string({ maxLength: 40 }), fc.constantFrom('{"usage":{"input_tokens":1e308,"output_tokens":-1}}', '{"message":{"usage":null}}', '{"response":{"usage":{"input_tokens":"7"}}}'));
  const stream = fc.array(fc.tuple(event, data), { maxLength: 12 }).map((xs) => Buffer.from(xs.map(([e, d]) => `event: ${e}\ndata: ${d.replace(/[\r\n]/g, ' ')}\n\n`).join('')));
  fc.assert(
    fc.property(fc.oneof(stream, fc.uint8Array({ maxLength: 200 }).map((u) => Buffer.from(u))), fc.array(fc.nat(), { maxLength: 6 }), (b, at) => {
      for (const acc of [new AnthropicUsageAccumulator(), new ResponsesUsageAccumulator()]) {
        for (const e of parseChunks(cut(b, at))) acc.onEvent(e);
        const r = acc.result();
        for (const n of Object.values(r.usage ?? {})) expect(Number.isFinite(n) && n >= 0).toBe(true);
      }
    }),
    fuzz(0x55e3, 1_000),
  );
}, fuzzTimeout(10_000));

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
