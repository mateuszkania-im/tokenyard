import { afterEach, expect, test } from 'vitest';
import { authHeaders, msgBody, send, startStack } from '../../helpers/conformance.js';

let stack: Awaited<ReturnType<typeof startStack>> | undefined;
afterEach(async () => {
  await stack?.close();
  stack = undefined;
});

test('C3 /v1/messages?beta=true keeps its query; base path with and without the /v1 mount prefix [https://code.claude.com/docs/en/llm-gateway-protocol.md]', async () => {
  stack = await startStack({ basePath: '/gw' });
  const cases: Array<[string, string]> = [
    ['/gw/v1/messages?beta=true', '/v1/messages?beta=true'],
    ['/gw/messages?beta=true', '/v1/messages?beta=true'],
    ['/gw/v1/messages', '/v1/messages'],
    ['/gw/v1/messages/count_tokens?beta=true', '/v1/messages/count_tokens?beta=true'],
    ['/gw/messages/count_tokens', '/v1/messages/count_tokens'],
  ];
  for (const [inbound, expected] of cases) {
    const res = await send(stack.gw.url, { path: inbound, headers: authHeaders, body: msgBody() });
    expect(res.status, inbound).toBe(200);
    expect(stack.mock.received.at(-1)?.pathAndQuery, inbound).toBe(expected);
  }
});

test('C3 without a base path /v1/messages and /messages both reach /v1/messages with the query intact [https://code.claude.com/docs/en/llm-gateway-protocol.md]', async () => {
  stack = await startStack();
  for (const inbound of ['/v1/messages?beta=true', '/messages?beta=true']) {
    const res = await send(stack.gw.url, { path: inbound, headers: authHeaders, body: msgBody() });
    expect(res.status, inbound).toBe(200);
    expect(stack.mock.received.at(-1)?.pathAndQuery).toBe('/v1/messages?beta=true');
  }
});
