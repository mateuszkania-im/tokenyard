import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { startAnthropicMock, type MockServer } from '../../src/mock/anthropic.js';
import type { CounterStore } from '../../src/limits/store.js';
import { startGateway, type TestGateway } from '../helpers/gateway.js';
import { auditBudgets, PROVIDER_KEY_ENV, TEST_KEY, testPolicy } from '../helpers/policy.js';

const PROVIDER_KEY = 'sk-provider-test-value';

let mock: MockServer | undefined;
let gw: TestGateway | undefined;
let upstream: Server | undefined;

beforeEach(() => {
  process.env[PROVIDER_KEY_ENV] = PROVIDER_KEY;
});
afterEach(async () => {
  await gw?.close();
  await mock?.close();
  if (upstream) {
    const u = upstream;
    await new Promise<void>((r) => {
      u.close(() => r());
      u.closeAllConnections();
    });
  }
  gw = mock = upstream = undefined;
  delete process.env[PROVIDER_KEY_ENV];
});

interface Sent {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

function send(
  base: string,
  o: { method?: string; path: string; headers?: Record<string, string>; body?: Buffer | string },
): Promise<Sent> {
  return new Promise((resolve, reject) => {
    const u = new URL(base);
    const req = request(
      { host: u.hostname, port: u.port, method: o.method ?? 'POST', path: o.path, headers: o.headers ?? {} },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(o.body);
  });
}

const auth = { 'x-api-key': TEST_KEY, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' };
const msgBody = (extra: Record<string, unknown> = {}): Buffer =>
  Buffer.from(
    JSON.stringify({ model: 'claude-haiku-5-5', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }], ...extra }),
  );

async function withMock(o: Partial<Parameters<typeof testPolicy>[0]> = {}): Promise<{ mock: MockServer; gw: TestGateway }> {
  mock = await startAnthropicMock();
  gw = await startGateway({ policy: testPolicy({ upstream: mock.url, ...o }) });
  return { mock, gw };
}

/** A tiny upstream for timing tests, so the mock's ttft (which also delays headers) is not involved. */
async function startUpstream(
  handler: Parameters<typeof createServer>[1],
): Promise<string> {
  upstream = createServer(handler);
  await new Promise<void>((r) => upstream?.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
}

test('upstream receives the exact body bytes and the query string', async () => {
  const { mock, gw } = await withMock();
  // Odd spacing, key order, unicode and an escaped \p{...} pattern: any re-serialisation would change these bytes.
  const body = Buffer.from(
    '{ "model":"claude-haiku-5-5","max_tokens":64,  "system":[{"type":"text","text":"zażółć \\u0041","cache_control":{"type":"ephemeral"}}],' +
      '"tools":[{"name":"t","input_schema":{"type":"object","properties":{"p":{"type":"string","pattern":"^\\\\p{L}+$"}}}}],' +
      '"messages":[{"role":"user","content":"hi"}],"unknown_field":{"z":1,"a":2}}',
  );
  const res = await send(gw.url, { path: '/v1/messages?beta=true', headers: auth, body });
  expect(res.status).toBe(200);
  expect(mock.received).toHaveLength(1);
  expect(mock.received[0]?.pathAndQuery).toBe('/v1/messages?beta=true');
  expect(mock.received[0]?.body.equals(body)).toBe(true);
});

test('hop-by-hop, host, accept-encoding and x-tokenyard-* are not forwarded; anthropic-beta verbatim', async () => {
  const { mock, gw } = await withMock();
  const beta = 'interleaved-thinking-2025-05-14,extended-cache-ttl-2025-04-11, unknown-beta-2099-01-01';
  await send(gw.url, {
    path: '/v1/messages',
    headers: {
      ...auth,
      connection: 'keep-alive, x-custom-hop',
      'x-custom-hop': 'drop-me',
      'keep-alive': 'timeout=5',
      te: 'trailers',
      'proxy-authorization': 'Basic abc',
      'accept-encoding': 'gzip, br',
      'x-tokenyard-tag': 'internal',
      'anthropic-beta': beta,
      'x-claude-code-session-id': 'sess-1',
      'user-agent': 'claude-cli/2.1.316 (external, cli)',
      'x-unknown-header': 'kept',
    },
    body: msgBody(),
  });
  const h = mock.received[0]?.headers ?? {};
  expect(h['anthropic-beta']).toBe(beta);
  expect(h['anthropic-version']).toBe('2023-06-01');
  expect(h['x-claude-code-session-id']).toBe('sess-1');
  expect(h['user-agent']).toBe('claude-cli/2.1.316 (external, cli)');
  expect(h['x-unknown-header']).toBe('kept');
  expect(h['accept-encoding']).toBe('identity');
  expect(h.host).toBe(new URL(mock.url).host);
  expect(h['x-custom-hop']).toBeUndefined();
  expect(h['keep-alive']).toBeUndefined();
  expect(h.te).toBeUndefined();
  expect(h['proxy-authorization']).toBeUndefined();
  expect(h['x-tokenyard-tag']).toBeUndefined();
  expect(h.connection).not.toBe('keep-alive, x-custom-hop');
});

test('API mode replaces the inbound credential with the provider key', async () => {
  const { mock, gw } = await withMock();
  await send(gw.url, { path: '/v1/messages', headers: auth, body: msgBody() });
  await send(gw.url, {
    path: '/v1/messages',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TEST_KEY}` },
    body: msgBody(),
  });
  await send(gw.url, {
    path: '/v1/messages',
    headers: { 'content-type': 'application/json', 'x-tokenyard-key': TEST_KEY, authorization: 'Bearer client-oauth' },
    body: msgBody(),
  });
  expect(mock.received).toHaveLength(3);
  for (const r of mock.received) {
    expect(r.headers['x-api-key']).toBe(PROVIDER_KEY);
    expect(r.headers.authorization).toBeUndefined();
    expect(r.headers['x-tokenyard-key']).toBeUndefined();
  }
});

test('unknown key gets 401 in the Anthropic envelope and nothing reaches upstream', async () => {
  const { mock, gw } = await withMock();
  const res = await send(gw.url, { path: '/v1/messages', headers: { 'x-api-key': 'ty_live_wrong' }, body: msgBody() });
  expect(res.status).toBe(401);
  expect(JSON.parse(res.body.toString())).toEqual({
    type: 'error',
    error: { type: 'authentication_error', message: expect.stringMatching(/^tokenyard: /) },
  });
  expect(res.headers['x-tokenyard-request-id']).toBe('req_000001');
  expect(mock.received).toHaveLength(0);
});

test('headers flushed before first body byte; X-Accel-Buffering: no; no content-encoding', async () => {
  const url = await startUpstream((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.flushHeaders();
    setTimeout(() => res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n'), 1000);
  });
  gw = await startGateway({ policy: testPolicy({ upstream: url }) });
  const t0 = Date.now();
  const r = await new Promise<{ headersAt: number; headers: IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    const u = new URL(gw?.url ?? '');
    const req = request({ host: u.hostname, port: u.port, method: 'POST', path: '/v1/messages', headers: auth }, (res) => {
      const headersAt = Date.now() - t0;
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ headersAt, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end(msgBody({ stream: true }));
  });
  expect(r.headersAt).toBeLessThan(500);
  expect(r.headers['x-accel-buffering']).toBe('no');
  expect(r.headers['content-encoding']).toBeUndefined();
  expect(r.headers['content-type']).toBe('text/event-stream');
  expect(r.headers['x-tokenyard-request-id']).toBe('req_000001');
  expect(r.headers['x-tokenyard-policy-revision']).toBeTypeOf('string');
  expect(r.body.toString()).toBe('event: message_stop\ndata: {"type":"message_stop"}\n\n');
});

test('SSE bytes reach the client before the upstream pause ends', async () => {
  mock = await startAnthropicMock({ scenario: { kind: 'pauseAfterStart', pauseMs: 1500 } });
  gw = await startGateway({ policy: testPolicy({ upstream: mock.url }) });
  const t0 = Date.now();
  const firstAt = await new Promise<number>((resolve, reject) => {
    const u = new URL(gw?.url ?? '');
    const req = request({ host: u.hostname, port: u.port, method: 'POST', path: '/v1/messages', headers: auth }, (res) => {
      res.once('data', (c: Buffer) => {
        expect(c.toString()).toContain('message_start');
        resolve(Date.now() - t0);
        req.destroy();
      });
    });
    req.on('error', () => undefined);
    req.on('close', () => reject(new Error('closed before data')));
    req.end(msgBody({ stream: true }));
  });
  expect(firstAt).toBeLessThan(1000);
});

test('client abort closes the upstream connection within 100 ms', async () => {
  const rejections: unknown[] = [];
  const onRejection = (e: unknown): void => void rejections.push(e);
  process.on('unhandledRejection', onRejection);
  try {
    let upstreamClosedAt = 0;
    let markUpstreamClosed: () => void = () => undefined;
    const upstreamClosed = new Promise<void>((resolve) => (markUpstreamClosed = resolve));
    const url = await startUpstream((req, res) => {
      req.resume();
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5}}}\n\n');
      res.on('close', () => {
        upstreamClosedAt = Date.now();
        markUpstreamClosed();
      });
    });
    gw = await startGateway({ policy: testPolicy({ upstream: url }) });
    const u = new URL(gw.url);
    let abortedAt = 0;
    const req = request({ host: u.hostname, port: u.port, method: 'POST', path: '/v1/messages', headers: auth }, (res) => {
      res.once('data', () => {
        abortedAt = Date.now();
        req.destroy();
      });
    });
    req.on('error', () => undefined);
    req.end(msgBody({ stream: true }));
    await upstreamClosed;
    expect(abortedAt).toBeGreaterThan(0);
    expect(upstreamClosedAt - abortedAt).toBeLessThan(100);
    await new Promise((r) => setTimeout(r, 50));
    expect(rejections).toEqual([]);
  } finally {
    process.off('unhandledRejection', onRejection);
  }
});

test('client abort before upstream headers aborts the upstream request', async () => {
  const rejections: unknown[] = [];
  const onRejection = (e: unknown): void => void rejections.push(e);
  process.on('unhandledRejection', onRejection);
  try {
    let received = false;
    let markUpstreamClosed: () => void = () => undefined;
    const upstreamClosed = new Promise<void>((resolve) => (markUpstreamClosed = resolve));
    const url = await startUpstream((req, res) => {
      received = true;
      req.resume();
      res.on('close', () => markUpstreamClosed()); // never answers: like hangBeforeHeaders
    });
    gw = await startGateway({ policy: testPolicy({ upstream: url }) });
    const u = new URL(gw.url);
    const req = request({ host: u.hostname, port: u.port, method: 'POST', path: '/v1/messages', headers: auth });
    req.on('error', () => undefined);
    req.end(msgBody({ stream: true }));
    await new Promise((r) => setTimeout(r, 100));
    expect(received).toBe(true);
    const abortedAt = Date.now();
    req.destroy();
    await upstreamClosed;
    expect(Date.now() - abortedAt).toBeLessThan(100);
    await new Promise((r) => setTimeout(r, 50));
    expect(rejections).toEqual([]);
  } finally {
    process.off('unhandledRejection', onRejection);
  }
});

test('upstream 529 body, status and retry-after reach the client unchanged', async () => {
  const { mock, gw } = await withMock();
  const errBody = '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';
  mock.setScenario({
    kind: 'status',
    status: 529,
    headers: {
      'retry-after': '7',
      'x-should-retry': 'true',
      'anthropic-ratelimit-unified-status': 'rejected',
      'request-id': 'req_upstream_1',
    },
    body: errBody,
  });
  const res = await send(gw.url, { path: '/v1/messages', headers: auth, body: msgBody() });
  expect(res.status).toBe(529);
  expect(res.body.toString()).toBe(errBody);
  expect(res.headers['retry-after']).toBe('7');
  expect(res.headers['x-should-retry']).toBe('true');
  expect(res.headers['anthropic-ratelimit-unified-status']).toBe('rejected');
  expect(res.headers['request-id']).toBe('req_upstream_1');
  expect(res.headers['content-type']).toBe('application/json');
});

test('body over cap gets 413 in the Anthropic envelope', async () => {
  mock = await startAnthropicMock();
  gw = await startGateway({ policy: testPolicy({ upstream: mock.url }), bodyCapBytes: 1024 });
  const res = await send(gw.url, { path: '/v1/messages', headers: auth, body: Buffer.alloc(4096, 0x20) });
  expect(res.status).toBe(413);
  const parsed = JSON.parse(res.body.toString());
  expect(parsed.type).toBe('error');
  expect(parsed.error.type).toBe('request_too_large');
  expect(parsed.error.message).toMatch(/^tokenyard: /);
  expect(res.headers['x-tokenyard-request-id']).toBe('req_000001');
  expect(mock.received).toHaveLength(0);
});

test('GET /v1/models?limit=1000 lists only the models the key routes allow, no redirect, under 3 s', async () => {
  mock = await startAnthropicMock();
  gw = await startGateway({
    policy: testPolicy({ upstream: mock.url, models: ['claude-sonnet-5-5*', 'claude-haiku-*'] }),
  });
  const t0 = Date.now();
  const res = await fetch(`${gw.url}/v1/models?limit=1000`, { headers: { 'x-api-key': TEST_KEY }, redirect: 'manual' });
  expect(Date.now() - t0).toBeLessThan(3000);
  expect(res.status).toBe(200);
  const json = (await res.json()) as { data: Array<{ id: string; type: string }>; has_more: boolean };
  expect(json.data.map((m) => m.id)).toEqual(['claude-sonnet-5-5', 'claude-haiku-5-5']);
  expect(json.data.every((m) => m.type === 'model')).toBe(true);
  expect(json.has_more).toBe(false);
  expect(mock.received).toHaveLength(0);
});

test('HEAD /api/hello returns empty 200; count_tokens is forwarded without reservation', async () => {
  const calls: string[] = [];
  const store: CounterStore = {
    admit: async () => {
      calls.push('admit');
      throw new Error('admit must not be called');
    },
    settle: async () => {
      calls.push('settle');
      return 'unknown';
    },
    sweep: async () => 0,
    snapshot: async () => ({}),
    seed: async () => undefined,
  };
  mock = await startAnthropicMock();
  gw = await startGateway({ policy: testPolicy({ upstream: mock.url }), store });
  const hello = await send(gw.url, { method: 'HEAD', path: '/api/hello' });
  expect(hello.status).toBe(200);
  expect(hello.body.length).toBe(0);
  const body = Buffer.from('{"model":"claude-haiku-5-5","messages":[{"role":"user","content":"hello world"}]}');
  const res = await send(gw.url, { path: '/v1/messages/count_tokens?beta=true', headers: auth, body });
  expect(res.status).toBe(200);
  expect(JSON.parse(res.body.toString()).input_tokens).toBeGreaterThan(0);
  expect(mock.received).toHaveLength(1);
  expect(mock.received[0]?.pathAndQuery).toBe('/v1/messages/count_tokens?beta=true');
  expect(mock.received[0]?.body.equals(body)).toBe(true);
  expect(calls).toEqual([]);
  // The same store is called for a messages request, so the assertion above is not vacuous.
  await send(gw.url, { path: '/v1/messages?beta=true', headers: auth, body });
  expect(calls).toEqual(['admit']);
});

test('invalid JSON body is forwarded unchanged and the provider 400 reaches the client when no enforced budget applies', async () => {
  const { mock, gw } = await withMock({ edit: auditBudgets });
  const errBody = '{"type":"error","error":{"type":"invalid_request_error","message":"messages: invalid JSON"}}';
  mock.setScenario(() => ({ kind: 'status', status: 400, headers: {}, body: errBody }));
  const body = Buffer.from('{"model":"claude-haiku-5-5", "messages": [ {"role":"user",');
  const res = await send(gw.url, { path: '/v1/messages', headers: auth, body });
  expect(mock.received[0]?.body.equals(body)).toBe(true);
  expect(res.status).toBe(400);
  expect(res.body.toString()).toBe(errBody);
});

test('unknown path gets 404 and an unreachable upstream gets 502, both in the Anthropic envelope', async () => {
  gw = await startGateway({ policy: testPolicy({ upstream: 'http://127.0.0.1:1' }) });
  const nf = await send(gw.url, { path: '/v1/other', headers: auth, body: msgBody() });
  expect(nf.status).toBe(404);
  expect(JSON.parse(nf.body.toString()).error.type).toBe('not_found_error');
  const down = await send(gw.url, { path: '/v1/messages', headers: auth, body: msgBody() });
  expect(down.status).toBe(502);
  expect(JSON.parse(down.body.toString()).error.type).toBe('api_error');
});

test('base path is stripped before matching and not forwarded', async () => {
  mock = await startAnthropicMock();
  gw = await startGateway({ policy: testPolicy({ upstream: mock.url }), basePath: '/gw' });
  const res = await send(gw.url, { path: '/gw/v1/messages?beta=true', headers: auth, body: msgBody() });
  expect(res.status).toBe(200);
  expect(mock.received[0]?.pathAndQuery).toBe('/v1/messages?beta=true');
  const outside = await send(gw.url, { path: '/v1/messages', headers: auth, body: msgBody() });
  expect(outside.status).toBe(404);
});
