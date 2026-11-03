// S-V3-1 (V3 chaos, body cap vs scan time): the 32 MiB body cap let one authenticated request hold the event loop for
// 1.0 to 1.6 s of secret scan on a coding-agent route and 1.9 to 2.9 s on a product route, with a body made of JSON
// escapes (`\n` or `\u0041` repeated), against 0.1 to 0.17 s for 32 MiB of plain text. At the example's 120 requests a
// minute per key that is one key keeping a gateway busy. The cap stays (it is Anthropic's documented request limit);
// a body whose scanned part holds more than SCAN_ESCAPE_BUDGET escapes is refused with 413 before the scan.
import { afterEach, expect, test } from 'vitest';
import { countEscapesUpTo, SCAN_ESCAPE_BUDGET } from '../../src/guardrails/scan.js';
import { authHeaders, send } from '../helpers/conformance.js';
import { testPolicy } from '../helpers/policy.js';
import { closeAll, gw, raw, readJson, SERVICE_KEY, serviceKey } from './common.js';

afterEach(closeAll);

const MODEL = 'claude-haiku-5-5';
const OK = JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: MODEL, content: [], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } });

async function stack() {
  let upstream = 0;
  const up = await raw(async (req, res) => {
    await readJson(req);
    upstream++;
    res.writeHead(200, { 'content-type': 'application/json' }).end(OK);
  });
  const g = await gw(testPolicy({ upstream: up.url, models: [MODEL], extraKeys: [serviceKey] }));
  return { g, calls: () => upstream };
}

const escapes = (n: number): string => '\\n'.repeat(n);
const body = (messages: unknown[]): Buffer => Buffer.from(JSON.stringify({ model: MODEL, max_tokens: 64, messages }).replaceAll('@ESC@', escapes(SCAN_ESCAPE_BUDGET + 1)));

test('S-V3-1 countEscapesUpTo stops one past the limit and counts only inside the range', () => {
  const b = Buffer.from(`ab\\ncd\\"e\\\\${escapes(10)}`);
  expect(countEscapesUpTo(b, { start: 0, end: b.length }, 100)).toBe(13);
  expect(countEscapesUpTo(b, { start: 0, end: b.length }, 3)).toBe(4);
  expect(countEscapesUpTo(b, { start: 0, end: 5 }, 100)).toBe(1);
  // An escaped backslash is one escape, not two.
  expect(countEscapesUpTo(Buffer.from('\\\\\\\\'), { start: 0, end: 4 }, 100)).toBe(2);
});

test('S-V3-1 a coding-agent body whose last turn holds more escapes than the budget is refused with 413 before the scan, not sent', async () => {
  const { g, calls } = await stack();
  const r = await send(g.url, { path: '/v1/messages', headers: authHeaders, body: body([{ role: 'user', content: '@ESC@' }]) });
  expect(r.status).toBe(413);
  expect(r.headers['x-should-retry']).toBe('false');
  expect(r.body.toString()).toContain('escape');
  expect(calls()).toBe(0);
  await expect.poll(() => g.outcomes.length).toBe(1);
  expect(g.outcomes[0]?.decision).toEqual({ action: 'block', reason: 'scan-budget' });
  expect(g.outcomes[0]?.reservedMicroUsd ?? 0).toBe(0);
});

test('S-V3-1 coding-agent history is not scanned, so escapes there do not count: forwarded', async () => {
  const { g, calls } = await stack();
  const r = await send(g.url, { path: '/v1/messages', headers: authHeaders, body: body([{ role: 'user', content: '@ESC@' }, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'next' }]) });
  expect(r.status).toBe(200);
  expect(calls()).toBe(1);
});

test('S-V3-1 a product body is scanned whole (redaction), so escapes in its history count: 413', async () => {
  const { g, calls } = await stack();
  const r = await send(g.url, {
    path: '/v1/messages',
    headers: { ...authHeaders, 'x-api-key': SERVICE_KEY },
    body: body([{ role: 'user', content: '@ESC@' }, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'next' }]),
  });
  expect(r.status).toBe(413);
  expect(calls()).toBe(0);
});

test('S-V3-1 a body JSON.parse refuses is scanned whole, so escapes anywhere count: 413', async () => {
  const { g, calls } = await stack();
  const broken = Buffer.from(`{"model":"${MODEL}","max_tokens":64,"messages":[{"role":"user","content":"${escapes(SCAN_ESCAPE_BUDGET + 1)}`);
  const r = await send(g.url, { path: '/v1/messages', headers: authHeaders, body: broken });
  expect(r.status).toBe(413);
  expect(calls()).toBe(0);
});

test('S-V3-1 a large ordinary coding-agent body (8 MiB of source in the last turn, about 0.5 Mi escapes) is still forwarded', async () => {
  const { g, calls } = await stack();
  const source = 'export function add(a: number, b: number): number {\n  return a + b; // "sum"\n}\n'.repeat(Math.ceil((8 * 1024 * 1024) / 80));
  const r = await send(g.url, { path: '/v1/messages', headers: authHeaders, body: Buffer.from(JSON.stringify({ model: MODEL, max_tokens: 64, messages: [{ role: 'user', content: source }] })) });
  expect(r.status).toBe(200);
  expect(calls()).toBe(1);
}, 30_000);
