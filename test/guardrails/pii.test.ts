import { expect, test } from 'vitest';
import { PII_RULES, ibanValid, luhnValid, peselValid } from '../../src/guardrails/pii.js';
import { findSpans } from '../../src/guardrails/scan.js';

const spans = (text: string): Array<[string, string]> => findSpans(Buffer.from(JSON.stringify({ c: text })), PII_RULES).map((s) => [s.rule.id, s.value]);

test('PII: PESEL checksum, IBAN mod-97 and Luhn reject near-misses', () => {
  expect(peselValid('44051401359')).toBe(true);
  expect(peselValid('44051401358')).toBe(false);
  expect(peselValid('44135401359')).toBe(false); // month 13
  expect(ibanValid('GB82WEST12345698765432')).toBe(true);
  expect(ibanValid('GB82 WEST 1234 5698 7654 32')).toBe(true);
  expect(ibanValid('GB82WEST12345698765431')).toBe(false);
  expect(ibanValid('PL61109010140000071219812874')).toBe(true);
  expect(ibanValid('PL61109010140000071219812875')).toBe(false);
  expect(luhnValid('4111111111111111')).toBe(true);
  expect(luhnValid('4111 1111 1111 1111')).toBe(true);
  expect(luhnValid('4111111111111112')).toBe(false);

  expect(spans('mail jan.kowalski@example.com now')).toEqual([['email', 'jan.kowalski@example.com']]);
  expect(spans('pesel 44051401359.')).toEqual([['pesel', '44051401359']]);
  expect(spans('pesel 44051401358.')).toEqual([]);
  expect(spans('iban PL61109010140000071219812874 ok')).toEqual([['iban', 'PL61109010140000071219812874']]);
  expect(spans('iban PL61109010140000071219812875 ok')).toEqual([]);
  expect(spans('card 4111 1111 1111 1111 ok')).toEqual([['card-number', '4111 1111 1111 1111']]);
  expect(spans('card 4111111111111112 ok')).toEqual([]);
  expect(spans('order 12345 shipped')).toEqual([]);
});
