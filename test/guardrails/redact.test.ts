import { expect, test } from 'vitest';
import { PII_RULES } from '../../src/guardrails/pii.js';
import { redactionHits, redactProductBody } from '../../src/guardrails/redact.js';
import { DEFAULT_RULES } from '../../src/guardrails/rules.js';
import { findSpans } from '../../src/guardrails/scan.js';
import { extractAnthropicFeatures } from '../../src/surfaces/anthropic-messages.js';
import { RULE_FIXTURES } from './fixtures.js';

const AWS = RULE_FIXTURES['aws-access-key-id']?.positive as string;
const KEY = RULE_FIXTURES['private-key']?.positive as string;

test('redact: placeholders numbered per rule and value, every other byte kept, valid JSON', () => {
  const original = {
    model: 'm',
    messages: [
      { role: 'user', content: `a@example.com and b@example.com, again a@example.com; key ${AWS}` },
      { role: 'user', content: `pem ${KEY} done` },
    ],
  };
  const b = Buffer.from(JSON.stringify(original));
  const hits = redactionHits(findSpans(b, [...DEFAULT_RULES, ...PII_RULES]));
  const out = redactProductBody(b, hits);
  const parsed = JSON.parse(out.toString()) as typeof original;
  expect(parsed.model).toBe('m');
  expect(parsed.messages[0]?.content).toBe('[REDACTED:EMAIL_1] and [REDACTED:EMAIL_2], again [REDACTED:EMAIL_1]; key [REDACTED:AWS_ACCESS_KEY_ID_1]');
  expect(parsed.messages[1]?.content).toBe('pem [REDACTED:PRIVATE_KEY_1] done');
  expect(out.toString()).not.toContain(AWS);
});

test('redact with no hits returns the same buffer; overlapping spans keep the first', () => {
  const b = Buffer.from('{"c":"abcdef"}');
  expect(redactProductBody(b, [])).toBe(b);
  expect(redactProductBody(b, [{ rule: 'x', start: 6, end: 9 }, { rule: 'y', start: 8, end: 11 }]).toString()).toBe('{"c":"[REDACTED:X_1]def"}');
});

test('redact on decoded content: an email at line start after \\n yields valid JSON with the placeholder', () => {
  const b = Buffer.from(JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'Contact:\njan@example.com please\n\tbob@example.com' }] }));
  const out = redactProductBody(b, redactionHits(findSpans(b, PII_RULES)));
  const parsed = JSON.parse(out.toString()) as { messages: Array<{ content: string }> };
  expect(parsed.messages[0]?.content).toBe('Contact:\n[REDACTED:EMAIL_1] please\n\t[REDACTED:EMAIL_2]');
});

test('redact a key split across two text blocks: placeholder in the first, the rest removed, valid JSON', () => {
  const b = Buffer.from(JSON.stringify({ messages: [{ role: 'user', content: [{ type: 'text', text: `key ${AWS.slice(0, 10)}` }, { type: 'text', text: `${AWS.slice(10)} end` }] }] }));
  const out = redactProductBody(b, redactionHits(findSpans(b, DEFAULT_RULES, { messages: extractAnthropicFeatures(b).messages })));
  const parsed = JSON.parse(out.toString()) as { messages: Array<{ content: Array<{ text: string }> }> };
  expect(parsed.messages[0]?.content.map((c) => c.text)).toEqual(['key [REDACTED:AWS_ACCESS_KEY_ID_1]', ' end']);
});
