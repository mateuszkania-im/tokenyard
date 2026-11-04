// S25-3 and S25-4 (automated review of the B2 fix): B2 redacted only the first 64 KiB of a non-2xx body and streamed the
// rest unredacted, so a provider key starting before, straddling or lying after that boundary reached the client; and
// the masked-form regex ran an unbounded quantifier over upstream bytes. Now, in API mode, a non-2xx body is cut to
// 64 KiB with a short marker, every byte forwarded is redacted (a key straddling the cut included) and content-length is
// recomputed; masked forms are found by a linear scan.
import { randomBytes } from 'node:crypto';
import { afterEach, expect, test } from 'vitest';
import { redactCredentialEcho } from '../../src/guardrails/credential-echo.js';
import { send } from '../helpers/conformance.js';
import { startGateway } from '../helpers/gateway.js';
import { PROVIDER_KEY_ENV, TEST_KEY, testPolicy } from '../helpers/policy.js';
import { closeAll, closers, raw, readJson } from './common.js';
import { cpuBoundMs, minCpuMs } from '../helpers/timing.js';

afterEach(async () => {
  await closeAll();
  delete process.env[PROVIDER_KEY_ENV];
});

const CAP = 64 * 1024;
const key = `sk-ant-test-CANARY-${randomBytes(24).toString('hex').toUpperCase()}`;
const msg = Buffer.from(JSON.stringify({ model: 'claude-haiku-5-5', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }));
const auth = { 'x-api-key': TEST_KEY, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' };

async function errorBody(body: string): Promise<{ status: number; text: string; length: string | undefined; bytes: number }> {
  process.env[PROVIDER_KEY_ENV] = key;
  const up = await raw(async (req, res) => {
    await readJson(req);
    res.writeHead(500, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) }).end(body);
  });
  const g = await startGateway({ policy: testPolicy({ upstream: up.url }) });
  closers.push(g.close);
  const r = await send(g.url, { path: '/v1/messages', headers: auth, body: msg });
  return { status: r.status, text: r.body.toString(), length: r.headers['content-length'] as string | undefined, bytes: r.body.length };
}

const hasKeyPart = (text: string): boolean => text.includes(key.slice(0, 20)) || text.includes(key.slice(-12));

test('S25-3 a key straddling the 64 KiB boundary is redacted and the body is cut with a marker and a matching content-length', async () => {
  const before = 'x'.repeat(CAP - 10);
  const r = await errorBody(`${before}${key}${'y'.repeat(50_000)}`);
  expect(r.status).toBe(500);
  expect(hasKeyPart(r.text)).toBe(false);
  expect(r.text).toContain('[truncated by tokenyard]');
  expect(Number(r.length)).toBe(r.bytes);
  expect(r.bytes).toBeLessThanOrEqual(CAP + 64);
});

test('S25-3 a key after the boundary never reaches the client', async () => {
  const r = await errorBody(`${'x'.repeat(CAP + 5000)}${key}`);
  expect(hasKeyPart(r.text)).toBe(false);
  expect(Number(r.length)).toBe(r.bytes);
});

test('S25-3 a key just before the boundary is redacted in full', async () => {
  const r = await errorBody(`${'x'.repeat(CAP - key.length - 2)}${key}${'z'.repeat(10_000)}`);
  expect(hasKeyPart(r.text)).toBe(false);
  expect(r.text).toContain('[redacted]');
});

test('S25-3 an error body under the cap is forwarded whole, redacted', async () => {
  const r = await errorBody(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `bad key ${key}` } }));
  expect(r.text).toBe(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'bad key [redacted]' } }));
  expect(Number(r.length)).toBe(r.bytes);
});

test('S25-4 masked-form matching is linear: 1 MB of adversarial input takes well under 100 ms', () => {
  const k = `sk-proj-${'a'.repeat(40)}WXYZ`;
  // Long runs the old pattern backtracked over: the key prefix repeated (every position starts a run to the end), the
  // key prefix then word characters, masks without the right suffix,
  // and many suffix occurrences without a mask.
  const inputs = ['sk-'.repeat(333_333), `sk-${'a'.repeat(1_000_000)}`, `sk-${'a'.repeat(500_000)}***WXY`.repeat(2), '***WXYZ'.repeat(150_000), 'WXYZ'.repeat(250_000), `${'*'.repeat(1_000_000)}WXYZ`];
  for (const input of inputs) {
    // A linear pass over 1 MB takes a few ms; 100 ms of CPU leaves room for a slow shared CI runner and coverage
    // instrumentation (115 ms of wall clock once under coverage, V5) while an unbounded quantifier on these inputs takes
    // seconds. CPU time, least of three: a loaded machine stretches the wall clock, not the work.
    expect(minCpuMs(() => redactCredentialEcho(Buffer.from(input), k)), input.slice(0, 12)).toBeLessThan(cpuBoundMs(100));
  }
});

test('S25-4 the linear scan finds the same masked forms', () => {
  const k = `sk-ant-api03-${'a'.repeat(30)}Q7xZ`;
  for (const form of [k, 'sk-ant-api03-aaa...Q7xZ', 'sk-...Q7xZ', '****Q7xZ', 'sk-ant…Q7xZ', 'sk-ant-•••Q7xZ']) {
    expect(redactCredentialEcho(Buffer.from(`key ${form} rejected`), k)?.toString(), form).toBe('key [redacted] rejected');
  }
  expect(redactCredentialEcho(Buffer.from('Q7xZ and **Q7xZ and sk-Q7xZ'), k)).toBeNull();
});
