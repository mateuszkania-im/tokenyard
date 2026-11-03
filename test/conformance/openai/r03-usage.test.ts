import { readFileSync } from 'node:fs';
import { afterEach, expect, test } from 'vitest';
import type { RequestOutcome } from '../../../src/edge/handler.js';
import { codexHeaders, respBody, send, startOpenAIStack, startRawUpstream } from '../../helpers/conformance.js';

const fixture = readFileSync(new URL('../../fixtures/sse/responses-completed.txt', import.meta.url));

let stack: Awaited<ReturnType<typeof startOpenAIStack>> | undefined;
let raw: Awaited<ReturnType<typeof startRawUpstream>> | undefined;
afterEach(async () => {
  await stack?.close();
  await raw?.close();
  stack = raw = undefined;
});

test('R3 response.completed usage parsed: input_tokens, output_tokens, input_tokens_details.cached_tokens [https://developers.openai.com/api/reference/resources/responses/streaming-events]', async () => {
  raw = await startRawUpstream((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' }).end(fixture);
  });
  const settled: RequestOutcome[] = [];
  stack = await startOpenAIStack({ policy: { openaiUpstream: raw.url }, gw: { onSettled: (o) => settled.push(o) } });
  const res = await send(stack.gw.url, { path: '/v1/responses', headers: codexHeaders, body: respBody() });
  expect(res.body.equals(fixture)).toBe(true);
  await expect.poll(() => settled.length).toBe(1);
  const o = settled[0] as RequestOutcome;
  expect(o.surface).toBe('openai-responses');
  expect(o.client.agent).toBe('codex');
  // A real Codex 0.166.0 stream with values replaced (cache_write_tokens 64 is synthetic). input_tokens counts the
  // cached tokens: billed input is the rest. Cache writes are billed on top until their semantics are confirmed.
  expect(o.usage).toMatchObject({ source: 'final', sawStop: true, responseModel: 'gpt-5.4-mini-2026-03-17', usage: { input: 176, cacheRead: 1024, cacheWrite5m: 64, output: 42 } });
  // gpt-5.4-mini: 176 x 0.75 + 64 x 0.75 + 1024 x 0.075 + 42 x 4.5 micro-USD = 445.8, rounded half up.
  expect(o.costMicroUsd).toBe(446);
  expect(o.settledBy).toBeUndefined();
});
