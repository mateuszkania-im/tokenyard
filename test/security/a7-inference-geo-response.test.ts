// A7 (security review A): the inference_geo price modifier is taken from the request body only. Anthropic workspaces can set
// default_inference_geo (organisations that had opted out of global routing were migrated to default "us"); a request
// without inference_geo then runs and is billed at 1.1x, and the response says so in usage.inference_geo. The gateway
// settles it at 1.0x.
import { afterEach, expect, test } from 'vitest';
import { authHeaders, send } from '../helpers/conformance.js';
import { testPolicy } from '../helpers/policy.js';
import { costMicroUsd } from '../../src/pricing/cost.js';
import { closeAll, gw, raw, readJson, sse } from './common.js';

afterEach(closeAll);

test('A7 workspace default geo "us": response usage.inference_geo "us" is billed at the inferenceGeoUs rate', async () => {
  const MODEL = 'claude-opus-5-5';
  const up = await raw(async (req, res) => {
    await readJson(req);
    res.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({ id: 'm', type: 'message', model: MODEL, content: [], usage: { input_tokens: 2000, output_tokens: 20_000, inference_geo: 'us' } }),
    );
  });
  const policy = testPolicy({ upstream: up.url });
  const g = await gw(policy);
  const r = await send(g.url, { path: '/v1/messages', headers: authHeaders, body: Buffer.from(JSON.stringify({ model: MODEL, max_tokens: 20_000, messages: [{ role: 'user', content: 'hi' }] })) });
  expect(r.status).toBe(200);
  await expect.poll(() => g.outcomes.length).toBe(1);
  const billed = costMicroUsd(policy.prices, MODEL, { input: 2000, output: 20_000, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, { modifiers: ['inferenceGeoUs'] });
  console.log(`A7 charged=${g.outcomes[0]?.costMicroUsd} providerBill=${billed} modifiers=${JSON.stringify(g.outcomes[0]?.costModifiers ?? [])}`);
  expect(g.outcomes[0]?.costMicroUsd).toBe(billed);
});

test('A7 streaming: usage.inference_geo in message_delta prices the modifier', async () => {
  const MODEL = 'claude-opus-5-5';
  const up = await raw(async (req, res) => {
    await readJson(req);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(sse('message_start', { type: 'message_start', message: { model: MODEL, usage: { input_tokens: 2000, output_tokens: 1, inference_geo: 'us' } } }));
    res.write(sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 20_000 } }));
    res.end(sse('message_stop', { type: 'message_stop' }));
  });
  const policy = testPolicy({ upstream: up.url });
  const g = await gw(policy);
  const r = await send(g.url, { path: '/v1/messages', headers: authHeaders, body: Buffer.from(JSON.stringify({ model: MODEL, max_tokens: 20_000, stream: true, messages: [{ role: 'user', content: 'hi' }] })) });
  expect(r.status).toBe(200);
  await expect.poll(() => g.outcomes.length).toBe(1);
  const billed = costMicroUsd(policy.prices, MODEL, { input: 2000, output: 20_000, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, { modifiers: ['inferenceGeoUs'] });
  expect(g.outcomes[0]?.costMicroUsd).toBe(billed);
  expect(g.outcomes[0]?.costModifiers).toEqual(['inferenceGeoUs']);
});

test('A7 a request without inference_geo is reserved at the highest modifier', async () => {
  const MODEL = 'claude-opus-5-5';
  const up = await raw(async (req, res) => {
    await readJson(req);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'm', type: 'message', model: MODEL, content: [], usage: { input_tokens: 10, output_tokens: 20_000, inference_geo: 'us' } }));
  });
  const policy = testPolicy({ upstream: up.url });
  const g = await gw(policy);
  await send(g.url, { path: '/v1/messages', headers: authHeaders, body: Buffer.from(JSON.stringify({ model: MODEL, max_tokens: 20_000, messages: [{ role: 'user', content: 'hi' }] })) });
  await expect.poll(() => g.outcomes.length).toBe(1);
  const o = g.outcomes[0]!;
  expect(o.overrun).toBe(false);
  expect(o.costMicroUsd ?? 0).toBeLessThanOrEqual(o.reservedMicroUsd ?? 0);
});
