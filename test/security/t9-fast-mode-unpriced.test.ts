// Task 9 carried items (Task 25 checklist): (d) settlement prices `usage.speed: "fast"` from the response at the fast
// rates, and (e) a model whose price table entry has no `fast` block. Policy validation does not reject such a model
// (the table cannot say which models a provider serves fast: known limit, docs/security-review.md); the gateway fails
// toward charging: a response that reports fast mode for a model without fast prices is settled at its reservation,
// never at the standard rates of the usage it reported. Mock upstreams only.
import { afterEach, expect, test } from 'vitest';
import { costMicroUsd } from '../../src/pricing/cost.js';
import { authHeaders, send } from '../helpers/conformance.js';
import { testPolicy } from '../helpers/policy.js';
import { closeAll, gw, raw, readJson } from './common.js';

afterEach(closeAll);

const answer = (model: string) =>
  raw(async (req, res) => {
    await readJson(req);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'm', type: 'message', model, content: [], usage: { input_tokens: 2000, output_tokens: 4000, speed: 'fast' } }));
  });
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

test('T9-e a response reporting fast mode on a model without fast prices settles at the reservation, not at standard rates', async () => {
  const MODEL = 'claude-sonnet-5-5';
  const up = await answer(MODEL);
  const policy = testPolicy({ upstream: up.url });
  expect(policy.prices.models[MODEL]?.fast).toBeUndefined();
  const g = await gw(policy);
  expect((await send(g.url, { path: '/v1/messages', headers: authHeaders, body: body(MODEL) })).status).toBe(200);
  await expect.poll(() => g.outcomes.length).toBe(1);
  const o = g.outcomes[0]!;
  const standard = costMicroUsd(policy.prices, MODEL, { input: 2000, output: 4000, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, {});
  expect(o.settledAtEstimate).toBe(true);
  expect(o.reservedMicroUsd).toBeGreaterThan(standard);
  expect(o.costMicroUsd).toBe(o.reservedMicroUsd);
});
