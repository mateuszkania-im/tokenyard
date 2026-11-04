// S16-1 (coordinator finding, Task 16, MEDIUM): the scanner view covered only JSON string contents, so secrets in
// non-string tokens, in key/value pairs split across tokens and in the raw bytes of a body the gateway cannot parse
// passed the scanner while a lenient provider parser would have read them. The scanner now reads non-string tokens as
// plain runs, presents members as "key: value", and scans the raw bytes when parsing fails.
import { expect, test } from 'vitest';
import { pseudonym } from '../../src/guardrails/hmac.js';
import { DEFAULT_RULES } from '../../src/guardrails/rules.js';
import { scanBody } from '../../src/guardrails/scan.js';
import { extractAnthropicFeatures } from '../../src/surfaces/anthropic-messages.js';
import { RULE_FIXTURES } from '../guardrails/fixtures.js';

const AWS = RULE_FIXTURES['aws-access-key-id']?.positive as string;
const GENERIC = RULE_FIXTURES['generic-secret-assignment']?.positive as string;
const TY = RULE_FIXTURES['tokenyard-key']?.positive as string;
const block = (): 'block' => 'block';
const whole = (b: Buffer) => ({ start: 0, end: b.length });

test('S16-1 a secret in a non-string JSON token is found', () => {
  const b = Buffer.from(`{"model":"m","messages":[{"role":"user","content":"x","note":${AWS}}]}`);
  expect(scanBody(b, whole(b), DEFAULT_RULES, block, 's')).toMatchObject([{ rule: 'aws-access-key-id', valueHmac: pseudonym('s', AWS) }]);
  const arr = Buffer.from(`{"messages":[{"role":"user","content":[${TY}]}]}`);
  expect(scanBody(arr, whole(arr), DEFAULT_RULES, block, 's')).toMatchObject([{ rule: 'tokenyard-key' }]);
});

test('S16-1 an assignment split into a JSON key and its value is found', () => {
  const value = GENERIC.slice(11, 51);
  const b = Buffer.from(JSON.stringify({ model: 'm', messages: [{ role: 'user', content: [{ type: 'x', api_key: value }] }] }));
  const f = extractAnthropicFeatures(b);
  expect(scanBody(b, f.lastTurn, DEFAULT_RULES, block, 's', { messages: f.messages })).toMatchObject([{ rule: 'generic-secret-assignment', valueHmac: pseudonym('s', value) }]);
});

test('S16-1 a malformed body is scanned as raw bytes', () => {
  const broken = Buffer.from(`{"model":"m","messages":[{"role":"user","content":"key ${AWS} and \\q"}`);
  expect(scanBody(broken, whole(broken), DEFAULT_RULES, block, 's', { raw: true })).toMatchObject([{ rule: 'aws-access-key-id', where: 'last-turn' }]);
});

test('S16-1 an AKIA key written entirely in \\u escapes is found', () => {
  const escaped = [...AWS].map((c) => `\\u00${c.charCodeAt(0).toString(16)}`).join('');
  const b = Buffer.from(`{"model":"m","messages":[{"role":"user","content":"k ${escaped} k"}]}`);
  const f = extractAnthropicFeatures(b);
  expect(scanBody(b, f.lastTurn, DEFAULT_RULES, block, 's', { messages: f.messages })).toMatchObject([{ rule: 'aws-access-key-id', valueHmac: pseudonym('s', AWS) }]);
});
