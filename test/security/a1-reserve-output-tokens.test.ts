// A1 (security review A, C4): a route's reserveOutputTokens lowers the worst-case reservation, but the gateway never writes the cap into the
// forwarded body, so the provider can generate up to the client's own max_tokens. The bound is broken, and on a
// header-selected route any client can opt into the smaller reservation.
import { afterEach, expect, test } from 'vitest';
import { authHeaders, send } from '../helpers/conformance.js';
import { testPolicy } from '../helpers/policy.js';
import { closeAll, gw, raw, readJson, SERVICE_KEY, serviceKey } from './common.js';

afterEach(closeAll);

/** Upstream that generates exactly the max_tokens it was sent (a model that uses its whole allowance). */
async function greedyUpstream(seen: number[]) {
  return raw(async (req, res) => {
    const { raw: body } = await readJson(req);
    const p = JSON.parse(body.toString()) as { max_tokens: number; model: string };
    seen.push(p.max_tokens);
    res.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({ id: 'msg', type: 'message', model: p.model, content: [], usage: { input_tokens: 20, output_tokens: p.max_tokens } }),
    );
  });
}

test('A1a product route with reserveOutputTokens: forwarded max_tokens is capped, actual cost never above the reservation', async () => {
  const seen: number[] = [];
  const up = await greedyUpstream(seen);
  const policy = testPolicy({
    upstream: up.url,
    extraKeys: [serviceKey],
    editRoutes: (routes) => {
      const r = routes.find((x) => x.name === 'product-default');
      if (r) r.reserveOutputTokens = 100;
    },
  });
  const g = await gw(policy);
  const body = Buffer.from(JSON.stringify({ model: 'claude-haiku-5-5', max_tokens: 64_000, messages: [{ role: 'user', content: 'write a novel' }] }));
  const r = await send(g.url, { path: '/v1/messages', headers: { ...authHeaders, 'x-api-key': SERVICE_KEY }, body });
  expect(r.status).toBe(200);
  await expect.poll(() => g.outcomes.length).toBe(1);
  const o = g.outcomes[0]!;
  console.log(`A1a reserved=${o.reservedMicroUsd} charged=${o.costMicroUsd} forwarded max_tokens=${seen[0]} overrun=${o.overrun}`);
  expect(seen[0]).toBeLessThanOrEqual(100);
  expect(o.overrun).toBe(false);
});

test('A1b header-selected coding-agent route with reserveOutputTokens and no body rewrite: the policy is refused', () => {
  expect(() =>
    testPolicy({
      upstream: 'http://127.0.0.1:9',
      editRoutes: (routes) => {
        const cc = routes.find((x) => x.name === 'claude-code')!;
        routes.unshift({ ...structuredClone(cc), name: 'cc-aux', match: { ...cc.match, requestClass: 'auxiliary' }, reserveOutputTokens: 200 });
      },
    }),
  ).toThrow(/E_RESERVE_OUTPUT_NO_REWRITE/);
});

test('A1b2 coding-agent route with reserveOutputTokens and no body rewrite: worst-case ignores it, the body is untouched', async () => {
  const seen: number[] = [];
  const up = await greedyUpstream(seen);
  const policy = testPolicy({
    upstream: up.url,
    editRoutes: (routes) => {
      routes.find((x) => x.name === 'claude-code')!.reserveOutputTokens = 200;
    },
  });
  const g = await gw(policy);
  const body = Buffer.from(JSON.stringify({ model: 'claude-opus-5-5', max_tokens: 128_000, messages: [{ role: 'user', content: 'hi' }] }));
  const r = await send(g.url, { path: '/v1/messages', headers: authHeaders, body });
  expect(r.status).toBe(200);
  await expect.poll(() => g.outcomes.length).toBe(1);
  const o = g.outcomes[0]!;
  expect(seen[0]).toBe(128_000);
  expect(o.overrun).toBe(false);
  expect(o.costMicroUsd ?? 0).toBeLessThanOrEqual(o.reservedMicroUsd ?? 0);
});

test('A1c the cap is written byte-faithfully: only the max_tokens value changes', async () => {
  const bodies: Buffer[] = [];
  const up = await raw(async (req, res) => {
    const { raw: b } = await readJson(req);
    bodies.push(b);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'm', type: 'message', model: 'claude-haiku-5-5', content: [], usage: { input_tokens: 5, output_tokens: 100 } }));
  });
  const policy = testPolicy({
    upstream: up.url,
    extraKeys: [serviceKey],
    editRoutes: (routes) => {
      const r = routes.find((x) => x.name === 'product-default');
      if (r) r.reserveOutputTokens = 100;
    },
  });
  const g = await gw(policy);
  const sent = '{ "model" : "claude-haiku-5-5",\n  "max_tokens" :  64000 , "messages":[{"role":"user","content":"x \\u00e9"}]}';
  const r = await send(g.url, { path: '/v1/messages', headers: { ...authHeaders, 'x-api-key': SERVICE_KEY }, body: sent });
  expect(r.status).toBe(200);
  expect(bodies[0]?.toString()).toBe(sent.replace('64000', '100'));
  // A smaller max_tokens is left as it is.
  await send(g.url, { path: '/v1/messages', headers: { ...authHeaders, 'x-api-key': SERVICE_KEY }, body: sent.replace('64000', '50') });
  expect(bodies[1]?.toString()).toBe(sent.replace('64000', '50'));
});

test('A1d Responses: a missing max_output_tokens is inserted at the cap on a product route', async () => {
  const bodies: Buffer[] = [];
  const up = await raw(async (req, res) => {
    const { raw: b } = await readJson(req);
    bodies.push(b);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'r', object: 'response', model: 'gpt-5.4', status: 'completed', output: [], usage: { input_tokens: 10, output_tokens: 300 } }));
  });
  const policy = testPolicy({
    upstream: 'http://127.0.0.1:9',
    openaiUpstream: up.url,
    extraKeys: [serviceKey],
    editRoutes: (routes) => {
      routes.unshift({ name: 'product-responses', match: { traffic: 'product', surface: 'openai-responses' }, chain: ['openai'], allowModels: ['gpt-5.4'], reserveOutputTokens: 300 });
    },
  });
  const g = await gw(policy);
  const r = await send(g.url, { path: '/v1/responses', headers: { 'content-type': 'application/json', 'x-api-key': SERVICE_KEY }, body: '{"model":"gpt-5.4","input":"hi"}' });
  expect(r.status).toBe(200);
  expect(JSON.parse(bodies[0]!.toString())).toEqual({ max_output_tokens: 300, model: 'gpt-5.4', input: 'hi' });
  await expect.poll(() => g.outcomes.length).toBe(1);
  expect(g.outcomes[0]?.overrun).toBe(false);
});

test('A1e validate: reserveOutputTokens on a header-selectable route without body rewrite is an error', async () => {
  const { loadPolicyDir } = await import('../../src/policy-loader/load-dir.js');
  const { validatePolicy } = await import('../../src/policy/validate.js');
  const r = validatePolicy(await loadPolicyDir('test/fixtures/policy/E_RESERVE_OUTPUT_NO_REWRITE'), { experimentalSubscription: false });
  expect(r.errors.map((e) => e.code)).toEqual(['E_RESERVE_OUTPUT_NO_REWRITE']);
});
