import { afterEach, expect, test } from 'vitest';
import { authHeaders, send, startStack } from '../../helpers/conformance.js';

let stack: Awaited<ReturnType<typeof startStack>> | undefined;
afterEach(async () => {
  await stack?.close();
  stack = undefined;
});

test('C13 HEAD /api/hello does not error the client; count_tokens is forwarded [https://code.claude.com/docs/en/llm-gateway-protocol.md]', async () => {
  stack = await startStack();
  const hello = await send(stack.gw.url, { method: 'HEAD', path: '/api/hello' });
  expect(hello.status).toBe(200);
  expect(hello.body.length).toBe(0);
  const body = Buffer.from('{"model":"claude-test","messages":[{"role":"user","content":"count these tokens please"}]}');
  const res = await send(stack.gw.url, { path: '/v1/messages/count_tokens?beta=true', headers: authHeaders, body });
  expect(res.status).toBe(200);
  expect(JSON.parse(res.body.toString()).input_tokens).toBeGreaterThan(0);
  expect(stack.mock.received).toHaveLength(1);
  expect(stack.mock.received[0]?.pathAndQuery).toBe('/v1/messages/count_tokens?beta=true');
  expect(stack.mock.received[0]?.body.equals(body)).toBe(true);
});
