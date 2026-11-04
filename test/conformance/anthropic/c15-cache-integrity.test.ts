import { afterEach, expect, test } from 'vitest';
import { cacheIntegrity, runSession, startStack } from '../../helpers/conformance.js';
import { startNaiveProxy } from '../../helpers/naive-proxy.js';

let stack: Awaited<ReturnType<typeof startStack>> | undefined;
let naive: Awaited<ReturnType<typeof startNaiveProxy>> | undefined;
afterEach(async () => {
  await naive?.close();
  await stack?.close();
  stack = naive = undefined;
});

test('C15 40-turn session: usage identical through tokenyard and direct [https://code.claude.com/docs/en/llm-gateway-protocol.md]', async () => {
  stack = await startStack();
  const direct = await runSession(stack.mock.url, 'ws-sanity');
  expect(direct).toHaveLength(40);
  // The session really exercises the cache, so identical usage is not identical zeros.
  expect(direct.slice(1).every((u) => u.cacheRead > 0)).toBe(true);
  expect(direct.some((u) => u.cacheWrite5m > 0)).toBe(true);
  expect(await cacheIntegrity(stack.gw.url, stack.mock.url)).toBe(true);
});

test('C15b the naive proxy fails the cache integrity check [https://code.claude.com/docs/en/llm-gateway-protocol.md]', async () => {
  stack = await startStack();
  naive = await startNaiveProxy(stack.mock.url);
  // It flattens system to a string, which drops the cache_control breakpoint on the system block.
  expect(await cacheIntegrity(naive.url, stack.mock.url)).toBe(false);
});
