import { readFileSync } from 'node:fs';
import { afterEach, expect, test } from 'vitest';
import type { RequestOutcome } from '../../../src/edge/handler.js';
import { codexHeaders, respBody, send, startOpenAIStack, startRawUpstream } from '../../helpers/conformance.js';

const fx = (n: string) => readFileSync(new URL(`../../fixtures/sse/${n}.txt`, import.meta.url));

let stack: Awaited<ReturnType<typeof startOpenAIStack>> | undefined;
let raw: Awaited<ReturnType<typeof startRawUpstream>> | undefined;
afterEach(async () => {
  await stack?.close();
  await raw?.close();
  stack = raw = undefined;
});

test('R4 response.failed and response.incomplete forwarded unchanged [https://developers.openai.com/api/reference/resources/responses/streaming-events]', async () => {
  let next = fx('responses-failed');
  raw = await startRawUpstream((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' }).end(next);
  });
  const settled: RequestOutcome[] = [];
  stack = await startOpenAIStack({ policy: { openaiUpstream: raw.url }, gw: { onSettled: (o) => settled.push(o) } });

  const failed = await send(stack.gw.url, { path: '/v1/responses', headers: codexHeaders, body: respBody() });
  expect(failed.status).toBe(200);
  expect(failed.body.equals(fx('responses-failed'))).toBe(true);
  await expect.poll(() => settled.length).toBe(1);
  expect(settled[0]?.usage).toMatchObject({ midStreamError: 'server_error', sawStop: true });

  next = fx('responses-incomplete');
  const incomplete = await send(stack.gw.url, { path: '/v1/responses', headers: codexHeaders, body: respBody() });
  expect(incomplete.body.equals(fx('responses-incomplete'))).toBe(true);
  await expect.poll(() => settled.length).toBe(2);
  expect(settled[1]?.usage).toMatchObject({ source: 'final', sawStop: true, usage: { input: 500, output: 16 } });
});
