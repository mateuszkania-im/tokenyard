import { request } from 'node:http';
import { afterEach, expect, test } from 'vitest';
import { authHeaders, msgBody, startRawUpstream, startStack } from '../../helpers/conformance.js';

let up: Awaited<ReturnType<typeof startRawUpstream>> | undefined;
let stack: Awaited<ReturnType<typeof startStack>> | undefined;
afterEach(async () => {
  await stack?.close();
  await up?.close();
  up = stack = undefined;
});

/** Milliseconds until the response headers and until the first body chunk arrive; the request is then dropped. */
function firstByteTimes(base: string): Promise<{ headersAt: number; firstChunkAt: number; firstChunk: string }> {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const u = new URL(base);
    const req = request({ host: u.hostname, port: u.port, method: 'POST', path: '/v1/messages', headers: authHeaders }, (res) => {
      const headersAt = Date.now() - t0;
      res.once('data', (c: Buffer) => {
        resolve({ headersAt, firstChunkAt: Date.now() - t0, firstChunk: c.toString() });
        req.destroy();
      });
    });
    req.on('error', () => undefined);
    req.on('close', () => reject(new Error('closed before data')));
    req.end(msgBody({ stream: true }));
  });
}

test('C6 message_start reaches the client before a 2 s upstream pause ends [https://code.claude.com/docs/en/llm-gateway-protocol.md]', async () => {
  stack = await startStack({ mock: { scenario: { kind: 'pauseAfterStart', pauseMs: 2000 } } });
  const r = await firstByteTimes(stack.gw.url);
  expect(r.firstChunk).toContain('message_start');
  expect(r.firstChunkAt).toBeLessThan(1000);
});

test('C6 response headers are flushed before the first upstream body byte [https://code.claude.com/docs/en/llm-gateway-protocol.md]', async () => {
  up = await startRawUpstream((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.flushHeaders();
    setTimeout(() => res.end('event: message_start\ndata: {"type":"message_start"}\n\n'), 2000);
  });
  stack = await startStack({ upstream: up.url });
  const r = await firstByteTimes(stack.gw.url);
  expect(r.headersAt).toBeLessThan(1000);
  expect(r.firstChunkAt).toBeGreaterThanOrEqual(1900);
});
