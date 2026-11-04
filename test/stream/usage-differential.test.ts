// The SSE parser finds line ends with indexOf, and the streaming usage accumulator counts the text of compact `content_block_delta` events without JSON.parse (0.2.1).
// Every event, compact or not, must leave the accumulator exactly where the frozen 0.2.0 accumulator leaves it.
import fc from 'fast-check';
import { expect, test } from 'vitest';
import { AnthropicUsageAccumulator } from '../../src/stream/anthropic-usage.js';
import { SseParser } from '../../src/stream/sse.js';
import { fuzz } from '../helpers/fuzz.js';
import * as refAcc from './reference/anthropic-usage.js';
import * as ref from './reference/sse.js';

/** Text with the characters that change how JSON reads it: quotes, backslashes, control characters, non-ASCII, surrogates. */
const tricky = fc.array(fc.oneof(fc.string({ maxLength: 8 }), fc.constantFrom('"', '\\', '\\"', '\\n', '\\u0041', '\n', '\t', '\u0000', '\u007f', 'é', '日本', '😀', '\ud800', '}}', '"}}')), { maxLength: 8 }).map((p) => p.join(''));
const deltaKind = fc.constantFrom(['text_delta', 'text'], ['thinking_delta', 'thinking'], ['input_json_delta', 'partial_json'], ['signature_delta', 'signature'], ['text_delta', 'thinking'], ['citations_delta', 'text']);
const index = fc.oneof(fc.nat({ max: 20 }).map(String), fc.constantFrom('00', '01', '-1', '1.5', '1e2', ' 1', '', 'x', '9007199254740993'));
/** Compact events as the API writes them, with raw text and with JSON-escaped text, and near misses of that shape. */
const compact = fc.tuple(index, deltaKind, tricky, fc.boolean()).map(([i, [dt, field], s, escape]) => {
  const v = escape ? JSON.stringify(s).slice(1, -1) : s;
  return `{"type":"content_block_delta","index":${i},"delta":{"type":"${dt}","${field}":"${v}"}}`;
});
const mutate = fc.tuple(compact, fc.nat({ max: 200 }), fc.constantFrom('', ' ', '"', '\\', '}', ',"x":1', '\n', 'a')).map(([s, at, ins]) => s.slice(0, at % (s.length + 1)) + ins + s.slice(at % (s.length + 1)));
const otherJson = fc.oneof(
  fc.record({ type: fc.constantFrom('content_block_delta', 'message_delta', 'ping'), index: fc.nat(3), delta: fc.dictionary(fc.constantFrom('type', 'text', 'thinking', 'partial_json'), fc.oneof(tricky, fc.integer())) }).map((o) => JSON.stringify(o)),
  fc.record({ delta: fc.record({ type: fc.constant('text_delta'), text: tricky }) }).map((o) => JSON.stringify(o)),
  fc.tuple(tricky).map(([s]) => JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: s } }, null, 1)),
  fc.tuple(tricky).map(([s]) => `{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"${s}"},"type":"error"}`),
);
const event = fc.record({ event: fc.constantFrom(null, 'content_block_delta', 'message_delta', 'error'), data: fc.oneof(compact, mutate, otherJson, tricky) });
const start = { event: 'message_start', data: JSON.stringify({ type: 'message_start', message: { model: 'm', usage: { input_tokens: 3, output_tokens: 1 } } }) };

test('every event leaves the accumulator as the 0.2.0 accumulator leaves it', () => {
  fc.assert(
    fc.property(fc.array(event, { maxLength: 12 }), fc.boolean(), (events, started) => {
      const a = new AnthropicUsageAccumulator();
      const b = new refAcc.AnthropicUsageAccumulator();
      for (const e of started ? [start, ...events] : events) {
        a.onEvent(e);
        b.onEvent(e);
      }
      expect(a.result()).toEqual(b.result());
    }),
    fuzz(2111, 3000),
  );
});

test('compact text deltas are counted exactly, as the mock and the API write them', () => {
  const a = new AnthropicUsageAccumulator();
  const parser = new SseParser();
  const frames = ['a', 'Héllo "q" \\ \n', '日本語 😀', ''].map((t, i) => `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: i, delta: { type: i === 1 ? 'thinking_delta' : 'text_delta', [i === 1 ? 'thinking' : 'text']: t } })}\n\n`);
  for (const e of parser.push(Buffer.from(frames.join('')))) a.onEvent(e);
  expect(a.result().streamedChars).toBe(['a', 'Héllo "q" \\ \n', '日本語 😀', ''].reduce((n, t) => n + t.length, 0));
});

const sseBytes = fc
  .array(fc.oneof(fc.constantFrom('\n', '\r', '\r\n', '\n\n', 'data: ', 'data:', 'event: x', ':c', 'id: 1', 'é', 'ÿ'), fc.string({ maxLength: 10 })), { maxLength: 40 })
  .map((p) => Buffer.from(p.join('')));

test('the SSE parser gives the 0.2.0 parser’s events and drops for any bytes, cut anywhere, at any line cap', () => {
  fc.assert(
    fc.property(sseBytes, fc.array(fc.nat({ max: 400 }), { maxLength: 8 }), fc.constantFrom(4, 16, 1024), (bytes, cutsRaw, cap) => {
      const cuts = [...new Set(cutsRaw.map((c) => c % (bytes.length + 1)))].sort((a, b) => a - b);
      const a = new SseParser({ maxLineBytes: cap });
      const b = new ref.SseParser({ maxLineBytes: cap });
      const got: unknown[] = [];
      const want: unknown[] = [];
      let from = 0;
      for (const to of [...cuts, bytes.length]) {
        got.push(...a.push(bytes.subarray(from, to)));
        want.push(...b.push(bytes.subarray(from, to)));
        expect(a.pendingBytes()).toBe(b.pendingBytes());
        from = to;
      }
      got.push(...a.end());
      want.push(...b.end());
      expect(got).toEqual(want);
      expect(a.droppedEvents).toBe(b.droppedEvents);
    }),
    fuzz(2112, 3000),
  );
});
