import { afterEach, beforeEach, expect, test } from 'vitest';
import { authHeaders, msgBody, send, startStack } from '../../helpers/conformance.js';

let stack: Awaited<ReturnType<typeof startStack>>;
beforeEach(async () => {
  stack = await startStack();
});
afterEach(async () => {
  await stack.close();
});

test('C2 anthropic-version and anthropic-beta forwarded verbatim, other headers unchanged [https://code.claude.com/docs/en/llm-gateway-protocol.md]', async () => {
  const betas = [
    'oauth-2025-04-20,claude-code-20250219,interleaved-thinking-2025-05-14',
    'extended-cache-ttl-2025-04-11',
    'context-management-2025-06-27, totally-unknown-beta-2099-12-31',
    'fine-grained-tool-streaming-2025-05-14',
  ];
  for (const beta of betas) {
    await send(stack.gw.url, {
      path: '/v1/messages',
      headers: {
        ...authHeaders,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': beta,
        'anthropic-dangerous-direct-browser-access': 'true',
        'user-agent': 'claude-cli/2.1.316 (external, cli)',
        'x-app': 'cli',
        'x-stainless-lang': 'js',
        'x-future-header': 'kept-as-is',
      },
      body: msgBody(),
    });
    const h = stack.mock.received.at(-1)?.headers ?? {};
    expect(h['anthropic-beta']).toBe(beta);
    expect(h['anthropic-version']).toBe('2023-06-01');
    expect(h['anthropic-dangerous-direct-browser-access']).toBe('true');
    expect(h['user-agent']).toBe('claude-cli/2.1.316 (external, cli)');
    expect(h['x-app']).toBe('cli');
    expect(h['x-stainless-lang']).toBe('js');
    expect(h['x-future-header']).toBe('kept-as-is');
  }
});
