import { afterEach, expect, test } from 'vitest';
import { authHeaders, msgBody, parseSse, send, startStack } from '../../helpers/conformance.js';
import { startAnthropicMock, type MockServer } from '../../../src/mock/anthropic.js';

let stack: Awaited<ReturnType<typeof startStack>> | undefined;
let direct: MockServer | undefined;
afterEach(async () => {
  await stack?.close();
  await direct?.close();
  stack = direct = undefined;
});

test('C7 mid-stream error event (overloaded_error) after a 200 reaches the client unchanged and is counted [https://code.claude.com/docs/en/llm-gateway-protocol.md]', async () => {
  const scenario = { kind: 'midStreamError', afterEvents: 3, errorType: 'overloaded_error' } as const;
  direct = await startAnthropicMock({ scenario });
  stack = await startStack({ mock: { scenario } });
  const body = msgBody({ stream: true });
  const want = await send(direct.url, { path: '/v1/messages', headers: authHeaders, body });
  const got = await send(stack.gw.url, { path: '/v1/messages', headers: authHeaders, body });
  expect(got.status).toBe(200);
  expect(got.body.equals(want.body)).toBe(true);
  expect(got.body.toString()).toMatch(/event: error\ndata: \{"type":"error","error":\{"type":"overloaded_error"/);
  // The gateway's usage tap reads these same bytes: the error is what it records as midStreamError.
  expect(parseSse(got.body).midStreamError).toBe('overloaded_error');
});
