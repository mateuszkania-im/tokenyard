// S16-3 (coordinator finding, Task 16, MEDIUM): quotedOnly on pesel and card-number skipped JSON-number card and PESEL
// values entirely, so they escaped redaction on product routes and detection on agent routes. Bare numeric tokens are
// scanned again, skipped only when they cannot be valid values (signed, decimal, exponent, checksum failure, epoch-ms
// shaped), and a bare hit is redacted by replacing the whole token with a quoted placeholder so the JSON stays valid.
import { expect, test } from 'vitest';
import { luhnValid, PII_RULES } from '../../src/guardrails/pii.js';
import { redactionHits, redactProductBody } from '../../src/guardrails/redact.js';
import { findSpans } from '../../src/guardrails/scan.js';

const found = (json: string, quotedOnly = false): Array<[string, string]> => findSpans(Buffer.from(json), PII_RULES, { quotedOnly }).map((s) => [s.rule.id, s.value]);

test('S16-3 a card number and a PESEL sent as JSON numbers are found by default', () => {
  expect(found('{"card":4111111111111111}')).toEqual([['card-number', '4111111111111111']]);
  expect(found('{"p":44051401359}')).toEqual([['pesel', '44051401359']]);
});

test('S16-3 forms that cannot be valid values are not flagged', () => {
  expect(found('[4111111111111112,44051401358]')).toEqual([]);
  expect(found('[-4111111111111111,1.4111111111111111,4111111111111111e2,4111111111111111E2,-44051401359]')).toEqual([]);
  let ts = 1_730_000_000_000;
  while (!luhnValid(String(ts))) ts++;
  expect(found(`{"ts":${ts}}`)).toEqual([]);
  expect(found(`{"ts":"${ts}"}`)).toEqual([['card-number', String(ts)]]);
});

test('S16-3 redacting a bare numeric hit leaves valid JSON with a quoted placeholder; other numbers stay', () => {
  const b = Buffer.from('{"card":4111111111111111,"p":44051401359,"neg":-4111111111111111,"n":7}');
  const out = redactProductBody(b, redactionHits(findSpans(b, PII_RULES)));
  expect(JSON.parse(out.toString())).toEqual({ card: '[REDACTED:CARD_NUMBER_1]', p: '[REDACTED:PESEL_1]', neg: -4111111111111111, n: 7 });
});
