// S20-2 (coordinator budget finding, Task 20, MEDIUM): a Responses 2xx whose stream ends without terminal usage was
// settled with input 0 and output ceil(chars/4), so a client could end its stream early (or the upstream could cut it)
// and pay for the streamed text only. It now settles at the reservation (the worst-case estimate), source partial,
// flagged settledAtEstimate. A 200 JSON body without usage settles at the reservation too.
import { readFileSync } from 'node:fs';
import { afterEach, expect, test } from 'vitest';
import type { RequestOutcome } from '../../src/edge/handler.js';
import { createMemoryStore } from '../../src/limits/memory-store.js';
import { codexHeaders, respBody, send, sendTolerant, startOpenAIStack, startRawUpstream } from '../helpers/conformance.js';

const truncated = readFileSync(new URL('../fixtures/sse/responses-truncated.txt', import.meta.url));
let stack: Awaited<ReturnType<typeof startOpenAIStack>> | undefined;
let raw: Awaited<ReturnType<typeof startRawUpstream>> | undefined;
afterEach(async () => {
  await stack?.close();
  await raw?.close();
  stack = raw = undefined;
});

test('S20-2 a stream cut before response.completed is charged the full reservation, not the streamed text', async () => {
  raw = await startRawUpstream((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(truncated, () => setTimeout(() => res.socket?.destroy(), 20));
  });
  const settled: RequestOutcome[] = [];
  stack = await startOpenAIStack({ policy: { openaiUpstream: raw.url }, gw: { store: createMemoryStore({ clock: Date.now }), onSettled: (o) => settled.push(o) } });
  await sendTolerant(stack.gw.url, '/v1/responses', codexHeaders, respBody());
  await expect.poll(() => settled.length).toBe(1);
  const o = settled[0] as RequestOutcome;
  expect(o.settledAtEstimate).toBe(true);
  expect(o.reservedMicroUsd).toBeGreaterThan(0);
  expect(o.chargedMicroUsd).toBe(o.reservedMicroUsd);
  // The old rule: ceil(streamed chars / 4) output tokens priced alone.
  expect(o.chargedMicroUsd).toBeGreaterThan(o.usage?.streamedChars ?? 0);
});

test('S20-2 a 200 JSON Responses body without usage is charged the full reservation', async () => {
  raw = await startRawUpstream(async (req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'resp_1', object: 'response', model: 'gpt-5.4-mini', status: 'completed', output: [] }));
  });
  const settled: RequestOutcome[] = [];
  stack = await startOpenAIStack({ policy: { openaiUpstream: raw.url }, gw: { store: createMemoryStore({ clock: Date.now }), onSettled: (o) => settled.push(o) } });
  const r = await send(stack.gw.url, { path: '/v1/responses', headers: codexHeaders, body: respBody({ stream: false }) });
  expect(r.status).toBe(200);
  await expect.poll(() => settled.length).toBe(1);
  expect(settled[0]?.settledAtEstimate).toBe(true);
  expect(settled[0]?.chargedMicroUsd).toBe(settled[0]?.reservedMicroUsd);
});
