// S6 checklist (Task 25): prototype-key lookups on every user-keyed table, not only the model price table. The tables
// a client reaches are the key lookup (the presented key), server tool prices and route lists (`tools[].type`), the
// service tier prices (`service_tier` on Responses), the geo multiplier (`inference_geo`) and the budget, rate and taint keys built
// from attribution headers (session, repo). A prototype member name in any of them must neither authenticate, nor
// price at NaN or undefined, nor dodge a budget. Mock upstreams only.
import { afterEach, expect, test } from 'vitest';
import { startAnthropicMock } from '../../src/mock/anthropic.js';
import type { PriceTable } from '../../src/pricing/prices.js';
import { authHeaders, codexHeaders, msgBody, respBody, send, startOpenAIStack } from '../helpers/conformance.js';
import { testPolicy } from '../helpers/policy.js';
import { closeAll, closers, gw } from './common.js';

afterEach(closeAll);
const NAMES = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf'];

async function setup() {
  const mock = await startAnthropicMock();
  closers.push(mock.close);
  const g = await gw(testPolicy({ upstream: mock.url, models: ['claude-haiku-5-5'] }));
  return { mock, g };
}

test('S6-2 a prototype member name as the presented key never authenticates', async () => {
  const { mock, g } = await setup();
  for (const k of NAMES) {
    const variants: Array<Record<string, string>> = [{ ...authHeaders, 'x-api-key': k }, { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', authorization: `Bearer ${k}` }];
    for (const headers of variants) {
      const r = await send(g.url, { path: '/v1/messages', headers, body: msgBody() });
      expect(r.status, k).toBe(401);
    }
  }
  expect(mock.received).toHaveLength(0);
});

test('S6-2 a prototype member name as a server tool type is refused, never priced from the prototype', async () => {
  const { mock, g } = await setup();
  for (const type of NAMES) {
    const r = await send(g.url, { path: '/v1/messages', headers: authHeaders, body: msgBody({ tools: [{ type, name: 'x', max_uses: 1 }] }) });
    expect(r.status, type).toBe(403);
  }
  expect(mock.received).toHaveLength(0);
});

test('S6-2 a prototype member name as the service tier is refused as unpriced when the model lists tier prices', async () => {
  // S20-1 covers a model without tier prices; here the model has a serviceTiers table a prototype name could reach.
  const withTiers = (t: PriceTable): void => {
    const m = t.models['gpt-5.4-mini'];
    if (!m) throw new Error('gpt-5.4-mini is not priced');
    m.serviceTiers = { priority: { input: m.input * 2, output: m.output * 2, cacheWrite5m: m.cacheWrite5m * 2, cacheWrite1h: m.cacheWrite1h * 2, cacheRead: m.cacheRead * 2, source: 'test', retrieved: 'test' } };
  };
  const stack = await startOpenAIStack({ policy: { editPrices: withTiers } });
  closers.push(stack.close);
  for (const tier of NAMES) {
    const r = await send(stack.gw.url, { path: '/v1/responses', headers: codexHeaders, body: respBody({ service_tier: tier }) });
    expect(r.status, tier).toBe(403);
    expect(JSON.parse(r.body.toString()).error.code, tier).toBe('unpriced');
  }
  expect(stack.mock.received).toHaveLength(0);
});

test('S6-2 prototype member names as inference_geo and attribution headers keep every reservation and cost a finite integer', async () => {
  const { mock, g } = await setup();
  for (const n of NAMES) {
    const headers = { ...authHeaders, 'x-claude-code-session-id': n, 'x-tokenyard-repo': n, 'x-tokenyard-feature': n, 'x-claude-code-agent-type': n };
    const r = await send(g.url, { path: '/v1/messages', headers, body: msgBody({ inference_geo: n }) });
    expect(r.status, n).toBeLessThan(500);
  }
  expect(g.outcomes).toHaveLength(NAMES.length);
  for (const o of g.outcomes) {
    if (o.reservedMicroUsd !== undefined) expect(Number.isSafeInteger(o.reservedMicroUsd) && o.reservedMicroUsd > 0, `reserved ${o.reservedMicroUsd}`).toBe(true);
    if (o.costMicroUsd !== null) expect(Number.isSafeInteger(o.costMicroUsd) && o.costMicroUsd >= 0, `cost ${o.costMicroUsd}`).toBe(true);
    // Forwarded requests carry a reservation: a prototype name never turns the budget levels off.
    if (o.status === 200) expect(o.reservedMicroUsd ?? 0).toBeGreaterThan(0);
  }
  // At least one request with prototype-named attribution reached the upstream (the geo is not a block by itself).
  expect(mock.received.length + g.outcomes.filter((o) => o.status !== 200).length).toBe(NAMES.length);
});
