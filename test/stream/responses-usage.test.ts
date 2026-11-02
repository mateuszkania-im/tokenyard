import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { parseResponsesJsonUsage, ResponsesUsageAccumulator } from '../../src/stream/responses-usage.js';
import { SseParser } from '../../src/stream/sse.js';

const fx = (n: string) => readFileSync(new URL(`../fixtures/sse/${n}.txt`, import.meta.url));

function run(buf: Buffer, o?: ConstructorParameters<typeof ResponsesUsageAccumulator>[0]) {
  const p = new SseParser();
  const acc = new ResponsesUsageAccumulator(o);
  for (const e of [...p.push(buf), ...p.end()]) acc.onEvent(e);
  return acc.result();
}

// The fixture is a real Codex 0.166.0 stream (gpt-5.4-mini, 2026-11-03) with every id, text and count replaced.
test('response.completed usage: cached is cache read, cache_write_tokens a cache write, the rest input; output includes reasoning', () => {
  const r = run(fx('responses-completed'));
  expect(r).toMatchObject({
    source: 'final',
    sawStop: true,
    midStreamError: null,
    responseModel: 'gpt-5.4-mini-2026-03-17',
    usage: { input: 1200 - 1024 - 64, cacheRead: 1024, cacheWrite5m: 64, cacheWrite1h: 0, output: 42 },
  });
  expect(r.streamedChars).toBe(71);
});

test('response.incomplete carries usage and ends the stream', () => {
  expect(run(fx('responses-incomplete'))).toMatchObject({ source: 'final', sawStop: true, usage: { input: 500, cacheRead: 0, output: 16 } });
});

test('response.failed without usage is partial at the input bound, with the error code', () => {
  expect(run(fx('responses-failed'), { inputTokensIfUnknown: 9000 })).toMatchObject({
    source: 'partial',
    sawStop: true,
    midStreamError: 'server_error',
    usage: { input: 9000, cacheRead: 0, output: 0 },
  });
});

test('a stream cut before a terminal event is partial: output from the streamed text, input at the bound', () => {
  const r = run(fx('responses-truncated'), { inputTokensIfUnknown: 5000 });
  expect(r.source).toBe('partial');
  expect(r.sawStop).toBe(false);
  expect(r.outputEstimated).toBe(true);
  expect(r.streamedChars).toBe('0123456789'.length + '{"command":'.length);
  expect(r.usage).toEqual({ input: 5000, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: Math.ceil(21 / 4) });
});

test('no response.created: nothing was started, usage none', () => {
  expect(run(Buffer.from('')).source).toBe('none');
});

test('an error event is noted as a mid-stream error', () => {
  const acc = new ResponsesUsageAccumulator();
  acc.onEvent({ event: 'response.created', data: JSON.stringify({ type: 'response.created', response: { model: 'm', usage: null } }) });
  acc.onEvent({ event: 'error', data: JSON.stringify({ type: 'error', code: 'rate_limit_exceeded', message: 'x' }) });
  expect(acc.result().midStreamError).toBe('rate_limit_exceeded');
});

test('negative or non-numeric counts are ignored; cached above input is capped', () => {
  const acc = new ResponsesUsageAccumulator();
  acc.onEvent({ event: null, data: JSON.stringify({ type: 'response.created', response: {} }) });
  acc.onEvent({ event: null, data: JSON.stringify({ type: 'response.completed', response: { usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 99 }, output_tokens: -3 } } }) });
  expect(acc.result().usage).toEqual({ input: 0, cacheRead: 10, cacheWrite5m: 0, cacheWrite1h: 0, output: 0 });
});

test('non-streaming response body usage is parsed', () => {
  const body = Buffer.from(JSON.stringify({ id: 'r', object: 'response', status: 'completed', model: 'gpt-5.4-mini', usage: { input_tokens: 30, input_tokens_details: { cached_tokens: 10 }, output_tokens: 7 } }));
  expect(parseResponsesJsonUsage(body)).toMatchObject({ source: 'final', sawStop: true, responseModel: 'gpt-5.4-mini', usage: { input: 20, cacheRead: 10, output: 7 } });
  expect(parseResponsesJsonUsage(Buffer.from('not json')).source).toBe('none');
});
