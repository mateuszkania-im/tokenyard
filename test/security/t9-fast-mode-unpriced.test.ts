// Task 9 carried items (Task 25 checklist): (d) settlement prices `usage.speed: "fast"` from the response at the fast
// rates, and (e) a request asking fast mode on a model whose price entry has no `fast` block. The price table is the
// only price source and unpriced cost fails closed (S10-3b, G4), so such a request is refused like a non-standard
// service tier without tier prices (S20-1): 403 unpriced, x-should-retry false, nothing sent (ruling superseding
// CL-t9e). A response that reports fast mode without the request asking settles at the reservation. Mock upstreams.
import { afterEach, expect, test } from 'vitest';
import { costMicroUsd } from '../../src/pricing/cost.js';
import { authHeaders, send } from '../helpers/conformance.js';
import { auditBudgets, testPolicy } from '../helpers/policy.js';
import { closeAll, gw, raw, readJson } from './common.js';

afterEach(closeAll);

async function answer(model: string) {
  let n = 0;
  const up = await raw(async (req, res) => {
    await readJson(req);
    n++;
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'm', type: 'message', model, content: [], usage: { input_tokens: 2000, output_tokens: 4000, speed: 'fast' } }));
  });
  return { ...up, received: () => n };
}
const body = (model: string): Buffer => Buffer.from(JSON.stringify({ model, max_tokens: 8000, speed: 'fast', messages: [{ role: 'user', content: 'hi' }] }));

test('T9-d a response reporting usage.speed fast on a model with fast prices is settled at the fast rates', async () => {
  const MODEL = 'claude-opus-5-5';
  const up = await answer(MODEL);
  const policy = testPolicy({ upstream: up.url });
  const g = await gw(policy);
  expect((await send(g.url, { path: '/v1/messages', headers: authHeaders, body: body(MODEL) })).status).toBe(200);
  await expect.poll(() => g.outcomes.length).toBe(1);
  const usage = { input: 2000, output: 4000, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
  const fast = costMicroUsd(policy.prices, MODEL, usage, { fast: true });
  expect(fast).toBeGreaterThan(costMicroUsd(policy.prices, MODEL, usage, {}));
  expect(g.outcomes[0]?.costMicroUsd).toBe(fast);
});

test('T9-e a request asking fast mode on a model without fast prices is refused as unpriced and never sent', async () => {
  const MODEL = 'claude-sonnet-5-5';
  const up = await answer(MODEL);
  const policy = testPolicy({ upstream: up.url });
  expect(policy.prices.models[MODEL]?.fast).toBeUndefined();
  const g = await gw(policy);
  for (const speed of ['fast', 'turbo']) {
    const r = await send(g.url, { path: '/v1/messages', headers: authHeaders, body: Buffer.from(JSON.stringify({ model: MODEL, max_tokens: 8000, speed, messages: [{ role: 'user', content: 'hi' }] })) });
    expect(r.status, speed).toBe(403);
    expect(JSON.parse(r.body.toString()).error.type, speed).toBe('permission_error');
    expect(r.headers['x-should-retry'], speed).toBe('false');
  }
  expect(up.received()).toBe(0);
  await expect.poll(() => g.outcomes.length).toBe(2);
  for (const o of g.outcomes) expect(o.decision?.reason).toBe('unpriced');
});

test('T9-e the refusal holds with failure.unpricedModel allow-and-flag and no enforced budget (as S20-1)', async () => {
  const MODEL = 'claude-sonnet-5-5';
  const up = await answer(MODEL);
  const policy = testPolicy({ upstream: up.url, edit: auditBudgets });
  expect(policy.failure.unpricedModel).toBe('allow-and-flag');
  const g = await gw(policy);
  const r = await send(g.url, { path: '/v1/messages', headers: authHeaders, body: body(MODEL) });
  expect(r.status).toBe(403);
  expect(r.headers['x-should-retry']).toBe('false');
  expect(up.received()).toBe(0);
  await expect.poll(() => g.outcomes.length).toBe(1);
  expect(g.outcomes[0]?.decision?.reason).toBe('unpriced');
});

test('T9-e speed "standard" on a model without fast prices is forwarded as before', async () => {
  const MODEL = 'claude-sonnet-5-5';
  const up = await answer(MODEL);
  const g = await gw(testPolicy({ upstream: up.url }));
  const r = await send(g.url, { path: '/v1/messages', headers: authHeaders, body: Buffer.from(JSON.stringify({ model: MODEL, max_tokens: 8000, speed: 'standard', messages: [{ role: 'user', content: 'hi' }] })) });
  expect(r.status).toBe(200);
  expect(up.received()).toBe(1);
});

test('T9-residual a response reporting fast mode without the request asking settles at the reservation', async () => {
  const MODEL = 'claude-sonnet-5-5';
  const up = await answer(MODEL);
  const policy = testPolicy({ upstream: up.url });
  const g = await gw(policy);
  const r = await send(g.url, { path: '/v1/messages', headers: authHeaders, body: Buffer.from(JSON.stringify({ model: MODEL, max_tokens: 8000, messages: [{ role: 'user', content: 'hi' }] })) });
  expect(r.status).toBe(200);
  await expect.poll(() => g.outcomes.length).toBe(1);
  const o = g.outcomes[0]!;
  const standard = costMicroUsd(policy.prices, MODEL, { input: 2000, output: 4000, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, {});
  expect(o.settledAtEstimate).toBe(true);
  expect(o.reservedMicroUsd).toBeGreaterThan(standard);
  expect(o.costMicroUsd).toBe(o.reservedMicroUsd);
});
