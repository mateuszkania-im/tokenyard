import { request } from 'node:http';
import { afterEach, beforeEach, expect, test } from 'vitest';
import type { TraceRecord } from '../../src/ledger/record.js';
import { startAnthropicMock, type MockServer } from '../../src/mock/anthropic.js';
import type { CompiledPolicy, ProviderSpec } from '../../src/policy/types.js';
import { startGateway, type TestGateway } from '../helpers/gateway.js';
import { PROVIDER_KEY_ENV, TEST_KEY, testPolicy } from '../helpers/policy.js';

const BACKUP_ENV = 'TOKENYARD_TEST_BACKUP_KEY';
const down = { kind: 'status', status: 503, headers: {}, body: '{"type":"error","error":{"type":"overloaded_error","message":"x"}}' } as const;

let mocks: MockServer[] = [];
let gw: TestGateway | undefined;
beforeEach(() => {
  process.env[PROVIDER_KEY_ENV] = 'sk-a';
  process.env[BACKUP_ENV] = 'sk-b';
});
afterEach(async () => {
  await gw?.close();
  await Promise.all(mocks.map((m) => m.close()));
  mocks = [];
  gw = undefined;
  delete process.env[PROVIDER_KEY_ENV];
  delete process.env[BACKUP_ENV];
});

async function setup(first: Parameters<typeof startAnthropicMock>[0], sameWorkspace: boolean) {
  const a = await startAnthropicMock(first);
  // Same workspace means same endpoint and same key: both providers then point at one mock.
  const b = sameWorkspace ? a : await startAnthropicMock();
  mocks.push(...new Set([a, b]));
  const base = testPolicy({ upstream: a.url });
  const sp = (p: ProviderSpec | undefined, baseUrl: string, env: string): [string, ProviderSpec] => [(p as ProviderSpec).name, { ...(p as ProviderSpec), baseUrl, credential: { env } }];
  const policy: CompiledPolicy = {
    ...base,
    providers: new Map([
      sp(base.providers.get('anthropic'), a.url, PROVIDER_KEY_ENV),
      sp(base.providers.get('anthropic-backup'), b.url, sameWorkspace ? PROVIDER_KEY_ENV : BACKUP_ENV),
    ]),
  };
  const records: Array<Omit<TraceRecord, 'instance' | 'seq'>> = [];
  gw = await startGateway({ policy, traces: { write: (r) => (records.push(r), true) }, traceSalt: 's' });
  return { a, b, records, url: gw.url };
}

function post(url: string, stream = false): Promise<{ status: number; abort: () => void; done: Promise<number> }> {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = request(
      { host: u.hostname, port: u.port, method: 'POST', path: '/v1/messages', headers: { 'x-api-key': TEST_KEY, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' } },
      (res) => {
        res.resume();
        resolve({ status: res.statusCode ?? 0, abort: () => req.destroy(), done: new Promise((r) => res.on('close', () => r(res.statusCode ?? 0))) });
      },
    );
    req.on('error', () => undefined);
    req.end(JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: 8, stream, messages: [{ role: 'user', content: 'hi' }] }));
  });
}

const settle = () => new Promise((r) => setTimeout(r, 50));

test('fallback to another workspace answers the client and marks cacheColdRisk on the trace', async () => {
  const t = await setup({ scenario: down }, false);
  const res = await post(t.url);
  expect(res.status).toBe(200);
  await res.done;
  await settle();
  expect(t.a.received).toHaveLength(1);
  expect(t.b.received).toHaveLength(1);
  expect(t.b.received[0]?.headers['x-api-key']).toBe('sk-b'); // each attempt carries its own provider credential
  const o = t.records[0]?.outcome;
  expect(o).toMatchObject({ provider: 'anthropic-backup', attempts: 2, cacheColdRisk: true, status: 200 });
});

test('fallback to the same workspace does not mark cacheColdRisk', async () => {
  let calls = 0;
  const t = await setup({ scenario: down }, true);
  t.a.setScenario(() => (++calls === 1 ? down : { kind: 'ok', ttftMs: 0, tokensPerSec: 0, pingEveryMs: null, outputTokens: 4 }));
  const res = await post(t.url);
  await res.done;
  await settle();
  expect(t.records[0]?.outcome).toMatchObject({ provider: 'anthropic-backup', attempts: 2, cacheColdRisk: false });
});

test('no fallback needed: one attempt, no cold risk', async () => {
  const t = await setup({}, false);
  const res = await post(t.url);
  await res.done;
  await settle();
  expect(t.records[0]?.outcome).toMatchObject({ provider: 'anthropic', attempts: 1, cacheColdRisk: false });
  expect(t.b.received).toHaveLength(0);
});

test('a client abort while the first provider hangs sends nothing to the fallback', async () => {
  const t = await setup({ scenario: { kind: 'hangBeforeHeaders' } }, false);
  const u = new URL(t.url);
  const req = request({ host: u.hostname, port: u.port, method: 'POST', path: '/v1/messages', headers: { 'x-api-key': TEST_KEY, 'content-type': 'application/json' } });
  req.on('error', () => undefined);
  req.end(JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }));
  await new Promise((r) => setTimeout(r, 100));
  req.destroy();
  await new Promise((r) => setTimeout(r, 150));
  expect(t.a.received).toHaveLength(1);
  expect(t.b.received).toHaveLength(0);
  expect(t.records[0]?.outcome).toMatchObject({ status: 499, aborted: true, errorClass: 'client_abort' });
});

test('no retry once the response started: a mid-stream error reaches the client and the fallback is not asked', async () => {
  const t = await setup({ scenario: { kind: 'midStreamError', afterEvents: 2, errorType: 'overloaded_error' } }, false);
  const res = await post(t.url, true);
  expect(res.status).toBe(200);
  await res.done;
  await settle();
  expect(t.a.received).toHaveLength(1);
  expect(t.b.received).toHaveLength(0);
  expect(t.records[0]?.outcome.attempts).toBe(1);
});
