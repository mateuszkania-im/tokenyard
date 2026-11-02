import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { AnthropicUsageAccumulator, parseAnthropicJsonUsage } from '../../src/stream/anthropic-usage.js';
import { SseParser } from '../../src/stream/sse.js';

const fx = (n: string) => readFileSync(new URL(`../fixtures/sse/${n}.txt`, import.meta.url));

function run(buf: Buffer) {
  const p = new SseParser();
  const acc = new AnthropicUsageAccumulator();
  for (const e of [...p.push(buf), ...p.end()]) acc.onEvent(e);
  return acc.result();
}
const ev = (type: string, body: object) => ({ event: type, data: JSON.stringify({ type, ...body }) });

test('message_delta usage overwrites message_start (cumulative)', () => {
  const r = run(fx('anthropic-basic'));
  expect(r).toMatchObject({
    source: 'final',
    sawStop: true,
    midStreamError: null,
    responseModel: 'claude-sonnet-5-5',
    usage: { input: 10, cacheRead: 100, cacheWrite5m: 20, cacheWrite1h: 30, output: 42 },
  });
  expect(r.streamedChars).toBe('Héllo wörld 日本語'.length);
});

test('cache_creation_input_tokens without split counts as 5m', () => {
  const acc = new AnthropicUsageAccumulator();
  acc.onEvent(ev('message_start', { message: { model: 'm', usage: { input_tokens: 1, cache_creation_input_tokens: 9, output_tokens: 1 } } }));
  acc.onEvent(ev('message_delta', { usage: { output_tokens: 5 } }));
  acc.onEvent(ev('message_stop', {}));
  expect(acc.result().usage).toMatchObject({ cacheWrite5m: 9, cacheWrite1h: 0, output: 5 });
});

test('stream ending after message_start without message_stop is partial', () => {
  const acc = new AnthropicUsageAccumulator();
  acc.onEvent(ev('message_start', { message: { model: 'm', usage: { input_tokens: 3, output_tokens: 1 } } }));
  acc.onEvent(ev('message_delta', { usage: { output_tokens: 8 } }));
  expect(acc.result()).toMatchObject({ source: 'partial', sawStop: false, usage: { input: 3, output: 8 } });
});

test('no message_delta usage: output estimated as ceil(streamed chars / 4), source estimated', () => {
  const r = run(fx('anthropic-truncated'));
  expect(r.streamedChars).toBe(9);
  expect(r).toMatchObject({ source: 'estimated', sawStop: false, usage: { input: 12, output: 3 } });
});

test('no message_start gives source none and null usage', () => {
  expect(new AnthropicUsageAccumulator().result()).toMatchObject({ source: 'none', usage: null });
});

test('event: error after 200 sets midStreamError to the error type', () => {
  const r = run(fx('anthropic-error'));
  expect(r.midStreamError).toBe('overloaded_error');
  expect(r.source).toBe('estimated');
  expect(r.usage?.input).toBe(25);
});

test('unknown event types, ping and malformed data are ignored', () => {
  const acc = new AnthropicUsageAccumulator();
  acc.onEvent(ev('message_start', { message: { model: 'm', usage: { input_tokens: 2, output_tokens: 1 } } }));
  acc.onEvent(ev('ping', {}));
  acc.onEvent(ev('future_event', { x: 1 }));
  acc.onEvent({ event: 'weird', data: 'not json' });
  acc.onEvent(ev('message_delta', { usage: { output_tokens: 4 } }));
  acc.onEvent(ev('message_stop', {}));
  expect(acc.result()).toMatchObject({ source: 'final', usage: { input: 2, output: 4 }, midStreamError: null });
});

test('parseAnthropicJsonUsage reads a non-streaming body', () => {
  const body = Buffer.from(
    JSON.stringify({ model: 'claude-sonnet-5-5', usage: { input_tokens: 4, output_tokens: 6, cache_read_input_tokens: 2, cache_creation: { ephemeral_5m_input_tokens: 1, ephemeral_1h_input_tokens: 3 } } }),
  );
  expect(parseAnthropicJsonUsage(body)).toMatchObject({
    source: 'final',
    responseModel: 'claude-sonnet-5-5',
    usage: { input: 4, output: 6, cacheRead: 2, cacheWrite5m: 1, cacheWrite1h: 3 },
  });
});

test('parseAnthropicJsonUsage: absent usage or garbage gives none', () => {
  expect(parseAnthropicJsonUsage(Buffer.from('{"model":"m"}'))).toMatchObject({ source: 'none', usage: null, responseModel: 'm' });
  expect(parseAnthropicJsonUsage(Buffer.from('<html>'))).toMatchObject({ source: 'none', usage: null });
});

test('message_stop seen with no delta output is final, output estimated from chars', () => {
  const acc = new AnthropicUsageAccumulator();
  acc.onEvent(ev('message_start', { message: { model: 'm', usage: { input_tokens: 2, output_tokens: 1 } } }));
  acc.onEvent(ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: '123456789' } }));
  acc.onEvent(ev('message_stop', {}));
  expect(acc.result()).toMatchObject({ source: 'final', sawStop: true, usage: { input: 2, output: 3 } });
});
