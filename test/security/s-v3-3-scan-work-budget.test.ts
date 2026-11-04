// S-V3-3 (V3 review of S-V3-1): the escape budget bounded one cost driver of the secret scan, not the scan. Without a
// single escape, 32 MiB of short strings (`"a",`) held the event loop for 2.0 to 6.1 s, 32 MiB of AWS-key-shaped
// values for 3.3 to 5.9 s, and 32 MiB of bare tokens (`1,`) grew the scanner's arrays past V8's limit (RangeError,
// 500, RSS 1.8 to 2.4 GB). Parsing alone took 2.5 s and 1.2 GB on 32 MiB of `{},`. Now: a body with more JSON values
// than BODY_VALUE_BUDGET is refused before JSON.parse, and the scan counts its decoded runs and regex matches as it
// makes them and stops at SCAN_RUN_BUDGET or SCAN_MATCH_BUDGET; either way 413 `scan-budget`, nothing sent.
import { afterEach, expect, test } from 'vitest';
import { PII_RULES } from '../../src/guardrails/pii.js';
import { DEFAULT_RULES } from '../../src/guardrails/rules.js';
import { findSpans, keywordsIn, SCAN_MATCH_BUDGET, SCAN_RUN_BUDGET, ScanBudget, ScanBudgetError, scanBody } from '../../src/guardrails/scan.js';
import { extractAnthropicFeatures } from '../../src/surfaces/anthropic-messages.js';
import { BODY_VALUE_BUDGET, countJsonValuesUpTo } from '../../src/surfaces/json-ranges.js';
import { authHeaders, send } from '../helpers/conformance.js';
import { testPolicy } from '../helpers/policy.js';
import { closeAll, gw, raw, readJson, serviceKey } from './common.js';
import { KEY_SHAPED, MODEL } from './scan-budget-bodies.js';
import { cpuBoundMs, cpuMs } from '../helpers/timing.js';

afterEach(closeAll);

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

test('S-V3-3 countJsonValuesUpTo counts strings, keys, numbers, literals, objects and arrays, and stops one past its limit', () => {
  const b = Buffer.from('{"a":[1,-2.5e3,true,null,"x\\"y,z[]{}"],"b":{}, "c" : [ ] }');
  // object, "a", array, 1, -2.5e3, true, null, "x\"y,z[]{}", "b", {}, "c", []
  expect(countJsonValuesUpTo(b, 100)).toBe(12);
  expect(countJsonValuesUpTo(b, 3)).toBe(4);
  expect(countJsonValuesUpTo(Buffer.from('  '), 10)).toBe(0);
  // Bytes JSON.parse refuses are counted the same way (an unterminated string is one value).
  expect(countJsonValuesUpTo(Buffer.from('[1 2 "abc'), 10)).toBe(4);
});

test('S-V3-3 the scan stops with ScanBudgetError at its run budget, shared by every region of one scanBody call', () => {
  const b = Buffer.from(JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: Array.from({ length: 40 }, () => 'a') }, { role: 'assistant', content: 'ok' }, { role: 'user', content: Array.from({ length: 40 }, () => 'b') }] }));
  const f = extractAnthropicFeatures(b);
  const opts = f.messages ? { messages: f.messages } : {};
  const free = new ScanBudget(1e9, 1e9);
  scanBody(b, f.lastTurn, DEFAULT_RULES, () => 'block', 's', { ...opts, budget: free });
  const { runs } = free.used();
  // Each region alone stays under half of the run count; together they need all of it.
  expect(() => scanBody(b, f.lastTurn, DEFAULT_RULES, () => 'block', 's', { ...opts, budget: new ScanBudget(runs - 1, 1e9) })).toThrow(ScanBudgetError);
  expect(() => scanBody(b, f.lastTurn, DEFAULT_RULES, () => 'block', 's', { ...opts, budget: new ScanBudget(runs, 1e9) })).not.toThrow();
  try {
    findSpans(b, DEFAULT_RULES, { ...opts, budget: new ScanBudget(10, 1e9) });
    expect.unreachable();
  } catch (err) {
    expect(err).toBeInstanceOf(ScanBudgetError);
    expect((err as ScanBudgetError).counter).toBe('runs');
  }
});

test('S-V3-3 the scan stops with ScanBudgetError at its match budget, counted before checksums (PII) or entropy', () => {
  const keys = Buffer.from(JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: `${KEY_SHAPED} `.repeat(6) }] }));
  expect(() => findSpans(keys, DEFAULT_RULES, { budget: new ScanBudget(1e9, 5) })).toThrow(ScanBudgetError);
  expect(findSpans(keys, DEFAULT_RULES, { budget: new ScanBudget(1e9, 6) })).toHaveLength(6);
  // Eleven-digit numbers that fail the PESEL checksum are still regex matches: they cost the same to try.
  const digits = Buffer.from(JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: '12345678901 '.repeat(6) }] }));
  try {
    findSpans(digits, PII_RULES, { budget: new ScanBudget(1e9, 5) });
    expect.unreachable();
  } catch (err) {
    expect((err as ScanBudgetError).counter).toBe('matches');
  }
});

test('S-V3-3 keywordsIn stops at one hit per keyword: 32 MiB of one keyword is one hit, as String.includes finds it', () => {
  const text = '@'.repeat(32 * 1024 * 1024);
  // Every 32 Mi positions was a hit before (0.85 s); now the first hit ends the search for that keyword. CPU time: a
  // loaded machine stretches the wall clock, not the work (V5).
  expect(cpuMs(() => expect(keywordsIn(text, ['@', 'AKIA', 'secret'])).toEqual(new Set(['@'])))).toBeLessThan(cpuBoundMs(400));
});

// The 32 MiB bodies (short strings, bare tokens, dense matches; last turn and history; coding-agent and product
// routes) are sent in s-v3-3-scan-memory.test.ts, in one child process that also measures memory and event loop lag.

test('S-V3-3 a body just over BODY_VALUE_BUDGET is refused before parsing; one at the budget is parsed, scanned and sent', async () => {
  const { g, calls } = await stack();
  const at = (n: number): Buffer => Buffer.from(`{"model":"${MODEL}","max_tokens":64,"messages":[{"role":"user","content":[${'1,'.repeat(n - 1)}1]}]}`);
  // {, "model", its value, "max_tokens", 64, "messages", [, {, "role", "user", "content", [: 12 values before the list.
  const over = await send(g.url, { path: '/v1/messages', headers: authHeaders, body: at(BODY_VALUE_BUDGET - 12 + 1) });
  expect(over.status).toBe(413);
  expect(over.body.toString()).toContain('JSON values');
  expect(calls()).toBe(0);
  const under = await send(g.url, { path: '/v1/messages', headers: authHeaders, body: at(BODY_VALUE_BUDGET - 12) });
  expect(under.status).toBe(200);
  expect(calls()).toBe(1);
}, 30_000);

test('S-V3-3 a body within the value and escape budgets but over the run budget is refused by the scan itself: 413', async () => {
  const { g, calls } = await stack();
  // Text blocks of one message, each `\na` repeated: 3 values and 4 escapes per block, about 20 runs with the copy of
  // the message's joined text, so the run budget is passed well inside the other two.
  const blocks = Math.ceil(SCAN_RUN_BUDGET / 16);
  const b = Buffer.from(`{"model":"${MODEL}","max_tokens":64,"messages":[{"role":"user","content":[${'{"text":"\\na\\na\\na\\na"},'.repeat(blocks)}{"text":"x"}]}]}`);
  expect(countJsonValuesUpTo(b, BODY_VALUE_BUDGET)).toBeLessThanOrEqual(BODY_VALUE_BUDGET);
  const r = await send(g.url, { path: '/v1/messages', headers: authHeaders, body: b });
  expect(r.status).toBe(413);
  expect(r.body.toString()).toContain('decoded string pieces');
  expect(calls()).toBe(0);
}, 30_000);

test('S-V3-3 ordinary bodies stay far below every budget: the bench body at 30 MiB uses under 60% of the runs', async () => {
  const { syntheticBody } = await import('../../bench/scan.js');
  const b = syntheticBody(30);
  const f = extractAnthropicFeatures(b);
  const budget = new ScanBudget(1e12, 1e12);
  scanBody(b, f.lastTurn, DEFAULT_RULES, () => 'block', 's', { ...(f.messages ? { messages: f.messages } : {}), budget });
  expect(budget.used().runs).toBeLessThan(SCAN_RUN_BUDGET * 0.6);
  expect(budget.used().matches).toBeLessThan(SCAN_MATCH_BUDGET / 100);
  expect(countJsonValuesUpTo(b, BODY_VALUE_BUDGET)).toBeLessThan(BODY_VALUE_BUDGET / 10);
}, 30_000);
