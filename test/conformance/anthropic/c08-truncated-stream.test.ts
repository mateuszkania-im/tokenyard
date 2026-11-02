import { afterEach, expect, test } from 'vitest';
import { authHeaders, msgBody, parseSse, send, sendTolerant, startStack } from '../../helpers/conformance.js';
import { startAnthropicMock, type MockServer } from '../../../src/mock/anthropic.js';

let stack: Awaited<ReturnType<typeof startStack>> | undefined;
let direct: MockServer | undefined;
afterEach(async () => {
  await stack?.close();
  await direct?.close();
  stack = direct = undefined;
});

test('C8 truncated upstream stream reaches the client truncated, no synthesised message_stop, usage partial [https://code.claude.com/docs/en/llm-gateway-protocol.md]', async () => {
  const scenario = { kind: 'drop', afterEvents: 5 } as const;
  direct = await startAnthropicMock({ scenario });
  stack = await startStack({ mock: { scenario } });
  const body = msgBody({ stream: true });
  const want = await sendTolerant(direct.url, '/v1/messages', authHeaders, body);
  const got = await sendTolerant(stack.gw.url, '/v1/messages', authHeaders, body);
  expect(got.body.length).toBeGreaterThan(0);
  expect(got.body.equals(want.body)).toBe(true);
  expect(got.body.toString()).not.toContain('message_stop');
  const parsed = parseSse(got.body);
  expect(parsed.sawStop).toBe(false);
  // Cut mid-generation (no message_delta yet): usage is estimated from the streamed text, never zero.
  expect(parsed.source).toBe('estimated');
  expect(parsed.usage?.output).toBeGreaterThan(0);
  // The gateway keeps serving after the truncated stream.
  stack.mock.setScenario({ kind: 'ok', ttftMs: 0, tokensPerSec: 0, pingEveryMs: null, outputTokens: 4 });
  const after = await send(stack.gw.url, { path: '/v1/messages', headers: authHeaders, body });
  expect(after.status).toBe(200);
  expect(after.body.toString()).toContain('message_stop');
});

test('C8 stream cut after message_delta but before message_stop is usage partial with the reported counts [https://code.claude.com/docs/en/llm-gateway-protocol.md]', async () => {
  // 2 head events, 16 deltas, content_block_stop, message_delta, then message_stop (index 20) is never sent.
  const scenario = { kind: 'drop', afterEvents: 20 } as const;
  stack = await startStack({ mock: { scenario } });
  const got = await sendTolerant(stack.gw.url, '/v1/messages', authHeaders, msgBody({ stream: true }));
  expect(got.body.toString()).toContain('event: message_delta');
  expect(got.body.toString()).not.toContain('message_stop');
  const parsed = parseSse(got.body);
  expect(parsed.source).toBe('partial');
  expect(parsed.usage?.output).toBe(16);
});
