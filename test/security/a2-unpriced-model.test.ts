// A2 (security review A): an unpriced model was admitted under enforced budgets with failure.unpricedModel:
// allow-and-flag, reserved and settled at the envelope of the priced models. A model dearer than every priced one (an
// OpenAI "-pro" model) was billed far above what the budget was charged. Now an unpriced model is refused whenever an
// enforced budget level applies (as unpriced server tools are), and the example codex route lists its models.
import { afterEach, expect, test } from 'vitest';
import { codexHeaders, respBody, send } from '../helpers/conformance.js';
import { testPolicy } from '../helpers/policy.js';
import { closeAll, gw, raw, readJson } from './common.js';

afterEach(closeAll);

async function proUpstream(calls: { n: number }) {
  return raw(async (req, res) => {
    await readJson(req);
    calls.n++;
    const usage = { input_tokens: 4_000, output_tokens: 128_000, input_tokens_details: { cached_tokens: 0 } };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'resp_1', object: 'response', model: 'gpt-5.5-pro', status: 'completed', output: [], usage }));
  });
}

test('A2 the example codex route does not admit an unpriced model', async () => {
  const calls = { n: 0 };
  const up = await proUpstream(calls);
  const g = await gw(testPolicy({ upstream: 'http://127.0.0.1:9', openaiUpstream: up.url }));
  const r = await send(g.url, { path: '/v1/responses', headers: codexHeaders, body: respBody({ model: 'gpt-5.5-pro', stream: false }) });
  expect(r.status).toBe(403);
  expect(calls.n).toBe(0);
  await expect.poll(() => g.outcomes.length).toBe(1);
  expect(g.outcomes[0]?.reservedMicroUsd ?? 0).toBe(0);
});

test('A2 a route without allowModels refuses an unpriced model when an enforced budget applies, despite allow-and-flag', async () => {
  const calls = { n: 0 };
  const up = await proUpstream(calls);
  const policy = testPolicy({ upstream: 'http://127.0.0.1:9', openaiUpstream: up.url, editRoutes: (routes) => void delete routes.find((x) => x.name === 'codex')!.allowModels });
  expect(policy.failure.unpricedModel).toBe('allow-and-flag');
  const g = await gw(policy);
  const r = await send(g.url, { path: '/v1/responses', headers: codexHeaders, body: respBody({ model: 'gpt-5.5-pro', stream: false }) });
  expect(r.status).toBe(403);
  expect(r.headers['x-should-retry']).toBe('false');
  expect(calls.n).toBe(0);
  await expect.poll(() => g.outcomes.length).toBe(1);
  expect(g.outcomes[0]?.decision?.reason).toBe('unpriced');
});

test('A2 without an enforced budget level, allow-and-flag still forwards an unpriced model, flagged', async () => {
  const calls = { n: 0 };
  const up = await proUpstream(calls);
  const policy = testPolicy({
    upstream: 'http://127.0.0.1:9',
    openaiUpstream: up.url,
    editRoutes: (routes) => void delete routes.find((x) => x.name === 'codex')!.allowModels,
    edit: (p) => void (p.budgets = p.budgets.map((b) => ({ ...b, mode: 'audit' as const }))),
  });
  const g = await gw(policy);
  const r = await send(g.url, { path: '/v1/responses', headers: codexHeaders, body: respBody({ model: 'gpt-5.5-pro', stream: false }) });
  expect(r.status).toBe(200);
  expect(calls.n).toBe(1);
});
