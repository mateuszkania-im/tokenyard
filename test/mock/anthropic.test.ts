import { request } from 'node:http';
import { afterEach, expect, test } from 'vitest';
import { startAnthropicMock, type MockServer } from '../../src/mock/anthropic.js';
import { buildAgentSession } from '../../src/mock/session-fixture.js';
import { SseParser, type SseEvent } from '../../src/stream/sse.js';
import { AnthropicUsageAccumulator, parseAnthropicJsonUsage } from '../../src/stream/anthropic-usage.js';

let mock: MockServer | undefined;
afterEach(async () => {
  await mock?.close();
  mock = undefined;
});

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  events: SseEvent[];
  aborted: boolean;
}

function post(url: string, path: string, body: string | Buffer, headers: Record<string, string> = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const u = new URL(path, url);
    const req = request(
      { host: u.hostname, port: u.port, path: u.pathname + u.search, method: 'POST', headers: { 'content-type': 'application/json', ...headers } },
      (res) => {
        const chunks: Buffer[] = [];
        let aborted = false;
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('aborted', () => (aborted = true));
        res.on('error', () => (aborted = true));
        res.on('close', () => {
          const buf = Buffer.concat(chunks);
          const events = new SseParser().push(buf);
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: buf, events, aborted: aborted || !res.complete });
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

const msg = (extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ model: 'claude-opus-5-5', max_tokens: 1000, messages: [{ role: 'user', content: 'hi there' }], ...extra });

const fast = { kind: 'ok', ttftMs: 0, tokensPerSec: 0, pingEveryMs: null, outputTokens: 12 } as const;

test('mock records method, path with query, headers and exact body bytes', async () => {
  mock = await startAnthropicMock({ scenario: fast });
  const body = Buffer.from('{"model":"m",  "max_tokens":5,"messages":[],"stream":false}');
  await post(mock.url, '/v1/messages?beta=true', body, { 'x-test': 'a', 'anthropic-beta': 'x,y' });
  expect(mock.received).toHaveLength(1);
  const r = mock.received[0]!;
  expect(r.method).toBe('POST');
  expect(r.pathAndQuery).toBe('/v1/messages?beta=true');
  expect(r.headers['x-test']).toBe('a');
  expect(r.headers['anthropic-beta']).toBe('x,y');
  expect(Buffer.compare(r.body, body)).toBe(0);
});

test('streams valid Anthropic SSE that the accumulator parses to the usage the mock computed', async () => {
  mock = await startAnthropicMock({ scenario: { ...fast, pingEveryMs: null, outputTokens: 37 } });
  const bodies = buildAgentSession(2, 1);
  const first = await post(mock.url, '/v1/messages', bodies[0] as Buffer);
  const acc = new AnthropicUsageAccumulator();
  first.events.forEach((e) => acc.onEvent(e));
  const r1 = acc.result();
  expect(r1.source).toBe('final');
  expect(r1.sawStop).toBe(true);
  expect(r1.usage?.output).toBe(37);
  expect(r1.usage?.cacheWrite5m).toBeGreaterThan(0);
  expect(r1.responseModel).toBe('claude-opus-5-5');
  expect(first.headers['content-type']).toContain('text/event-stream');
  const second = await post(mock.url, '/v1/messages', bodies[1] as Buffer);
  const acc2 = new AnthropicUsageAccumulator();
  second.events.forEach((e) => acc2.onEvent(e));
  expect(acc2.result().usage?.cacheRead).toBe((r1.usage!.cacheWrite5m ?? 0) + r1.usage!.cacheRead + r1.usage!.cacheWrite1h);
});

test('non-streaming returns a JSON message with the same usage', async () => {
  mock = await startAnthropicMock({ scenario: fast });
  const res = await post(mock.url, '/v1/messages', msg({ stream: false }));
  expect(res.status).toBe(200);
  const parsed = parseAnthropicJsonUsage(res.body);
  expect(parsed.usage?.output).toBe(12);
  expect(parsed.usage?.input).toBeGreaterThan(0);
});

test('count_tokens answers with a deterministic input_tokens', async () => {
  mock = await startAnthropicMock();
  const a = await post(mock.url, '/v1/messages/count_tokens', msg());
  const b = await post(mock.url, '/v1/messages/count_tokens', msg());
  expect(JSON.parse(a.body.toString()).input_tokens).toBeGreaterThan(0);
  expect(a.body.toString()).toBe(b.body.toString());
});

test('scenario 529 before headers, 429 with retry-after, drop after N events behave as scripted', async () => {
  mock = await startAnthropicMock({
    scenario: { kind: 'status', status: 529, headers: {}, body: '{"type":"error","error":{"type":"overloaded_error","message":"x"}}' },
  });
  const overloaded = await post(mock.url, '/v1/messages', msg({ stream: true }));
  expect(overloaded.status).toBe(529);
  expect(overloaded.body.toString()).toContain('overloaded_error');

  mock.setScenario({ kind: 'status', status: 429, headers: { 'retry-after': '7' }, body: '{"type":"error","error":{"type":"rate_limit_error","message":"x"}}' });
  const limited = await post(mock.url, '/v1/messages', msg({ stream: true }));
  expect(limited.status).toBe(429);
  expect(limited.headers['retry-after']).toBe('7');

  mock.setScenario({ kind: 'drop', afterEvents: 3 });
  const dropped = await post(mock.url, '/v1/messages', msg({ stream: true }));
  expect(dropped.events).toHaveLength(3);
  expect(dropped.aborted).toBe(true);
});

test('midStreamError emits an error event after N events and ends', async () => {
  mock = await startAnthropicMock({ scenario: { kind: 'midStreamError', afterEvents: 2, errorType: 'overloaded_error' } });
  const res = await post(mock.url, '/v1/messages', msg({ stream: true }));
  expect(res.status).toBe(200);
  expect(res.events).toHaveLength(3);
  expect(res.events[2]?.event).toBe('error');
  const acc = new AnthropicUsageAccumulator();
  res.events.forEach((e) => acc.onEvent(e));
  expect(acc.result().midStreamError).toBe('overloaded_error');
  expect(acc.result().sawStop).toBe(false);
});

test('ttft delays the first event and pings arrive on cadence', async () => {
  mock = await startAnthropicMock({ scenario: { kind: 'ok', ttftMs: 60, tokensPerSec: 100, pingEveryMs: 20, outputTokens: 10 } });
  const t0 = Date.now();
  const res = await post(mock.url, '/v1/messages', msg({ stream: true }));
  expect(Date.now() - t0).toBeGreaterThanOrEqual(55);
  expect(res.events[0]?.event).toBe('message_start');
  expect(res.events.filter((e) => e.event === 'ping').length).toBeGreaterThan(0);
});

test('pauseAfterStart stalls after message_start then completes', async () => {
  mock = await startAnthropicMock({ scenario: { kind: 'pauseAfterStart', pauseMs: 80 } });
  const t0 = Date.now();
  const res = await post(mock.url, '/v1/messages', msg({ stream: true }));
  expect(Date.now() - t0).toBeGreaterThanOrEqual(75);
  expect(res.events.at(-1)?.event).toBe('message_stop');
});

test('hangBeforeHeaders never answers; close() still resolves', async () => {
  mock = await startAnthropicMock({ scenario: { kind: 'hangBeforeHeaders' } });
  const p = post(mock.url, '/v1/messages', msg({ stream: true })).catch(() => null);
  await new Promise((r) => setTimeout(r, 50));
  expect(mock.received).toHaveLength(1);
  await mock.close();
  mock = undefined;
  await p;
});

test('scenario can be a function of the received request', async () => {
  mock = await startAnthropicMock();
  mock.setScenario((r) =>
    r.headers['x-fail'] === '1'
      ? { kind: 'status', status: 500, headers: {}, body: '{}' }
      : fast,
  );
  expect((await post(mock.url, '/v1/messages', msg(), { 'x-fail': '1' })).status).toBe(500);
  expect((await post(mock.url, '/v1/messages', msg())).status).toBe(200);
});

test('randomUsage returns input <= body bytes and output <= max_tokens, seeded', async () => {
  const run = async (seed: number) => {
    const m = await startAnthropicMock({ scenario: { kind: 'randomUsage', seed } });
    try {
      const out = [];
      for (let i = 0; i < 8; i++) {
        const body = msg({ max_tokens: 50 + i, stream: i % 2 === 0 });
        const res = await post(m.url, '/v1/messages', body);
        let usage;
        if (i % 2 === 0) {
          const acc = new AnthropicUsageAccumulator();
          res.events.forEach((e) => acc.onEvent(e));
          usage = acc.result().usage!;
        } else usage = parseAnthropicJsonUsage(res.body).usage!;
        const total = usage.input + usage.cacheRead + usage.cacheWrite5m + usage.cacheWrite1h;
        expect(total).toBeLessThanOrEqual(Buffer.byteLength(body));
        expect(usage.output).toBeLessThanOrEqual(50 + i);
        out.push(usage);
      }
      return out;
    } finally {
      await m.close();
    }
  };
  const a = await run(5);
  expect(await run(5)).toEqual(a);
  expect(await run(6)).not.toEqual(a);
});

test('40-turn session through the mock yields a deterministic usage sequence', async () => {
  let now = 1_000_000;
  mock = await startAnthropicMock({ scenario: { kind: 'ok', ttftMs: 0, tokensPerSec: 0, pingEveryMs: null, outputTokens: 25 }, now: () => now });
  const rows: string[] = [];
  for (const [i, body] of buildAgentSession(40, 2026).entries()) {
    now += i === 20 ? 6 * 60_000 : 15_000;
    const res = await post(mock.url, '/v1/messages', body);
    const acc = new AnthropicUsageAccumulator();
    res.events.forEach((e) => acc.onEvent(e));
    const u = acc.result().usage!;
    rows.push(`${i} in=${u.input} out=${u.output} read=${u.cacheRead} w5=${u.cacheWrite5m} w1=${u.cacheWrite1h}`);
  }
  expect(rows.join('\n')).toMatchSnapshot();
});

test('session fixture is deterministic and Claude Code shaped', () => {
  const a = buildAgentSession(4, 3);
  expect(a.map((b) => b.toString('hex'))).toEqual(buildAgentSession(4, 3).map((b) => b.toString('hex')));
  const body = JSON.parse((a[3] as Buffer).toString('utf8'));
  expect(Array.isArray(body.system)).toBe(true);
  expect(body.system.some((b: { cache_control?: unknown }) => b.cache_control)).toBe(true);
  expect(body.tools.length).toBeGreaterThan(0);
  expect(body.messages.length).toBeGreaterThan(JSON.parse((a[0] as Buffer).toString('utf8')).messages.length);
  expect(JSON.stringify(body)).toContain('"signature"');
});

test('200 responses carry x-mock-wait-ms, the mock\'s own wait before the headers (streaming and not)', async () => {
  mock = await startAnthropicMock({ scenario: { kind: 'ok', ttftMs: 30, tokensPerSec: 0, pingEveryMs: null, outputTokens: 4 } });
  for (const stream of [false, true]) {
    const r = await post(mock.url, '/v1/messages', JSON.stringify({ model: 'm', max_tokens: 8, stream, messages: [{ role: 'user', content: 'hi' }] }));
    const wait = Number(r.headers['x-mock-wait-ms']);
    expect(wait).toBeGreaterThanOrEqual(29);
    expect(wait).toBeLessThan(1000);
  }
});

test('V2 leak: keepReceived bounds the requests the mock keeps (the CLI mock keeps none)', async () => {
  mock = await startAnthropicMock({ scenario: fast, keepReceived: 2 });
  for (let i = 0; i < 5; i++) await post(mock.url, '/v1/messages', msg({ metadata: { user_id: `u${i}` } }));
  expect(mock.received.map((r) => JSON.parse(r.body.toString('utf8')).metadata.user_id)).toEqual(['u3', 'u4']);
  await mock.close();
  mock = await startAnthropicMock({ scenario: fast, keepReceived: 0 });
  await post(mock.url, '/v1/messages', msg());
  expect(mock.received).toHaveLength(0);
});
