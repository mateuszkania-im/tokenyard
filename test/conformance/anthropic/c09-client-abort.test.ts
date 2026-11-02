import { request } from 'node:http';
import { afterEach, expect, test } from 'vitest';
import { authHeaders, msgBody, parseSse, startRawUpstream, startStack } from '../../helpers/conformance.js';

let up: Awaited<ReturnType<typeof startRawUpstream>> | undefined;
let stack: Awaited<ReturnType<typeof startStack>> | undefined;
afterEach(async () => {
  await stack?.close();
  await up?.close();
  up = stack = undefined;
});

test('C9 client abort closes the upstream connection within 100 ms and usage seen so far is not zero [https://code.claude.com/docs/en/llm-gateway-protocol.md]', async () => {
  let upstreamClosedAt = 0;
  let markClosed: () => void = () => undefined;
  const closed = new Promise<void>((r) => (markClosed = r));
  up = await startRawUpstream((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(
      'event: message_start\ndata: {"type":"message_start","message":{"model":"m","usage":{"input_tokens":120,"cache_read_input_tokens":30,"output_tokens":1}}}\n\n',
    );
    res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}\n\n');
    res.on('close', () => {
      upstreamClosedAt = Date.now();
      markClosed();
    });
  });
  stack = await startStack({ upstream: up.url });
  const u = new URL(stack.gw.url);
  let abortedAt = 0;
  const seen: Buffer[] = [];
  const req = request({ host: u.hostname, port: u.port, method: 'POST', path: '/v1/messages', headers: authHeaders }, (res) => {
    res.on('data', (c: Buffer) => {
      seen.push(c);
      if (Buffer.concat(seen).toString().includes('content_block_delta') && !abortedAt) {
        abortedAt = Date.now();
        req.destroy();
      }
    });
  });
  req.on('error', () => undefined);
  req.end(msgBody({ stream: true }));
  await closed;
  expect(abortedAt).toBeGreaterThan(0);
  expect(upstreamClosedAt - abortedAt).toBeLessThan(100);
  // What the stream had reported before the abort is usable usage, not zero (the settlement itself lands with Task 14).
  const partial = parseSse(Buffer.concat(seen));
  expect(partial.source).not.toBe('none');
  expect(partial.usage?.input).toBe(120);
  expect(partial.usage?.cacheRead).toBe(30);
});
