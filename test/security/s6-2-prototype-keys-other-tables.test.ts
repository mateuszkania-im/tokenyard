// S6 checklist (Task 25): prototype-key lookups on every user-keyed table, not only the model price table. The tables
// a client reaches are the key lookup (the presented key), server tool prices and route lists (`tools[].type`), the
// service tier prices (`service_tier` on Responses), the geo multiplier (`inference_geo`) and the budget, rate and taint keys built
// from attribution headers (session, repo). A prototype member name in any of them must neither authenticate, nor
// price at NaN or undefined, nor dodge a budget. Mock upstreams only.
import { afterEach, expect, test } from 'vitest';
import { startAnthropicMock } from '../../src/mock/anthropic.js';
import type { PolicyDoc } from '../../src/policy/schema.js';
import type { PriceTable } from '../../src/pricing/prices.js';
import { authHeaders, codexHeaders, msgBody, respBody, send, startOpenAIStack } from '../helpers/conformance.js';
import { testPolicy } from '../helpers/policy.js';
import { closeAll, closers, gw, raw, readJson } from './common.js';

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
  // Prototype-named attribution and geo are no block by themselves: every request reached the upstream.
  expect(mock.received.length).toBe(NAMES.length);
  expect(g.outcomes.every((o) => o.status === 200)).toBe(true);
});

/**
 * Enforced session and repo budgets whose scope value is a prototype member name. The upstream holds every request
 * open, so the first request's reservation stays on the level; the limit is 1.5 reservations, so a second request with
 * the same value must be refused by that budget, while a request with an ordinary value is still admitted.
 */
for (const scope of ['session', 'repo'] as const) {
  test(`S6-2 an enforced ${scope} budget keyed by a prototype member name still blocks past its limit`, async () => {
    const header = scope === 'session' ? 'x-claude-code-session-id' : 'x-tokenyard-repo';
    const held: Array<() => void> = [];
    let onHeld: () => void = () => undefined;
    const up = await raw(async (req, res) => {
      await readJson(req);
      queueMicrotask(() => onHeld());
      held.push(() => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'm', type: 'message', model: 'claude-haiku-5-5', content: [], usage: { input_tokens: 1, output_tokens: 1 } })));
    });
    closers.push(async () => {
      for (const h of held.splice(0)) h();
    });
    const withBudget = (usd: number) =>
      testPolicy({
        upstream: up.url,
        models: ['claude-haiku-5-5'],
        edit: (p: PolicyDoc) => {
          p.budgets = [{ name: `per-${scope}`, scope, usd, onExceed: 'block', mode: 'enforce', ...(scope === 'repo' ? { window: 'day' } : {}) }];
        },
      });
    // The reservation of one request, measured on a gateway with a large limit.
    const probe = await gw(withBudget(1000));
    const first = send(probe.url, { path: '/v1/messages', headers: { ...authHeaders, [header]: 'probe' }, body: msgBody() });
    await expect.poll(() => held.length).toBe(1);
    held.splice(0).forEach((h) => h());
    await first;
    await expect.poll(() => probe.outcomes.length).toBe(1);
    const reserved = probe.outcomes[0]?.reservedMicroUsd ?? 0;
    expect(reserved).toBeGreaterThan(0);

    const g = await gw(withBudget((reserved * 1.5) / 1_000_000));
    for (const n of ['__proto__', 'constructor', 'toString']) {
      const headers = { ...authHeaders, [header]: n };
      const pending = send(g.url, { path: '/v1/messages', headers, body: msgBody() });
      await expect.poll(() => held.length).toBe(1);
      // Either the gateway answers (refused) or the request reaches the held upstream (the budget did not apply).
      const reply = send(g.url, { path: '/v1/messages', headers, body: msgBody() });
      const forwarded = new Promise<null>((r) => {
        onHeld = () => r(null);
      });
      const second = await Promise.race([reply, forwarded]);
      onHeld = () => undefined;
      expect(second === null ? 'forwarded past the budget' : second.status, n).toBe(429);
      expect(JSON.parse((second as Awaited<typeof reply>).body.toString()).error.message, n).toContain(`per-${scope}`);
      // An ordinary value has its own level and is admitted beside the held request.
      const other = send(g.url, { path: '/v1/messages', headers: { ...authHeaders, [header]: `ordinary-${n}` }, body: msgBody() });
      await expect.poll(() => held.length).toBe(2);
      held.splice(0).forEach((h) => h());
      expect((await pending).status, n).toBe(200);
      expect((await other).status, n).toBe(200);
    }
  });
}
