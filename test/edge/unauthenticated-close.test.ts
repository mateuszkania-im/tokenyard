// FR-M6 (final review): a 401 or 404 is answered before the body is read. A request whose body has not fully arrived
// by then gets `connection: close` and the socket is closed, so an unauthenticated client cannot keep a connection
// busy uploading a body the gateway only drains; a body that already arrived keeps the connection open.
import { connect } from 'node:net';
import { afterEach, expect, test } from 'vitest';
import { startGateway, type TestGateway } from '../helpers/gateway.js';
import { testPolicy } from '../helpers/policy.js';

let gw: TestGateway | undefined;
afterEach(async () => {
  await gw?.close();
  gw = undefined;
});

/** Writes `head` and `body` on a raw socket; resolves with what came back and whether the server closed the socket. */
function exchange(url: string, head: string, body: string, waitMs = 1_500): Promise<{ text: string; closed: boolean }> {
  const u = new URL(url);
  return new Promise((resolve) => {
    const s = connect(Number(u.port), u.hostname);
    let text = '';
    let closed = false;
    s.on('data', (c: Buffer) => (text += c.toString()));
    s.on('error', () => undefined);
    s.on('close', () => {
      closed = true;
      clearTimeout(timer);
      resolve({ text, closed });
    });
    const timer = setTimeout(() => {
      s.destroy();
      resolve({ text, closed });
    }, waitMs);
    s.write(head + body);
  });
}

const post = (path: string, length: number, key = 'ty_live_wrong'): string =>
  `POST ${path} HTTP/1.1\r\nhost: localhost\r\ncontent-type: application/json\r\nx-api-key: ${key}\r\ncontent-length: ${length}\r\n\r\n`;

test('FR-M6 a 401 before the body arrived closes the connection', async () => {
  gw = await startGateway({ policy: testPolicy({ upstream: 'http://127.0.0.1:1' }) });
  const r = await exchange(gw.url, post('/v1/messages', 10_000_000), '{"model":"');
  expect(r.text).toMatch(/^HTTP\/1\.1 401 /);
  expect(r.text.toLowerCase()).toContain('connection: close');
  expect(r.closed).toBe(true);
});

test('FR-M6 a 404 before the body arrived closes the connection', async () => {
  gw = await startGateway({ policy: testPolicy({ upstream: 'http://127.0.0.1:1' }) });
  const r = await exchange(gw.url, post('/v1/nowhere', 10_000_000), '{"model":"');
  expect(r.text).toMatch(/^HTTP\/1\.1 404 /);
  expect(r.text.toLowerCase()).toContain('connection: close');
  expect(r.closed).toBe(true);
});

test('FR-M6 a 401 for a body that already arrived keeps the connection open', async () => {
  gw = await startGateway({ policy: testPolicy({ upstream: 'http://127.0.0.1:1' }) });
  const body = '{"model":"claude-haiku-5-5","max_tokens":8,"messages":[]}';
  const r = await exchange(gw.url, post('/v1/messages', Buffer.byteLength(body)), body, 500);
  expect(r.text).toMatch(/^HTTP\/1\.1 401 /);
  expect(r.text.toLowerCase()).toContain('connection: keep-alive');
  expect(r.closed).toBe(false);
});
