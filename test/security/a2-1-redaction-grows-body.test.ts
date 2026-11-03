// A2-1 (security review A, second pass): the bytes bound (spec 7.3, one token per byte) was taken from the client's
// body, but on product routes PII redaction rewrites the body before it is sent: a 6-byte email becomes an 18-byte
// placeholder. Under the estimator's own premise the provider may bill one token per FORWARDED byte, so the
// reservation was no bound, and the self-inflicted overrun also tripped the shared R11 latch. Fix: the bound is
// computed from the body actually sent (after redaction, model rewrite and the output cap).
// Mock upstream bills input_tokens = forwarded body bytes (the premise), never more.
import { afterEach, expect, it } from 'vitest';
import { createGatewayRuntime } from '../../src/edge/handler.js';
import { createMemoryStore } from '../../src/limits/memory-store.js';
import { send } from '../helpers/conformance.js';
import { testPolicy } from '../helpers/policy.js';
import { closeAll, gw, raw, readJson, SERVICE_KEY, serviceKey } from './common.js';

afterEach(closeAll);

it('A2-1 product redaction lengthens the forwarded body: the bound covers the bytes sent and the R11 latch stays off', async () => {
  let forwarded = 0;
  const up = await raw(async (req, res) => {
    const { raw: b } = await readJson(req);
    forwarded = b.length;
    const body = JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: b.length, output_tokens: 1 } });
    res.writeHead(200, { 'content-type': 'application/json' }).end(body);
  });
  const policy = testPolicy({ upstream: up.url, extraKeys: [serviceKey] });
  const store = createMemoryStore({ clock: Date.now });
  const runtime = createGatewayRuntime();
  const { url, outcomes } = await gw(policy, store, { runtime });
  const text = Array.from({ length: 10_000 }, () => 'a@b.co').join(' ');
  // A model the route rewrites (to claude-haiku-5-5) and a max_tokens the route may cap: every body change counts.
  const clientBody = Buffer.from(JSON.stringify({ model: 'claude-haiku-5-5', max_tokens: 16, messages: [{ role: 'user', content: text }] }));
  const r = await send(url, { path: '/v1/messages', headers: { 'x-api-key': SERVICE_KEY, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' }, body: clientBody });
  expect(r.status).toBe(200);
  await expect.poll(() => outcomes.length).toBe(1);
  const o = outcomes[0]!;
  console.log(JSON.stringify({ clientBytes: clientBody.length, forwardedBytes: forwarded, inputBound: o.inputBound, reserved: o.reservedMicroUsd, charged: o.chargedMicroUsd, overrun: o.overrun, boundExceeded: o.boundExceeded }));
  expect(forwarded).toBeGreaterThan(clientBody.length); // redaction did lengthen the body
  // The bound must cover every byte actually sent upstream, and the charge must stay within the reservation.
  expect(o.inputBound?.kind).toBe('bytes');
  expect(o.inputBound!.tokens).toBeGreaterThanOrEqual(forwarded);
  expect(o.overrun).toBe(false);
  expect(o.chargedMicroUsd!).toBeLessThanOrEqual(o.reservedMicroUsd!);
  // A redaction-induced size change is not a tokenizer assumption violation: the shared latch stays off.
  expect(o.boundExceeded).not.toBe(true);
  expect(runtime.bytesBoundOff).toBe(false);
  expect(await store.boundOffLatched?.()).toBe(false);
});
