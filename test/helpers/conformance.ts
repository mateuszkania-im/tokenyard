import { readdirSync, readFileSync } from 'node:fs';
import { type Agent, createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { buildAgentSession } from '../../src/mock/session-fixture.js';
import { AnthropicUsageAccumulator, type Usage } from '../../src/stream/anthropic-usage.js';
import { SseParser } from '../../src/stream/sse.js';
import { startAnthropicMock, type MockServer } from '../../src/mock/anthropic.js';
import { startOpenAIMock, type OpenAIMockServer } from '../../src/mock/openai.js';
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
  o: { method?: string; path: string; headers?: Record<string, string>; body?: Buffer | string; agent?: Agent },
): Promise<Sent> {
  return new Promise((resolve, reject) => {
    const u = new URL(base);
    const req = request(
      { host: u.hostname, port: u.port, method: o.method ?? 'POST', path: o.path, headers: o.headers ?? {}, ...(o.agent ? { agent: o.agent } : {}) },
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
  o: {
    upstream?: string;
    mock?: Parameters<typeof startAnthropicMock>[0];
    policy?: Partial<Parameters<typeof testPolicy>[0]>;
    basePath?: string;
    gw?: Pick<Parameters<typeof startGateway>[0], 'experimentalSubscription' | 'onSettled' | 'traces' | 'traceSalt' | 'store' | 'runtime' | 'metrics' | 'spans' | 'opsListener'>;
  } = {},
): Promise<{ mock: MockServer; gw: TestGateway; close(): Promise<void> }> {
  process.env[PROVIDER_KEY_ENV] = PROVIDER_KEY;
  const mock = await startAnthropicMock(o.mock);
  const gw = await startGateway({
    policy: testPolicy({ upstream: o.upstream ?? mock.url, ...o.policy }),
    basePath: o.basePath ?? null,
    ...o.gw,
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

/** Headers Codex sends with `wire_api = "responses"` (values replaced; the session header is read as attribution). */
export const codexHeaders = {
  authorization: `Bearer ${TEST_KEY}`,
  'content-type': 'application/json',
  accept: 'text/event-stream',
  originator: 'codex_exec',
  version: '0.130.0',
  session_id: '0199a0b0-0000-7000-8000-000000000001',
  'user-agent': 'codex_exec/0.130.0 (Mac OS 26.0.0; arm64) unknown',
};

/** A Responses request body as Codex shapes it: instructions, input items, tools, no max_output_tokens. */
export const respBody = (extra: Record<string, unknown> = {}): Buffer =>
  Buffer.from(
    JSON.stringify({
      model: 'gpt-5.4-mini',
      instructions: 'You are a coding agent.',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'say hi' }] }],
      tools: [{ type: 'function', name: 'shell', description: 'run a command', strict: false, parameters: { type: 'object', properties: { command: { type: 'array', items: { type: 'string' } } } } }],
      tool_choice: 'auto',
      parallel_tool_calls: false,
      reasoning: { effort: 'low', summary: 'auto' },
      store: false,
      stream: true,
      include: ['reasoning.encrypted_content'],
      prompt_cache_key: '0199a0b0-0000-7000-8000-000000000001',
      ...extra,
    }),
  );

/** Gateway in front of the OpenAI mock: the `openai` provider points at it, the Anthropic providers at a dead port. */
export async function startOpenAIStack(
  o: {
    mock?: Parameters<typeof startOpenAIMock>[0];
    policy?: Partial<Parameters<typeof testPolicy>[0]>;
    gw?: Pick<Parameters<typeof startGateway>[0], 'onSettled' | 'traces' | 'traceSalt' | 'store' | 'runtime' | 'bodyCapBytes'>;
  } = {},
): Promise<{ mock: OpenAIMockServer; gw: TestGateway; close(): Promise<void> }> {
  process.env[PROVIDER_KEY_ENV] = PROVIDER_KEY;
  const mock = await startOpenAIMock(o.mock);
  const gw = await startGateway({ policy: testPolicy({ upstream: 'http://127.0.0.1:9', openaiUpstream: mock.url, ...o.policy }), ...o.gw });
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
