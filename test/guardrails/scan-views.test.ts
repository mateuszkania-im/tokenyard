// What the scanner's decoded view holds and how its findings are placed (V5: the mutation run left these unpinned):
// strings separated so no rule matches across them, `key: value` for object members, bare tokens, the work budget
// error, bare numbers at the edges of the body, the message index of a hit, the last turn's own message range and
// `quotedOnly`. ALL captures a whole view, so each case states the exact text the rules see.
import { expect, test } from 'vitest';
import { PII_RULES } from '../../src/guardrails/pii.js';
import type { SecretRule } from '../../src/guardrails/rules.js';
import { DEFAULT_RULES } from '../../src/guardrails/rules.js';
import { findSpans, ScanBudget, ScanBudgetError, scanBody, shannonEntropy } from '../../src/guardrails/scan.js';
import { extractAnthropicFeatures } from '../../src/surfaces/anthropic-messages.js';
import { RULE_FIXTURES } from './fixtures.js';

const ALL: SecretRule = { id: 'all', keywords: [], regex: /^([\s\S]+)$/, source: 't', licence: 'MIT' };
const view = (json: string): string => {
  const spans = findSpans(Buffer.from(json), [ALL]);
  expect(spans).toHaveLength(1);
  return (spans[0] as { value: string }).value;
};

test('the view: strings and tokens separated by NUL, `key: value` for members, structure and whitespace dropped', () => {
  expect(view('{"password":"hunter2"}')).toBe('password: hunter2');
  expect(view('{"k" \t\r\n:\n "v"}')).toBe('k: v');
  expect(view('["a","b"]')).toBe('a\0b');
  expect(view('{"k":1,"v":"z"}')).toBe('k: 1\0v: z');
  expect(view('{"k":true,"n":null}')).toBe('k: true\0n: null');
  // a nested object or array after a key: the key stands alone, its members follow
  expect(view('{"a":{"b":"c"}}')).toBe('a\0b: c');
  expect(view('{"a":["x",2]}')).toBe('a\0x\x002');
  // a string that is an array element after a member is not a member value
  expect(view('{"k":"v","arr":["w"]}')).toBe('k: v\0arr\0w');
  expect(view('[1 ,2\t,\n3]')).toBe('1\x002\x003');
  expect(view('{"k":"a\\nb\\u0041"}')).toBe('k: a\nbA');
  // empty strings add nothing, not even a separator
  expect(findSpans(Buffer.from('{"":""}'), [ALL])).toEqual([]);
  expect(view('["","a"]')).toBe('a');
});

test('no rule matches across two strings, a key and a nested value, or two tokens', () => {
  const AB: SecretRule = { id: 'ab', keywords: ['a'], regex: /ab/, source: 't', licence: 'MIT' };
  expect(findSpans(Buffer.from('["a","b"]'), [AB])).toEqual([]);
  expect(findSpans(Buffer.from('{"a":{"b":1}}'), [AB])).toEqual([]);
  expect(findSpans(Buffer.from('["xa", "bx"]'), [AB])).toEqual([]);
  expect(findSpans(Buffer.from('["xab"]'), [AB]).map((s) => [s.start, s.end])).toEqual([[3, 5]]);
  // nothing to scan: no rules, or an empty range
  expect(findSpans(Buffer.from('["ab"]'), [])).toEqual([]);
  expect(findSpans(Buffer.from('["ab"]'), [AB], { range: { start: 3, end: 3 } })).toEqual([]);
});

test('a rule without a capture group reports the whole match at its own position', () => {
  const DIGITS: SecretRule = { id: 'd', keywords: [], regex: /\d{5}/, source: 't', licence: 'MIT' };
  const b = Buffer.from('{"k":"ab12345cd"}');
  expect(findSpans(b, [DIGITS]).map((s) => [s.value, s.start, s.end])).toEqual([['12345', 8, 13]]);
  expect(b.toString('latin1', 8, 13)).toBe('12345');
});

test('the work budget error names its counter and limit', () => {
  const runs = new ScanBudgetError('runs', 7);
  expect(runs.message).toBe('the secret scan stopped after 7 decoded string pieces');
  expect(runs.name).toBe('ScanBudgetError');
  expect(new ScanBudgetError('matches', 9).message).toBe('the secret scan stopped after 9 rule matches');
  expect(() => findSpans(Buffer.from('["a","b","c"]'), [ALL], { budget: new ScanBudget(2, 100) })).toThrow('stopped after 2 decoded string pieces');
});

test('entropy of an empty value is 0; of n distinct characters log2(n)', () => {
  expect(shannonEntropy('')).toBe(0);
  expect(shannonEntropy('aaaa')).toBe(0);
  expect(shannonEntropy('abcd')).toBe(2);
});

const CARD = PII_RULES.find((r) => r.id === 'card-number') as SecretRule;

test('a bare card number is a hit when it is a whole token: at the start or end of the body, before whitespace or structure', () => {
  for (const json of ['4111111111111111', ' 4111111111111111\n', '[4111111111111111]', '{"n":4111111111111111}', '{"n":\t4111111111111111 }']) {
    expect(findSpans(Buffer.from(json), [CARD]).map((s) => s.value), json).toEqual(['4111111111111111']);
  }
  // quoted only: bare tokens are not PII
  expect(findSpans(Buffer.from('[4111111111111111]'), [CARD], { quotedOnly: true })).toEqual([]);
  expect(findSpans(Buffer.from('["4111111111111111"]'), [CARD], { quotedOnly: true })).toHaveLength(1);
});

const SECRET = (RULE_FIXTURES['anthropic-api-key'] as { positive: string }).positive;
const msgBody = (contents: string[], extra = ''): Buffer =>
  Buffer.from(`{"model":"m","max_tokens":8,"messages":[${contents.map((c, i) => `{"role":"${i % 2 ? 'assistant' : 'user'}","content":${c}}`).join(',')}]${extra}}`);

test('a hit names the index of the message it is in, from its first byte; a hit outside every message names none', () => {
  const b = msgBody([JSON.stringify('hello'), JSON.stringify('ok'), JSON.stringify(SECRET)], `,"metadata":{"user_id":${JSON.stringify(SECRET)}}`);
  const f = extractAnthropicFeatures(b);
  const hits = scanBody(b, f.lastTurn, DEFAULT_RULES, () => 'block', 's', f.messages ? { messages: f.messages } : {});
  const ours = hits.filter((h) => h.rule === 'anthropic-api-key');
  expect(ours.map((h) => [h.where, h.message])).toEqual([['last-turn', 2], ['history', undefined]]);
  expect('message' in (ours[1] as object)).toBe(false);
  // a hit at the very first byte of a message, and in the first message
  const first = msgBody([JSON.stringify(SECRET)]);
  const ff = extractAnthropicFeatures(first);
  expect(scanBody(first, ff.lastTurn, DEFAULT_RULES, () => 'block', 's', ff.messages ? { messages: ff.messages } : {}).filter((h) => h.rule === 'anthropic-api-key').map((h) => h.message)).toEqual([0]);
});

test('a secret split over two text blocks of the last turn is found when the caller passes no message ranges', () => {
  const half = Math.floor(SECRET.length / 2);
  const b = msgBody([`[{"type":"text","text":${JSON.stringify(SECRET.slice(0, half))}},{"type":"text","text":${JSON.stringify(SECRET.slice(half))}}]`]);
  const f = extractAnthropicFeatures(b);
  expect(scanBody(b, f.lastTurn, DEFAULT_RULES, () => 'block', 's').map((h) => [h.rule, h.where])).toContainEqual(['anthropic-api-key', 'last-turn']);
});

test('scanBody passes quotedOnly to every region: bare numbers are not PII on product routes that ask for it', () => {
  const b = msgBody([JSON.stringify('card please')], ',"metadata":{"n":4111111111111111}');
  const f = extractAnthropicFeatures(b);
  const run = (quotedOnly: boolean) => scanBody(b, f.lastTurn, PII_RULES, () => 'redact', 's', { ...(f.messages ? { messages: f.messages } : {}), quotedOnly, valueHmac: false }).map((h) => h.rule);
  expect(run(false)).toContain('card-number');
  expect(run(true)).not.toContain('card-number');
});

test('raw scan: a value found both raw and decoded at the same bytes is reported once; one only decoded is added', () => {
  const plain = Buffer.from(`{"content":"${SECRET}`);
  expect(findSpans(plain, DEFAULT_RULES, { raw: true }).filter((s) => s.rule.id === 'anthropic-api-key')).toHaveLength(1);
  const escaped = Buffer.from(`{"content":"${SECRET.slice(0, 3)}\\u00${SECRET.charCodeAt(3).toString(16)}${SECRET.slice(4)}`);
  expect(findSpans(escaped, DEFAULT_RULES, { raw: true }).filter((s) => s.rule.id === 'anthropic-api-key').map((s) => s.value)).toEqual([SECRET]);
});
