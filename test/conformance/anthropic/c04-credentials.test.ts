import { afterEach, expect, test } from 'vitest';
import { msgBody, PROVIDER_KEY, send, startStack } from '../../helpers/conformance.js';
import { TEST_KEY } from '../../helpers/policy.js';

let stack: Awaited<ReturnType<typeof startStack>> | undefined;
afterEach(async () => {
  await stack?.close();
  stack = undefined;
});

const json = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' };

test('C4 Bearer and x-api-key both accepted; in API mode the inbound credential never reaches upstream [https://code.claude.com/docs/en/llm-gateway-protocol.md]', async () => {
  stack = await startStack();
  for (const cred of [{ authorization: `Bearer ${TEST_KEY}` }, { 'x-api-key': TEST_KEY }] as Array<Record<string, string>>) {
    const res = await send(stack.gw.url, { path: '/v1/messages', headers: { ...json, ...cred }, body: msgBody() });
    expect(res.status).toBe(200);
  }
  expect(stack.mock.received).toHaveLength(2);
  for (const r of stack.mock.received) {
    expect(r.headers['x-api-key']).toBe(PROVIDER_KEY);
    expect(r.headers.authorization).toBeUndefined();
    expect(JSON.stringify(r.headers)).not.toContain(TEST_KEY);
  }
});

test('C4 in passthrough mode Authorization reaches upstream unchanged and x-tokenyard-key does not [https://code.claude.com/docs/en/llm-gateway-protocol.md]', async () => {
  stack = await startStack({ policy: { credential: 'passthrough' } });
  const oauth = 'Bearer sk-ant-oat01-client-oauth-value';
  const res = await send(stack.gw.url, {
    path: '/v1/messages',
    headers: { ...json, 'x-tokenyard-key': TEST_KEY, authorization: oauth, 'anthropic-beta': 'oauth-2025-04-20' },
    body: msgBody(),
  });
  expect(res.status).toBe(200);
  const h = stack.mock.received[0]?.headers ?? {};
  expect(h.authorization).toBe(oauth);
  expect(h['anthropic-beta']).toBe('oauth-2025-04-20');
  expect(h['x-tokenyard-key']).toBeUndefined();
  expect(JSON.stringify(h)).not.toContain(TEST_KEY);
});
