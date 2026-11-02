import { afterEach, expect, test } from 'vitest';
import type { RequestOutcome } from '../../../src/edge/server.js';
import { msgBody, send, startStack } from '../../helpers/conformance.js';
import { TEST_KEY } from '../../helpers/policy.js';

let stack: Awaited<ReturnType<typeof startStack>> | undefined;
afterEach(async () => {
  await stack?.close();
  stack = undefined;
});

const json = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' };
const OAUTH = 'Bearer sk-ant-test-CANARY-oauth-client-value';
const BETA = 'oauth-2025-04-20,claude-code-20250219';

async function subscriptionStack(): Promise<RequestOutcome[]> {
  const outcomes: RequestOutcome[] = [];
  stack = await startStack({
    policy: { credential: 'passthrough', billing: 'subscription' },
    gw: { experimentalSubscription: true, onSettled: (o) => outcomes.push(o) },
  });
  return outcomes;
}

test('C17 subscription passthrough: OAuth Authorization and anthropic-beta reach the mock unchanged, x-tokenyard-key stripped, cost basis api-equivalent [https://code.claude.com/docs/en/llm-gateway]', async () => {
  const outcomes = await subscriptionStack();
  const res = await send(stack!.gw.url, {
    path: '/v1/messages?beta=true',
    headers: { ...json, 'x-tokenyard-key': TEST_KEY, authorization: OAUTH, 'anthropic-beta': BETA },
    body: msgBody({ model: 'claude-opus-5-5' }),
  });
  expect(res.status).toBe(200);
  const h = stack!.mock.received[0]?.headers ?? {};
  expect(h.authorization).toBe(OAUTH);
  expect(h['anthropic-beta']).toBe(BETA);
  expect(h['x-tokenyard-key']).toBeUndefined();
  expect(h['x-api-key']).toBeUndefined();
  expect(JSON.stringify(h)).not.toContain(TEST_KEY);
  await expect.poll(() => outcomes.length).toBe(1);
  expect(outcomes[0]?.costBasis).toBe('api-equivalent');
  expect(outcomes[0]?.costMicroUsd).toBeGreaterThan(0);
});

test('C17 whichever header carries the ty_ key, it never reaches upstream, and the OAuth Authorization header does, unchanged [https://code.claude.com/docs/en/llm-gateway]', async () => {
  await subscriptionStack();
  const carriers: Array<{ name: string; headers: Record<string, string>; oauth: boolean }> = [
    { name: 'x-tokenyard-key', headers: { 'x-tokenyard-key': TEST_KEY, authorization: OAUTH }, oauth: true },
    { name: 'x-api-key', headers: { 'x-api-key': TEST_KEY, authorization: OAUTH }, oauth: true },
    { name: 'x-api-key and x-tokenyard-key', headers: { 'x-api-key': TEST_KEY, 'x-tokenyard-key': TEST_KEY, authorization: OAUTH }, oauth: true },
    { name: 'bearer', headers: { authorization: `Bearer ${TEST_KEY}` }, oauth: false },
  ];
  for (const c of carriers) {
    const before = stack!.mock.received.length;
    const res = await send(stack!.gw.url, { path: '/v1/messages', headers: { ...json, ...c.headers, 'anthropic-beta': BETA }, body: msgBody() });
    expect(res.status, c.name).toBe(200);
    const h = stack!.mock.received[before]?.headers ?? {};
    expect(JSON.stringify(h), c.name).not.toContain(TEST_KEY);
    expect(h.authorization, c.name).toBe(c.oauth ? OAUTH : undefined);
    expect(h['anthropic-beta'], c.name).toBe(BETA);
  }
});

test('C17b subscription key is refused (401) when the gateway runs without --experimental-subscription [https://code.claude.com/docs/en/llm-gateway]', async () => {
  stack = await startStack({ policy: { credential: 'passthrough', billing: 'subscription' } });
  const res = await send(stack.gw.url, {
    path: '/v1/messages',
    headers: { ...json, 'x-tokenyard-key': TEST_KEY, authorization: OAUTH },
    body: msgBody(),
  });
  expect(res.status).toBe(401);
  expect(JSON.parse(res.body.toString()).error.type).toBe('authentication_error');
  expect(stack.mock.received).toHaveLength(0);
});
