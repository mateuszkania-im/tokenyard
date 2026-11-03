// B8 (security review B): product-route PII hits were traced as HMAC(trace salt, value). A PESEL is a birth date plus
// four digits, so whoever holds raw traces and the trace salt (every replica's environment) recovered it by trying 10^4
// candidates. Now PII hits carry no value HMAC (they never taint), and secret hits are keyed with
// HMAC(traceSalt, "guardrail"), never with the trace salt itself, so pseudonyms and value HMACs never share a key; taint
// still works across instances that share the trace salt and the counter store.
import { createHmac } from 'node:crypto';
import { afterEach, expect, test } from 'vitest';
import { hashKey } from '../../src/edge/auth.js';
import type { RequestOutcome } from '../../src/edge/handler.js';
import { guardrailKey, pseudonym } from '../../src/guardrails/hmac.js';
import type { TraceRecord } from '../../src/ledger/record.js';
import { createMemoryStore } from '../../src/limits/memory-store.js';
import { send } from '../helpers/conformance.js';
import { startGateway } from '../helpers/gateway.js';
import { PROVIDER_KEY_ENV, TEST_KEY, testPolicy } from '../helpers/policy.js';
import { closeAll, closers, raw, readJson } from './common.js';

afterEach(closeAll);

const SALT = 'demo-trace-salt-not-a-secret';
const SERVICE_KEY = 'ty_live_b8_service_key';
const AWS = `AKIA${'Q'.repeat(16)}`;

function pesel(yymmdd: string, serial: string): string {
  const d = `${yymmdd}${serial}`;
  const w = [1, 3, 7, 9, 1, 3, 7, 9, 1, 3];
  const s = [...d].reduce((n, c, i) => n + Number(c) * (w[i] as number), 0);
  return `${d}${(10 - (s % 10)) % 10}`;
}

async function upstream() {
  return raw(async (req, res) => {
    await readJson(req);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }));
  });
}

test('B8 a product-route PESEL hit is traced without a value HMAC: enumeration with the trace salt recovers nothing', async () => {
  process.env[PROVIDER_KEY_ENV] = 'k';
  const up = await upstream();
  const policy = testPolicy({ upstream: up.url, extraKeys: [{ hash: hashKey(SERVICE_KEY), keyId: 'key_svc', tenant: 'acme', team: 'platform', name: 'svc', kind: 'service', billing: 'api' }] });
  const traces: Array<Omit<TraceRecord, 'instance' | 'seq'>> = [];
  const g = await startGateway({ policy, traces: { write: (r) => (traces.push(r), true) }, traceSalt: SALT });
  closers.push(g.close);
  const secret = pesel('900517', '1234');
  await send(g.url, { path: '/v1/messages', headers: { 'x-api-key': SERVICE_KEY, 'content-type': 'application/json', 'x-tokenyard-feature': 'support-summary' }, body: Buffer.from(JSON.stringify({ model: 'claude-haiku-5-5', max_tokens: 8, messages: [{ role: 'user', content: `customer PESEL ${secret}` }] })) });
  await expect.poll(() => traces.length).toBe(1);
  const hit = traces[0]?.guardrail.hits.find((h) => h.rule === 'pesel');
  expect(hit).toBeDefined();
  expect(hit?.valueHmac).toBe('');
  for (const salt of [SALT, guardrailKey(SALT)]) {
    let recovered = false;
    for (let s = 0; s < 10_000 && !recovered; s++) recovered = pseudonym(salt, pesel('900517', String(s).padStart(4, '0'))) === hit?.valueHmac;
    expect(recovered).toBe(false);
  }
});

test('B8 secret hits are keyed with HMAC(traceSalt, "guardrail"), never with the trace salt', async () => {
  process.env[PROVIDER_KEY_ENV] = 'k';
  expect(guardrailKey(SALT)).toBe(createHmac('sha256', SALT).update('guardrail').digest('hex'));
  const up = await upstream();
  const outcomes: RequestOutcome[] = [];
  const g = await startGateway({ policy: testPolicy({ upstream: up.url }), traces: { write: () => true }, traceSalt: SALT, onSettled: (o) => outcomes.push(o) });
  closers.push(g.close);
  await send(g.url, { path: '/v1/messages', headers: { 'x-api-key': TEST_KEY, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' }, body: Buffer.from(JSON.stringify({ model: 'claude-haiku-5-5', max_tokens: 8, messages: [{ role: 'user', content: `aws_access_key_id = ${AWS}` }] })) });
  await expect.poll(() => outcomes.length).toBe(1);
  const hit = outcomes[0]?.guardrailHits?.[0];
  expect(hit?.valueHmac).toBe(pseudonym(guardrailKey(SALT), AWS));
  expect(hit?.valueHmac).not.toBe(pseudonym(SALT, AWS));
});

test('B8 taint written by one instance is recognised by another with the same trace salt and store', async () => {
  process.env[PROVIDER_KEY_ENV] = 'k';
  const up = await upstream();
  const store = createMemoryStore({ clock: Date.now });
  const a = await startGateway({ policy: testPolicy({ upstream: up.url }), store, traceSalt: SALT, traces: { write: () => true } });
  const b = await startGateway({ policy: testPolicy({ upstream: up.url }), store, traceSalt: SALT, traces: { write: () => true } });
  closers.push(a.close, b.close);
  const headers = { 'x-api-key': TEST_KEY, 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-claude-code-session-id': 'sess-b8' };
  const leak = `aws_access_key_id = ${AWS}`;
  const first = await send(a.url, { path: '/v1/messages', headers, body: Buffer.from(JSON.stringify({ model: 'claude-haiku-5-5', max_tokens: 8, messages: [{ role: 'user', content: leak }] })) });
  expect(first.status).toBe(400);
  const next = await send(b.url, { path: '/v1/messages', headers, body: Buffer.from(JSON.stringify({ model: 'claude-haiku-5-5', max_tokens: 8, messages: [{ role: 'user', content: leak }, { role: 'assistant', content: 'noted' }, { role: 'user', content: 'go on' }] })) });
  expect(next.status).toBe(400);
  expect(next.body.toString()).toContain("this session's history");
});
