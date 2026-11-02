import { expect, test } from 'vitest';
import { PII_RULES } from '../../src/guardrails/pii.js';
import { redactProductBody } from '../../src/guardrails/redact.js';
import { DEFAULT_RULES } from '../../src/guardrails/rules.js';
import { findSpans } from '../../src/guardrails/scan.js';
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
  const hits = findSpans(b, [...DEFAULT_RULES, ...PII_RULES]).map((s) => ({ rule: s.rule.id, start: s.start, end: s.end }));
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
