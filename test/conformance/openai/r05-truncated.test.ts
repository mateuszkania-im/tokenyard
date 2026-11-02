import { readFileSync } from 'node:fs';
import { afterEach, expect, test } from 'vitest';
import type { RequestOutcome } from '../../../src/edge/handler.js';
import { codexHeaders, respBody, sendTolerant, startOpenAIStack, startRawUpstream } from '../../helpers/conformance.js';

const fixture = readFileSync(new URL('../../fixtures/sse/responses-truncated.txt', import.meta.url));

let stack: Awaited<ReturnType<typeof startOpenAIStack>> | undefined;
let raw: Awaited<ReturnType<typeof startRawUpstream>> | undefined;
afterEach(async () => {
  await stack?.close();
  await raw?.close();
  stack = raw = undefined;
});

test('R5 truncated stream settled partial from streamed output text [https://developers.openai.com/api/reference/resources/responses/streaming-events]', async () => {
  raw = await startRawUpstream((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(fixture, () => setTimeout(() => res.socket?.destroy(), 20));
  });
  const settled: RequestOutcome[] = [];
  stack = await startOpenAIStack({ policy: { openaiUpstream: raw.url }, gw: { onSettled: (o) => settled.push(o) } });
  const got = await sendTolerant(stack.gw.url, '/v1/responses', codexHeaders, respBody());
  // The client gets exactly the bytes upstream sent, cut where upstream cut them; nothing is synthesised.
  expect(got.body.equals(fixture)).toBe(true);
  expect(got.body.toString()).not.toContain('response.completed');
  await expect.poll(() => settled.length).toBe(1);
  const o = settled[0] as RequestOutcome;
  expect(o.usage?.source).toBe('partial');
  expect(o.usage?.sawStop).toBe(false);
  expect(o.usage?.usage?.output).toBe(Math.ceil(('0123456789'.length + '{"command":'.length) / 4));
  // No usage arrived for the input: it is settled at the request's own input bound, never at zero.
  expect(o.usage?.usage?.input).toBe(o.inputBound?.tokens);
  expect(o.costMicroUsd).toBeGreaterThan(0);
});
