import { afterEach, expect, test } from 'vitest';
import { authHeaders, msgBody, send, startStack } from '../../helpers/conformance.js';

let stack: Awaited<ReturnType<typeof startStack>> | undefined;
afterEach(async () => {
  await stack?.close();
  stack = undefined;
});

test('C14 no content-encoding on SSE responses and X-Accel-Buffering: no present [https://code.claude.com/docs/en/llm-gateway-protocol.md]', async () => {
  stack = await startStack();
  const res = await send(stack.gw.url, {
    path: '/v1/messages',
    headers: { ...authHeaders, 'accept-encoding': 'gzip, deflate, br, zstd' },
    body: msgBody({ stream: true }),
  });
  expect(res.status).toBe(200);
  expect(res.headers['content-type']).toBe('text/event-stream');
  expect(res.headers['content-encoding']).toBeUndefined();
  expect(res.headers['x-accel-buffering']).toBe('no');
  expect(res.body.toString()).toContain('event: message_stop');
  expect(stack.mock.received[0]?.headers['accept-encoding']).toBe('identity');
});
