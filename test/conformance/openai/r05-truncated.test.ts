import { readFileSync } from 'node:fs';
import { afterEach, expect, test } from 'vitest';
import type { RequestOutcome } from '../../../src/edge/handler.js';
import { createMemoryStore } from '../../../src/limits/memory-store.js';
import { codexHeaders, respBody, sendTolerant, startOpenAIStack, startRawUpstream } from '../../helpers/conformance.js';

const fixture = readFileSync(new URL('../../fixtures/sse/responses-truncated.txt', import.meta.url));

let stack: Awaited<ReturnType<typeof startOpenAIStack>> | undefined;
let raw: Awaited<ReturnType<typeof startRawUpstream>> | undefined;
afterEach(async () => {
  await stack?.close();
  await raw?.close();
  stack = raw = undefined;
});

test('R5 truncated stream settled partial, at the reservation (ruling S20-2) [https://developers.openai.com/api/reference/resources/responses/streaming-events]', async () => {
  raw = await startRawUpstream((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(fixture, () => setTimeout(() => res.socket?.destroy(), 20));
  });
  const settled: RequestOutcome[] = [];
  stack = await startOpenAIStack({ policy: { openaiUpstream: raw.url }, gw: { store: createMemoryStore({ clock: Date.now }), onSettled: (o) => settled.push(o) } });
  const got = await sendTolerant(stack.gw.url, '/v1/responses', codexHeaders, respBody());
  // The client gets exactly the bytes upstream sent, cut where upstream cut them; nothing is synthesised.
  expect(got.body.equals(fixture)).toBe(true);
  expect(got.body.toString()).not.toContain('response.completed');
  await expect.poll(() => settled.length).toBe(1);
  const o = settled[0] as RequestOutcome;
  expect(o.usage?.source).toBe('partial');
  expect(o.usage?.sawStop).toBe(false);
  // No terminal usage arrived: hidden reasoning and the prompt are unknown, so the reservation (the worst-case
  // estimate) is what the budget is charged, never the streamed text alone.
  expect(o.usage?.usage).toBeNull();
  expect(o.usage?.streamedChars).toBe('0123456789'.length + '{"command":'.length);
  expect(o.settledAtEstimate).toBe(true);
  expect(o.reservedMicroUsd).toBeGreaterThan(0);
  expect(o.costMicroUsd).toBe(o.reservedMicroUsd);
  expect(o.chargedMicroUsd).toBe(o.reservedMicroUsd);
});
