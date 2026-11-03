// S6 (coordinator finding, Task 6, MEDIUM): `t.models[model]` resolved prototype keys (__proto__, constructor,
// toString), so a request naming such a model got a non-price object, the cost became NaN or undefined and a
// comparison against a budget fail open. Own-property lookups only; an unpriced name is refused under enforced budgets.
import { afterEach, expect, test } from 'vitest';
import { startAnthropicMock } from '../../src/mock/anthropic.js';
import { reservationPrice, worstCaseMicroUsd } from '../../src/limits/estimator.js';
import { lookupModel } from '../../src/pricing/prices.js';
import { authHeaders, msgBody, send } from '../helpers/conformance.js';
import { features } from '../policy/helpers.js';
import { testPolicy } from '../helpers/policy.js';
import { loadPrices } from '../helpers/prices.js';
import { closeAll, closers, gw } from './common.js';

afterEach(closeAll);
const NAMES = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf', 'constructor-20261102'];

test('S6 no prototype member resolves to a model price', () => {
  const t = loadPrices();
  for (const n of NAMES) expect(lookupModel(t, n), n).toBeNull();
});

test('S6 the worst-case reservation of a prototype-key model name is a finite integer', () => {
  const t = loadPrices();
  for (const n of NAMES) {
    const { price } = reservationPrice(t, n);
    const est = worstCaseMicroUsd(features({ model: n }), price, t, { serverToolsWithoutMaxUses: 'block', assumedMaxUses: 25, reserveOutputTokens: null }).micro;
    expect(Number.isSafeInteger(est) && est > 0, `${n}: ${est}`).toBe(true);
  }
});

test('S6 a prototype-key model on a gateway route with an enforced budget is refused and never forwarded', async () => {
  const mock = await startAnthropicMock();
  closers.push(mock.close);
  const g = await gw(testPolicy({ upstream: mock.url }));
  for (const model of NAMES) {
    const r = await send(g.url, { path: '/v1/messages', headers: authHeaders, body: msgBody({ model }) });
    expect(r.status, model).toBe(403);
  }
  expect(mock.received).toHaveLength(0);
});
