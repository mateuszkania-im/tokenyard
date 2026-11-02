import { afterEach, expect, test } from 'vitest';
import { startStack } from '../../helpers/conformance.js';
import { TEST_KEY } from '../../helpers/policy.js';

let stack: Awaited<ReturnType<typeof startStack>> | undefined;
afterEach(async () => {
  await stack?.close();
  stack = undefined;
});

test('C12 GET /v1/models?limit=1000 answers 200 without redirect, only ids containing claude, in under 3 s [https://code.claude.com/docs/en/llm-gateway-protocol.md]', async () => {
  stack = await startStack({ policy: { models: ['claude-opus-5-5', 'gpt-5', 'claude-haiku-5', 'gemini-3'] } });
  const t0 = Date.now();
  const res = await fetch(`${stack.gw.url}/v1/models?limit=1000`, { headers: { 'x-api-key': TEST_KEY }, redirect: 'manual' });
  expect(Date.now() - t0).toBeLessThan(3000);
  expect(res.status).toBe(200);
  expect(res.headers.get('location')).toBeNull();
  const json = (await res.json()) as { data: Array<{ id: string }> };
  expect(json.data.map((m) => m.id)).toEqual(['claude-opus-5-5', 'claude-haiku-5']);
});
