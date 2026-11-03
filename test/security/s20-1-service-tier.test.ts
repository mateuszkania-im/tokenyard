// S20-1 (coordinator budget finding, Task 20, MEDIUM): a non-standard service_tier (priority, flex, fast, scale or an
// unknown one) was priced as standard, so a client could pick a pricier tier and under-reserve. Such a request is
// refused (unpriced, x-should-retry false) unless the model has explicit tier prices; when priced, the reservation
// and the settlement use that tier's price, and "auto" reserves at the highest tier the model has.
import { afterEach, expect, test } from 'vitest';
import type { RequestOutcome } from '../../src/edge/handler.js';
import { createMemoryStore } from '../../src/limits/memory-store.js';
import type { PriceTable } from '../../src/pricing/prices.js';
import { codexHeaders, respBody, send, startOpenAIStack } from '../helpers/conformance.js';
import { spyStore } from '../helpers/store-spy.js';

let stack: Awaited<ReturnType<typeof startOpenAIStack>> | undefined;
afterEach(async () => {
  await stack?.close();
  stack = undefined;
});

const withTiers = (t: PriceTable): void => {
  const m = t.models['gpt-5.4-mini'];
  if (!m) throw new Error('gpt-5.4-mini is not priced');
  const scaled = (k: number) => ({ input: m.input * k, output: m.output * k, cacheWrite5m: m.cacheWrite5m * k, cacheWrite1h: m.cacheWrite1h * k, cacheRead: m.cacheRead * k, source: 'test', retrieved: 'test' });
  m.serviceTiers = { priority: scaled(2), flex: scaled(0.5) };
};

test('S20-1 priority, flex, fast, scale and unknown tiers are refused when the model has no tier prices', async () => {
  stack = await startOpenAIStack();
  for (const tier of ['priority', 'flex', 'fast', 'scale', 'turbo-unknown', 'constructor', '__proto__']) {
    const res = await send(stack.gw.url, { path: '/v1/responses', headers: codexHeaders, body: respBody({ service_tier: tier }) });
    expect(res.status, tier).toBe(403);
    expect(JSON.parse(res.body.toString()).error.code, tier).toBe('unpriced');
    expect(res.headers['x-should-retry']).toBe('false');
  }
  expect(stack.mock.received).toHaveLength(0);
});

test('S20-1 a priced tier reserves at its own price and auto reserves at the highest tier', async () => {
  const spy = spyStore(createMemoryStore({ clock: Date.now }));
  const settled: RequestOutcome[] = [];
  stack = await startOpenAIStack({ policy: { editPrices: withTiers }, gw: { store: spy.store, onSettled: (o) => settled.push(o) } });
  const est = async (tier: string): Promise<number> => {
    const res = await send(stack!.gw.url, { path: '/v1/responses', headers: codexHeaders, body: respBody({ service_tier: tier, user: 'u'.repeat(10 - tier.length) }) });
    expect(res.status, tier).toBe(200);
    await expect.poll(() => settled.length).toBe(spy.admits.length);
    return spy.admits.at(-1)?.plan.reservations[0]?.estMicroUsd ?? -1;
  };
  const standard = await est('default');
  const priority = await est('priority');
  const flex = await est('flex');
  const auto = await est('auto');
  expect(Math.abs(priority - 2 * standard)).toBeLessThanOrEqual(1);
  expect(Math.abs(flex - standard / 2)).toBeLessThanOrEqual(1);
  expect(auto).toBe(priority);
  expect(priority).toBeGreaterThan(standard);
});
