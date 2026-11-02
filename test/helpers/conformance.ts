import { readdirSync, readFileSync } from 'node:fs';
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { buildAgentSession } from '../../src/mock/session-fixture.js';
import { AnthropicUsageAccumulator, type Usage } from '../../src/stream/anthropic-usage.js';
import { SseParser } from '../../src/stream/sse.js';
import { startAnthropicMock, type MockServer } from '../../src/mock/anthropic.js';
import { startGateway, type TestGateway } from './gateway.js';
import { PROVIDER_KEY_ENV, TEST_KEY, testPolicy } from './policy.js';

export interface Sent {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

/** One request, whole response collected. */
export function send(
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

/** Like `send`, but a response cut short by the server resolves with the bytes received so far. */
export function sendTolerant(base: string, path: string, headers: Record<string, string>, body: Buffer): Promise<Sent> {
  return new Promise((resolve) => {
    const u = new URL(base);
    const req = request({ host: u.hostname, port: u.port, method: 'POST', path, headers }, (res) => {
      const chunks: Buffer[] = [];
      const done = (): void => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) });
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', done);
      res.on('error', done);
      res.on('close', done);
    });
    req.on('error', () => undefined);
    req.end(body);
  });
}

export const authHeaders = {
  'x-api-key': TEST_KEY,
  'content-type': 'application/json',
  'anthropic-version': '2023-06-01',
};

export const msgBody = (extra: Record<string, unknown> = {}): Buffer =>
  Buffer.from(JSON.stringify({ model: 'claude-test', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }], ...extra }));

/** Every body in test/conformance/fixtures, byte for byte as stored. */
export function loadFixtures(): Array<{ name: string; bytes: Buffer }> {
  const dir = join(import.meta.dirname, '..', 'conformance', 'fixtures');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => ({ name: f, bytes: readFileSync(join(dir, f)) }));
}

/** A tiny upstream for byte-level and timing tests, independent of the mock. */
export async function startRawUpstream(
  handler: Parameters<typeof createServer>[1],
): Promise<{ url: string; close(): Promise<void>; server: Server }> {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    server,
    close: () =>
      new Promise((r) => {
        server.close(() => r());
        server.closeAllConnections();
      }),
  };
}

/** Usage and stop state of a whole SSE byte stream, parsed the way the gateway's tap does. */
export function parseSse(bytes: Buffer): ReturnType<AnthropicUsageAccumulator['result']> {
  const parser = new SseParser();
  const acc = new AnthropicUsageAccumulator();
  for (const e of parser.push(bytes)) acc.onEvent(e);
  return acc.result();
}

const TURNS = 40;

/** Streams the recorded 40-turn session to `base` in its own mock workspace and returns usage per turn. */
export async function runSession(base: string, workspace: string): Promise<Usage[]> {
  const out: Usage[] = [];
  for (const body of buildAgentSession(TURNS, 7)) {
    const res = await send(base, {
      path: '/v1/messages?beta=true',
      headers: { ...authHeaders, 'x-mock-workspace': workspace },
      body,
    });
    const r = parseSse(res.body);
    if (!r.usage) throw new Error('no usage in response');
    out.push(r.usage);
  }
  return out;
}

/**
 * The cache integrity check (conformance item 15): the session sent through `viaUrl` must produce the
 * same usage on every turn as the same session sent straight to the mock at `mockUrl`.
 */
export async function cacheIntegrity(viaUrl: string, mockUrl: string): Promise<boolean> {
  const direct = await runSession(mockUrl, 'ws-direct');
  const via = await runSession(viaUrl, 'ws-via');
  return JSON.stringify(direct) === JSON.stringify(via);
}

/** Gateway in front of the mock (or any upstream url), with the provider key env var set; `close` undoes it. */
export async function startStack(
  o: { upstream?: string; mock?: Parameters<typeof startAnthropicMock>[0]; policy?: Partial<Parameters<typeof testPolicy>[0]>; basePath?: string } = {},
): Promise<{ mock: MockServer; gw: TestGateway; close(): Promise<void> }> {
  process.env[PROVIDER_KEY_ENV] = PROVIDER_KEY;
  const mock = await startAnthropicMock(o.mock);
  const gw = await startGateway({
    policy: testPolicy({ upstream: o.upstream ?? mock.url, ...o.policy }),
    basePath: o.basePath ?? null,
  });
  return {
    mock,
    gw,
    async close() {
      await gw.close();
      await mock.close();
      delete process.env[PROVIDER_KEY_ENV];
    },
  };
}

export const PROVIDER_KEY = 'sk-provider-test-value';
