import { afterEach, beforeEach, expect, test } from 'vitest';
import { authHeaders, loadFixtures, send, startStack } from '../../helpers/conformance.js';
import { startNaiveProxy } from '../../helpers/naive-proxy.js';
import { auditBudgets } from '../../helpers/policy.js';

let stack: Awaited<ReturnType<typeof startStack>>;
beforeEach(async () => {
  // Some fixtures name models the example table does not price (claude-sonnet-5): no enforced budget level here, so
  // the bytes check covers them (an unpriced model is refused under an enforced level, docs/conformance.md).
  stack = await startStack({ policy: { edit: auditBudgets } });
});
afterEach(async () => {
  await stack.close();
});

const fixtures = loadFixtures();

test('fixtures cover every body shape named in spec 10.1', () => {
  const names = fixtures.map((f) => f.name).join(' ');
  for (const part of ['cache-control', 'block-form-system', 'mid-conversation-system-role', 'thinking', 'output-config', 'context-management', 'strict-defer', 'unknown-top-level', 'unicode-property']) {
    expect(names).toContain(part);
  }
});

test('C1 body bytes upstream equal client bytes for every fixture [https://code.claude.com/docs/en/llm-gateway-protocol.md]', async () => {
  for (const f of fixtures) {
    const res = await send(stack.gw.url, { path: '/v1/messages?beta=true', headers: authHeaders, body: f.bytes });
    expect(res.status, f.name).toBe(200);
    expect(stack.mock.received.at(-1)?.body.equals(f.bytes), f.name).toBe(true);
  }
  expect(stack.mock.received).toHaveLength(fixtures.length);
});

test('C1b the naive proxy fails the same byte check, so the check can fail [https://code.claude.com/docs/en/llm-gateway-protocol.md]', async () => {
  const naive = await startNaiveProxy(stack.mock.url);
  try {
    let changed = 0;
    for (const f of fixtures) {
      await send(naive.url, { path: '/v1/messages?beta=true', headers: authHeaders, body: f.bytes });
      if (!stack.mock.received.at(-1)?.body.equals(f.bytes)) changed++;
    }
    expect(changed).toBe(fixtures.length);
  } finally {
    await naive.close();
  }
});
