// Spec 6.6 and 5.3 steps 5 to 8 through the real gateway: secret scan before admit, session taint inside admit,
// product redaction, and the error envelope Claude Code sees (spec 5.6).
import { createClient } from 'redis';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { hashKey } from '../../src/edge/auth.js';
import type { RequestOutcome } from '../../src/edge/handler.js';
import { pseudonym } from '../../src/guardrails/hmac.js';
import type { TraceRecord } from '../../src/ledger/record.js';
import { createMemoryStore } from '../../src/limits/memory-store.js';
import { createRedisStore } from '../../src/limits/redis-store.js';
import type { CounterStore } from '../../src/limits/store.js';
import type { Admission, KeyRecord } from '../../src/policy/types.js';
import { authHeaders, send, startRawUpstream } from '../helpers/conformance.js';
import { startGateway } from '../helpers/gateway.js';
import { PROVIDER_KEY_ENV, testPolicy } from '../helpers/policy.js';
import { spyStore } from '../helpers/store-spy.js';
import { RULE_FIXTURES } from '../guardrails/fixtures.js';

type Rec = Omit<TraceRecord, 'instance' | 'seq'>;
const AWS = RULE_FIXTURES['aws-access-key-id']?.positive as string;
const GH = RULE_FIXTURES['github-pat']?.positive as string;
const GENERIC = RULE_FIXTURES['generic-secret-assignment']?.positive as string;
const SALT = 'trace-salt';
const SERVICE_KEY = 'ty_live_service';
const service: KeyRecord = { hash: hashKey(SERVICE_KEY), keyId: 'key_svc', tenant: 'acme', team: 'platform', name: 'svc', kind: 'service', billing: 'api' };

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  delete process.env[PROVIDER_KEY_ENV];
});

/** Upstream that records every body and header set it receives and answers one small JSON message. */
async function upstream() {
  const got: Array<{ body: Buffer; headers: Record<string, string | string[] | undefined> }> = [];
  const up = await startRawUpstream((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      got.push({ body: Buffer.concat(chunks), headers: req.headers });
      const out = JSON.stringify({ id: 'msg_1', type: 'message', model: 'claude-haiku-5-5', content: [], usage: { input_tokens: 10, output_tokens: 1 } });
      res.writeHead(200, { 'content-type': 'application/json' }).end(out);
    });
  });
  closers.push(up.close);
  return { url: up.url, got };
}

async function gateway(store: CounterStore | null, policy: Omit<Parameters<typeof testPolicy>[0], 'upstream'> = {}, admitTimeoutMs?: number) {
  process.env[PROVIDER_KEY_ENV] = 'k';
  const up = await upstream();
  const traces: Rec[] = [];
  const outcomes: RequestOutcome[] = [];
  const gw = await startGateway({
    policy: testPolicy({ upstream: up.url, extraKeys: [service], ...policy }),
    store,
    traces: { write: (r) => (traces.push(r), true) },
    traceSalt: SALT,
    onSettled: (o) => outcomes.push(o),
    ...(admitTimeoutMs !== undefined ? { admitTimeoutMs } : {}),
  });
  closers.push(gw.close);
  return { url: gw.url, up, traces, outcomes };
}

const body = (messages: unknown[], model = 'claude-haiku-5-5'): Buffer => Buffer.from(JSON.stringify({ model, max_tokens: 64, messages }));
const turn1 = (): Buffer => body([{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: `aws_access_key_id = ${AWS}` }] }]);
const turn2 = (): Buffer =>
  body([
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: `aws_access_key_id = ${AWS}` }] },
    { role: 'assistant', content: 'noted' },
    { role: 'user', content: 'carry on' },
  ]);
const post = (url: string, b: Buffer, session = 'sess-1', headers: Record<string, string> = authHeaders) =>
  send(url, { path: '/v1/messages', headers: { ...headers, 'x-claude-code-session-id': session }, body: b });
const message = (b: Buffer): string => (JSON.parse(b.toString()) as { error: { message: string } }).error.message;

test('last-turn hit with codingAgent block gives preBlock secret and Plan.taint.add with the HMAC; message names rule and index, never the value', async () => {
  const spy = spyStore(createMemoryStore({ clock: Date.now }));
  const g = await gateway(spy.store);
  const res = await post(g.url, turn1());
  expect(res.status).toBe(400);
  expect(res.headers['x-should-retry']).toBe('false');
  expect(res.headers['retry-after']).toBeUndefined();
  const msg = message(res.body);
  expect(JSON.parse(res.body.toString())).toMatchObject({ type: 'error', error: { type: 'invalid_request_error' } });
  expect(msg).toContain('aws-access-key-id');
  expect(msg).toContain('message 0');
  expect(msg).toContain('/clear');
  expect(msg).not.toContain(AWS);
  expect(g.up.got).toHaveLength(0);

  const session = pseudonym(SALT, 'sess-1');
  const hmac = pseudonym(SALT, AWS);
  expect(spy.admits).toHaveLength(1);
  const plan = spy.admits[0]?.plan;
  expect(plan?.preBlock).toBe('secret');
  expect(plan?.reservations).toEqual([]);
  expect(plan?.taint).toMatchObject({ key: `ty:{acme}:taint:s:${session}`, add: [{ rule: 'aws-access-key-id', valueHmac: hmac }], ttlMs: 24 * 3_600_000 });
  await expect.poll(() => g.traces.length).toBe(1);
  const t = g.traces[0] as Rec;
  expect(t.guardrail.hits).toEqual([{ rule: 'aws-access-key-id', action: 'block', valueHmac: hmac, where: 'last-turn' }]);
  expect(t.decision).toMatchObject({ action: 'block', reason: 'secret' });
  expect(JSON.stringify(t)).not.toContain(AWS);
});

function taintCases(name: string, make: () => Promise<CounterStore>) {
  test(`next request in the same session carrying the value in history fails admit with kind taint (${name})`, async () => {
    const spy = spyStore(await make());
    const g = await gateway(spy.store);
    expect((await post(g.url, turn1())).status).toBe(400);
    const res = await post(g.url, turn2());
    expect(res.status).toBe(400);
    expect(res.headers['x-should-retry']).toBe('false');
    expect(spy.admits[1]?.admission.failed).toMatchObject({ kind: 'taint', rule: 'aws-access-key-id' });
    const msg = message(res.body);
    expect(msg).toContain('aws-access-key-id');
    expect(msg).toContain('message 0');
    expect(msg).not.toContain(AWS);
    expect(g.up.got).toHaveLength(0);
    // Another session with the same history was never tainted.
    expect((await post(g.url, turn2(), 'sess-2')).status).toBe(200);
    expect(g.up.got).toHaveLength(1);
  });
}

taintCases('memory', async () => createMemoryStore({ clock: Date.now }));

const redisUrl = process.env.REDIS_URL;
describe.skipIf(!redisUrl)('redis (REDIS_URL)', () => {
  const client = createClient({ url: redisUrl });
  beforeAll(async () => {
    await client.connect();
  });
  afterAll(async () => {
    await client.flushDb();
    await client.close();
  });
  taintCases('redis', async () => {
    await client.flushDb();
    return createRedisStore(client, { deadlineMs: 600_000 });
  });
});

test('taint holds when the next request carries the secret escaped differently (\\u escape)', async () => {
  const g = await gateway(createMemoryStore({ clock: Date.now }));
  expect((await post(g.url, turn1())).status).toBe(400);
  const escaped = Buffer.from(
    `{"model":"claude-haiku-5-5","max_tokens":64,"messages":[{"role":"user","content":"key \\u0041${AWS.slice(1)}"},{"role":"assistant","content":"ok"},{"role":"user","content":"go"}]}`,
  );
  const res = await post(g.url, escaped);
  expect(res.status).toBe(400);
  expect(message(res.body)).toContain('history (message 0)');
  expect(g.up.got).toHaveLength(0);
});

test('a malformed JSON body carrying a secret is blocked (scanned as raw bytes)', async () => {
  const g = await gateway(createMemoryStore({ clock: Date.now }));
  const broken = Buffer.from(`{"model":"claude-haiku-5-5","max_tokens":64,"messages":[{"role":"user","content":"key ${AWS}"}`);
  const res = await post(g.url, broken);
  expect(res.status).toBe(400);
  expect(message(res.body)).toContain('aws-access-key-id');
  expect(g.up.got).toHaveLength(0);
});

test('a malformed body with a \\u-escaped secret is blocked (decoded copy of the raw bytes)', async () => {
  const g = await gateway(createMemoryStore({ clock: Date.now }));
  const broken = Buffer.from(`{"model":"claude-haiku-5-5","max_tokens":64,"messages":[{"role":"user","content":"line\\n\\u0041${AWS.slice(1)}"}`);
  const res = await post(g.url, broken);
  expect(res.status).toBe(400);
  expect(message(res.body)).toContain('aws-access-key-id');
  expect(g.up.got).toHaveLength(0);
});

test('duplicate keys a provider could read differently are scanned as the last turn and blocked', async () => {
  const g = await gateway(createMemoryStore({ clock: Date.now }));
  const dupMessages = Buffer.from(`{"model":"claude-haiku-5-5","max_tokens":64,"messages":[{"role":"user","content":"${AWS}"}],"messages":[{"role":"user","content":"hi"}]}`);
  const dupRole = Buffer.from(`{"model":"claude-haiku-5-5","max_tokens":64,"messages":[{"role":"user","content":"${AWS}","role":"assistant"}]}`);
  for (const b of [dupMessages, dupRole]) {
    const res = await post(g.url, b);
    expect(res.status).toBe(400);
    expect(message(res.body)).toContain('aws-access-key-id');
  }
  expect(g.up.got).toHaveLength(0);
});

test('product route: bare card and PESEL numbers are redacted to strings; signed, decimal, exponent and epoch-ms numbers are not', async () => {
  const g = await gateway(createMemoryStore({ clock: Date.now }));
  const svc = { ...authHeaders, 'x-api-key': SERVICE_KEY };
  // A 13-digit millisecond timestamp that passes Luhn, found at run time.
  let ts = 1_730_000_000_000;
  const luhn = (s: string): boolean => [...s].reverse().reduce((acc, ch, i) => acc + (i % 2 ? ((Number(ch) * 2) % 10) + Math.floor((Number(ch) * 2) / 10) : Number(ch)), 0) % 10 === 0;
  while (!luhn(String(ts))) ts++;
  const kept = `"a":-4111111111111111,"b":1.4111111111111111,"c":4111111111111111e2,"d":${ts}`;
  const b = Buffer.from(
    `{"model":"claude-haiku-5-5","max_tokens":64,"messages":[{"role":"user","content":"card 4111111111111111"},{"role":"assistant","content":[{"type":"tool_use","id":"t","name":"n","input":{${kept},"card":4111111111111111,"p":44051401359}}]},{"role":"user","content":"go"}]}`,
  );
  const res = await post(g.url, b, 'p2', svc);
  expect(res.status).toBe(200);
  const sent = g.up.got[0]?.body.toString() ?? '';
  expect(sent).toContain(kept);
  expect(sent).toContain('card [REDACTED:CARD_NUMBER_1]');
  expect(sent).toContain('"card":"[REDACTED:CARD_NUMBER_1]","p":"[REDACTED:PESEL_1]"');
  expect(() => JSON.parse(sent)).not.toThrow();
});

test('guardrails.pii.quotedOnly: true leaves bare numbers alone on a product route (default false redacts them)', async () => {
  const svc = { ...authHeaders, 'x-api-key': SERVICE_KEY };
  const b = Buffer.from(`{"model":"claude-haiku-5-5","max_tokens":64,"messages":[{"role":"user","content":[{"type":"text","text":"x","n":4111111111111111}]}]}`);
  const byDefault = await gateway(createMemoryStore({ clock: Date.now }));
  expect((await post(byDefault.url, b, 'p3', svc)).status).toBe(200);
  expect(byDefault.up.got[0]?.body.toString()).toContain('"n":"[REDACTED:CARD_NUMBER_1]"');
  const quoted = await gateway(createMemoryStore({ clock: Date.now }), { edit: (p) => void Object.assign(p.guardrails.pii, { quotedOnly: true }) });
  expect((await post(quoted.url, b, 'p3', svc)).status).toBe(200);
  expect(quoted.up.got[0]?.body.toString()).toContain('"n":4111111111111111');
});

test('history hit of a value that was only warned does not block', async () => {
  const spy = spyStore(createMemoryStore({ clock: Date.now }));
  const g = await gateway(spy.store, { edit: (p) => void (p.guardrails.secrets.codingAgent = 'warn') });
  expect((await post(g.url, turn1())).status).toBe(200);
  expect((await post(g.url, turn2())).status).toBe(200);
  expect(g.up.got).toHaveLength(2);
  await expect.poll(() => g.traces.length).toBe(2);
  expect(g.traces[0]?.guardrail.hits).toEqual([{ rule: 'aws-access-key-id', action: 'warn', valueHmac: pseudonym(SALT, AWS), where: 'last-turn' }]);
  // Warn rules are not scanned in history, so nothing is checked against the taint set.
  expect(g.traces[1]?.guardrail.hits).toEqual([]);
});

test('store down: last-turn block still works; taint skipped and taintUnchecked true', async () => {
  const down: CounterStore = {
    admit: () => Promise.reject(new Error('down')),
    settle: async () => 'unknown',
    sweep: async () => 0,
    snapshot: async () => ({}),
    seed: async () => undefined,
  };
  const g = await gateway(down, { edit: (p) => void (p.failure.counterStoreDown.budgets = 'open') });
  const res = await post(g.url, turn1());
  expect(res.status).toBe(400);
  expect(message(res.body)).toContain('aws-access-key-id');
  // The history request is forwarded: the taint could not be checked.
  expect((await post(g.url, turn2())).status).toBe(200);
  await expect.poll(() => g.outcomes.length).toBe(2);
  expect(g.outcomes.map((o) => o.taintUnchecked)).toEqual([true, true]);
  expect(g.traces.map((t) => t.decision.taintUnchecked)).toEqual([true, true]);
});

test('entropy-only hits never block', async () => {
  const g = await gateway(createMemoryStore({ clock: Date.now }));
  const res = await post(g.url, body([{ role: 'user', content: GENERIC }]));
  expect(res.status).toBe(200);
  await expect.poll(() => g.traces.length).toBe(1);
  expect(g.traces[0]?.guardrail.hits).toMatchObject([{ rule: 'generic-secret-assignment', action: 'warn', where: 'last-turn' }]);
});

test('product route: redact replaces values and recomputes content-length; coding-agent route never changes bytes', async () => {
  const g = await gateway(createMemoryStore({ clock: Date.now }), { edit: (p) => void (p.guardrails.secrets.codingAgent = 'warn') });
  const svc = { ...authHeaders, 'x-api-key': SERVICE_KEY };
  const product = body([{ role: 'user', content: `mail jan@example.com, key ${AWS}, again jan@example.com, token ${GH}` }], 'claude-haiku-4-5');
  expect((await post(g.url, product, 'p1', svc)).status).toBe(200);
  const sent = g.up.got[0];
  if (!sent) throw new Error('nothing forwarded');
  const parsed = JSON.parse(sent.body.toString()) as { model: string; messages: Array<{ content: string }> };
  // The route's rewriteModel still applies, after redaction.
  expect(parsed.model).toBe('claude-haiku-5-5');
  expect(parsed.messages[0]?.content).toBe('mail [REDACTED:EMAIL_1], key [REDACTED:AWS_ACCESS_KEY_ID_1], again [REDACTED:EMAIL_1], token [REDACTED:GITHUB_PAT_1]');
  expect(sent.headers['content-length']).toBe(String(sent.body.length));
  await expect.poll(() => g.traces.length).toBe(1);
  expect(g.traces[0]?.guardrail.hits.map((h) => [h.rule, h.action])).toEqual([
    ['aws-access-key-id', 'redact'],
    ['github-pat', 'redact'],
    ['email', 'redact'],
  ]);

  const coding = turn1();
  expect((await post(g.url, coding)).status).toBe(200);
  expect(g.up.got[1]?.body.equals(coding)).toBe(true);
});

describe('own non-retryable errors carry x-should-retry: false', () => {
  const stub = (failed: NonNullable<Admission['failed']>): CounterStore => ({
    admit: async () => ({ admitted: false, failed, audit: [], totals: [] }),
    settle: async () => 'unknown',
    sweep: async () => 0,
    snapshot: async () => ({}),
    seed: async () => undefined,
  });
  const ok = body([{ role: 'user', content: 'hi' }]);

  test('budget (no retry-after), taint, rate keeps retrying', async () => {
    const budget = await gateway(stub({ kind: 'budget', name: 'team-day', spentMicroUsd: 1 }));
    const b = await post(budget.url, ok);
    expect([b.status, b.headers['x-should-retry'], b.headers['retry-after']]).toEqual([429, 'false', undefined]);
    const taint = await gateway(stub({ kind: 'taint', name: 'taint', rule: 'github-pat' }));
    const t = await post(taint.url, ok);
    expect([t.status, t.headers['x-should-retry']]).toEqual([400, 'false']);
    const rate = await gateway(stub({ kind: 'rate', name: 'dev-rpm', retryAfterMs: 2000 }));
    const r = await post(rate.url, ok);
    expect([r.status, r.headers['x-should-retry'], r.headers['retry-after']]).toEqual([429, undefined, '2']);
  });

  test('secret, model-not-allowed, server-tool-not-allowed, no-route', async () => {
    const g = await gateway(null, { models: ['claude-haiku-*'] });
    const secret = await post(g.url, turn1());
    expect([secret.status, secret.headers['x-should-retry']]).toEqual([400, 'false']);
    const model = await post(g.url, body([{ role: 'user', content: 'hi' }], 'claude-opus-5-5'));
    expect([model.status, model.headers['x-should-retry']]).toEqual([403, 'false']);
    const tool = Buffer.from(JSON.stringify({ model: 'claude-haiku-5-5', max_tokens: 8, tools: [{ type: 'web_fetch_20250910', name: 'web_fetch', max_uses: 1 }], messages: [{ role: 'user', content: 'hi' }] }));
    const st = await post(g.url, tool);
    expect([st.status, st.headers['x-should-retry']]).toEqual([403, 'false']);
    const noRoute = await gateway(null, { editRoutes: (routes) => void routes.splice(0, routes.length, ...routes.filter((r) => r.name !== 'claude-code')) });
    const nr = await post(noRoute.url, ok);
    expect([nr.status, nr.headers['x-should-retry']]).toEqual([403, 'false']);
  });
});
