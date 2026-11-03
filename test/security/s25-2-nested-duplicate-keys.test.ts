// S25-2 (review of batch 25.1): duplicate keys were refused only at the top level and inside tools entries. A
// duplicate nested deeper (message content blocks, system cache_control, metadata, tool_choice, a Responses input item)
// is the same parser differential: the gateway scans and prices one value, a first-wins provider reads the other. Every
// object at every depth is checked now, in one linear pass, and bodies nested beyond a depth limit are refused.
import { afterEach, expect, test } from 'vitest';
import { bodyShapeRefusal, MAX_BODY_DEPTH } from '../../src/surfaces/body-shape.js';
import { authHeaders, codexHeaders, send } from '../helpers/conformance.js';
import { testPolicy } from '../helpers/policy.js';
import { closeAll, gw, raw, readJson } from './common.js';

afterEach(closeAll);

const anthropic = [
  // messages[].content[]: the scanner reads "clean", a first-wins provider reads the secret-bearing text.
  '{"model":"claude-opus-5-5","max_tokens":10,"messages":[{"role":"user","content":[{"type":"text","text":"a","text":"b"}]}]}',
  // system[] cache_control: two ttl values price differently.
  '{"model":"claude-opus-5-5","max_tokens":10,"system":[{"type":"text","text":"s","cache_control":{"type":"ephemeral","ttl":"5m","ttl":"1h"}}],"messages":[{"role":"user","content":"hi"}]}',
  '{"model":"claude-opus-5-5","max_tokens":10,"metadata":{"user_id":"a","user_id":"b"},"messages":[{"role":"user","content":"hi"}]}',
  '{"model":"claude-opus-5-5","max_tokens":10,"tool_choice":{"type":"auto","type":"any"},"messages":[{"role":"user","content":"hi"}]}',
];
const responses = ['{"model":"gpt-5.4","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"a","text":"b"}]}]}'];

test('S25-2 a duplicate key in any nested object is refused on both surfaces, never forwarded', async () => {
  const log: Buffer[] = [];
  const up = await raw(async (req, res) => {
    log.push((await readJson(req)).raw);
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  });
  const g = await gw(testPolicy({ upstream: up.url, openaiUpstream: up.url }));
  for (const body of anthropic) {
    const r = await send(g.url, { path: '/v1/messages', headers: authHeaders, body });
    expect(r.status, body).toBe(400);
    expect(r.headers['x-should-retry'], body).toBe('false');
  }
  for (const body of responses) {
    const r = await send(g.url, { path: '/v1/responses', headers: codexHeaders, body });
    expect(r.status, body).toBe(400);
  }
  expect(log).toHaveLength(0);
});

test('S25-2 unit: duplicates at any depth, escaped duplicates, and the same key in sibling objects', () => {
  for (const b of [...anthropic, ...responses]) expect(bodyShapeRefusal(Buffer.from(b), true), b).toBe('duplicate-keys');
  expect(bodyShapeRefusal(Buffer.from('{"a":[[{"x":{"k":1,"\\u006b":2}}]]}'), true)).toBe('duplicate-keys');
  // The same key in two different objects is fine, as are keys equal only as strings in different places.
  expect(bodyShapeRefusal(Buffer.from('{"a":{"k":1},"b":{"k":2},"c":[{"k":1},{"k":2}],"k":"k"}'), true)).toBeNull();
  expect(bodyShapeRefusal(Buffer.from('{"s":"{\\"k\\":1,\\"k\\":2}"}'), true)).toBeNull();
});

test('S25-2 bodies nested beyond the depth limit are refused', () => {
  const nest = (n: number): string => '{"a":'.repeat(n) + '1' + '}'.repeat(n);
  expect(bodyShapeRefusal(Buffer.from(nest(MAX_BODY_DEPTH)), true)).toBeNull();
  expect(bodyShapeRefusal(Buffer.from(nest(MAX_BODY_DEPTH + 1)), true)).toBe('too-deep');
  const arrays = '{"a":' + '['.repeat(MAX_BODY_DEPTH) + ']'.repeat(MAX_BODY_DEPTH) + '}';
  expect(bodyShapeRefusal(Buffer.from(arrays), true)).toBe('too-deep');
});

test('S25-2 the scan is linear: 8 MiB of small objects in well under a second', () => {
  const item = '{"type":"text","text":"abcdefgh","cache_control":{"type":"ephemeral"}},';
  const n = Math.floor((8 * 1024 * 1024) / item.length);
  const body = Buffer.from(`{"model":"m","messages":[{"role":"user","content":[${item.repeat(n).slice(0, -1)}]}]}`);
  expect(body.length).toBeGreaterThan(7 * 1024 * 1024);
  const t0 = performance.now();
  expect(bodyShapeRefusal(body, true)).toBeNull();
  expect(performance.now() - t0).toBeLessThan(1000);
  // One object with many keys stays linear too (a Set per object, not pairwise compares).
  const wide = Buffer.from('{' + Array.from({ length: 200_000 }, (_, i) => `"k${i}":${i}`).join(',') + '}');
  const t1 = performance.now();
  expect(bodyShapeRefusal(wide, true)).toBeNull();
  expect(performance.now() - t1).toBeLessThan(1000);
});
