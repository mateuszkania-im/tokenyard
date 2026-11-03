import { afterEach, expect, test } from 'vitest';
import type { RequestOutcome } from '../../../src/edge/handler.js';
import { buildTraceRecord } from '../../../src/edge/trace-record.js';
import { createMemoryStore } from '../../../src/limits/memory-store.js';
import type { PriceTable } from '../../../src/pricing/prices.js';
import { codexHeaders, respBody, send, startOpenAIStack } from '../../helpers/conformance.js';
import { spyStore } from '../../helpers/store-spy.js';

let stack: Awaited<ReturnType<typeof startOpenAIStack>> | undefined;
afterEach(async () => {
  await stack?.close();
  stack = undefined;
});

/** Test-only tier prices on gpt-5.4-mini: priority at twice and flex at half the standard rates. */
const withTiers = (t: PriceTable): void => {
  const m = t.models['gpt-5.4-mini'];
  if (!m) throw new Error('gpt-5.4-mini is not priced');
  const scaled = (k: number) => ({ input: m.input * k, output: m.output * k, cacheWrite5m: m.cacheWrite5m * k, cacheWrite1h: m.cacheWrite1h * k, cacheRead: m.cacheRead * k, source: 'test', retrieved: 'test' });
  m.serviceTiers = { priority: scaled(2), flex: scaled(0.5) };
};

test('R8 a service tier without tier prices is refused, never priced as standard [https://developers.openai.com/api/docs/pricing]', async () => {
  stack = await startOpenAIStack();
  for (const tier of ['priority', 'flex', 'fast', 'scale', 'turbo-unknown']) {
    const res = await send(stack.gw.url, { path: '/v1/responses', headers: codexHeaders, body: respBody({ service_tier: tier }) });
    expect(res.status, tier).toBe(403);
    const e = JSON.parse(res.body.toString()) as { error: { type: string; code: string; message: string } };
    expect(e.error.code, tier).toBe('unpriced');
    expect(e.error.message).toMatch(/^tokenyard: /);
    expect(res.headers['x-should-retry']).toBe('false');
  }
  expect(stack.mock.received).toHaveLength(0);
  // default, auto and no tier are standard requests.
  for (const extra of [{ service_tier: 'default' }, { service_tier: 'auto' }, {}]) {
    expect((await send(stack.gw.url, { path: '/v1/responses', headers: codexHeaders, body: respBody(extra) })).status).toBe(200);
  }
});

test('R8b a priced tier reserves and settles at the tier price; auto reserves at the highest tier and settles at the tier served [https://developers.openai.com/api/docs/pricing]', async () => {
  const spy = spyStore(createMemoryStore({ clock: Date.now }));
  const settled: RequestOutcome[] = [];
  stack = await startOpenAIStack({ policy: { editPrices: withTiers }, gw: { store: spy.store, onSettled: (o) => settled.push(o) } });
  // Same body length for every request, so the bytes input bound is the same.
  const run = async (tier: string): Promise<{ est: number; o: RequestOutcome }> => {
    const body = respBody({ service_tier: tier, user: 'u'.repeat(10 - tier.length) });
    const res = await send(stack!.gw.url, { path: '/v1/responses', headers: codexHeaders, body });
    expect(res.status, tier).toBe(200);
    await expect.poll(() => settled.length).toBe(spy.admits.length);
    return { est: spy.admits.at(-1)?.plan.reservations[0]?.estMicroUsd ?? -1, o: settled.at(-1) as RequestOutcome };
  };
  const standard = await run('default');
  const priority = await run('priority');
  const flex = await run('flex');
  const auto = await run('auto');
  expect(Math.abs(priority.est - 2 * standard.est)).toBeLessThanOrEqual(1);
  expect(Math.abs(flex.est - standard.est / 2)).toBeLessThanOrEqual(1);
  expect(auto.est).toBe(priority.est);
  // Settled at the tier the response reports: priority at twice the standard cost, auto (served as default) at standard.
  const u = priority.o.usage?.usage;
  expect(u).toBeDefined();
  expect(priority.o.costMicroUsd).toBe(Math.round(2 * ((u?.input ?? 0) * 0.75 + (u?.cacheRead ?? 0) * 0.075 + (u?.output ?? 0) * 4.5)));
  expect(priority.o.settledAtEstimate).toBeUndefined();
  const a = auto.o.usage?.usage;
  expect(auto.o.costMicroUsd).toBe(Math.round((a?.input ?? 0) * 0.75 + (a?.cacheRead ?? 0) * 0.075 + (a?.output ?? 0) * 4.5));
  expect(auto.o.usage?.serviceTier).toBe('default');
  // The trace keeps both, so replay reserves and reprices the same way.
  const rec = buildTraceRecord(priority.o, 'salt', { prices: { version: 't', models: { 'gpt-5.4-mini': {} }, modifiers: {}, serverTools: {} } as unknown as PriceTable, routes: [] });
  expect(rec.features.serviceTier).toBe('priority');
  expect(rec.outcome.serviceTier).toBe('priority');
  const autoRec = buildTraceRecord(auto.o, 'salt', { prices: { version: 't', models: { 'gpt-5.4-mini': {} }, modifiers: {}, serverTools: {} } as unknown as PriceTable, routes: [] });
  expect(autoRec.features.serviceTier).toBe('auto');
  expect(autoRec.outcome.serviceTier).toBeUndefined();
});
