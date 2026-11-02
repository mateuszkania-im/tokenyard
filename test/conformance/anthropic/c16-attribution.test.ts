import { afterEach, expect, test } from 'vitest';
import { authHeaders, msgBody, send, startStack } from '../../helpers/conformance.js';

let stack: Awaited<ReturnType<typeof startStack>> | undefined;
afterEach(async () => {
  await stack?.close();
  stack = undefined;
});

test('C16 Claude Code attribution headers are forwarded to upstream (trace parsing lands with Tasks 6 and 7) [https://code.claude.com/docs/en/llm-gateway-protocol.md]', async () => {
  stack = await startStack();
  const attribution = {
    'x-claude-code-session-id': '11111111-2222-3333-4444-555555555555',
    'x-claude-code-agent-id': 'agent-abc',
    'x-claude-code-parent-agent-id': 'agent-parent',
    'x-claude-code-request-class': 'subagent',
    'x-claude-code-agent-type': 'general-purpose',
    'x-claude-code-prompt-id': 'prompt-xyz',
  };
  const res = await send(stack.gw.url, { path: '/v1/messages?beta=true', headers: { ...authHeaders, ...attribution }, body: msgBody() });
  expect(res.status).toBe(200);
  const h = stack.mock.received[0]?.headers ?? {};
  for (const [k, v] of Object.entries(attribution)) expect(h[k], k).toBe(v);
});
