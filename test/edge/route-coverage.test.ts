// Spec 7.4 coverage: every inference route goes through the same admit hook. LiteLLM's budget bypasses were coverage
// gaps (pass-through routes, another client path), not maths, so this enumerates the route table and sends a real
// request down each path.
import { readFileSync } from 'node:fs';
import { afterEach, expect, test } from 'vitest';
import { ROUTE_TABLE } from '../../src/edge/paths.js';
import { createMemoryStore } from '../../src/limits/memory-store.js';
import { startAnthropicMock } from '../../src/mock/anthropic.js';
import { authHeaders, msgBody, send } from '../helpers/conformance.js';
import { startGateway } from '../helpers/gateway.js';
import { PROVIDER_KEY_ENV, testPolicy } from '../helpers/policy.js';
import { spyStore } from '../helpers/store-spy.js';

const ROUTES_SOURCE = readFileSync(new URL('../../src/edge/paths.ts', import.meta.url), 'utf8');
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  delete process.env[PROVIDER_KEY_ENV];
});

test('the route table lists messages as inference and count_tokens, models and hello as not', () => {
  const by = (m: string, p: string) => ROUTE_TABLE.find((r) => r.method === m && r.path === p)?.inference;
  expect(by('POST', '/v1/messages')).toBe(true);
  expect(by('POST', '/v1/messages/count_tokens')).toBe(false);
  expect(by('GET', '/v1/models')).toBe(false);
  expect(by('HEAD', '/api/hello')).toBe(false);
  expect(ROUTE_TABLE.filter((r) => r.inference).length).toBeGreaterThan(0);
  // Stated per route, never derived: a route added later must say whether it runs a model.
  expect(ROUTES_SOURCE).toMatch(/inference: true/);
  expect(ROUTES_SOURCE).not.toMatch(/inference: r\.surface/);
});

test('every inference route in ROUTE_TABLE calls admit; no other route does', async () => {
  process.env[PROVIDER_KEY_ENV] = 'k';
  const mock = await startAnthropicMock();
  closers.push(mock.close);
  const spy = spyStore(createMemoryStore({ clock: Date.now }));
  const gw = await startGateway({ policy: testPolicy({ upstream: mock.url }), store: spy.store });
  closers.push(gw.close);
  for (const r of ROUTE_TABLE) {
    // With and without the `/v1` mount prefix: both reach the same surface.
    for (const path of r.path.startsWith('/v1/') ? [r.path, r.path.slice(3)] : [r.path]) {
      const before = spy.admits.length;
      const settlesBefore = spy.settles.length;
      const res = await send(gw.url, { method: r.method, path: `${path}?beta=true`, headers: { ...authHeaders, 'x-claude-code-session-id': 'sess-1' }, ...(r.method === 'POST' ? { body: msgBody({ model: 'claude-haiku-5-5' }) } : {}) });
      expect(res.status, `${r.method} ${path}`).toBe(200);
      if (r.inference) {
        expect(spy.admits.length, `${r.method} ${path} must call admit`).toBe(before + 1);
        expect(spy.admits.at(-1)?.plan.reservations.length).toBeGreaterThan(0);
        await expect.poll(() => spy.settles.length).toBe(settlesBefore + 1);
      } else {
        expect(spy.admits.length, `${r.method} ${path} must not call admit`).toBe(before);
      }
    }
  }
});
