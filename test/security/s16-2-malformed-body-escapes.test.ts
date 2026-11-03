// S16-2 (coordinator finding, Task 16, MEDIUM): the parseError fallback scanned latin1 raw bytes only, so a malformed
// body with \u-escaped secrets passed (a regression against the decoded view). The gateway still forwards the
// malformed body (the provider answers its own 400), but now scans the raw bytes AND a best-effort decoded copy.
import { expect, test } from 'vitest';
import { pseudonym } from '../../src/guardrails/hmac.js';
import { DEFAULT_RULES } from '../../src/guardrails/rules.js';
import { scanBody } from '../../src/guardrails/scan.js';
import { RULE_FIXTURES } from '../guardrails/fixtures.js';

const AWS = RULE_FIXTURES['aws-access-key-id']?.positive as string;
const GH = RULE_FIXTURES['github-pat']?.positive as string;
const block = (): 'block' => 'block';
const scanRaw = (b: Buffer) => scanBody(b, { start: 0, end: b.length }, DEFAULT_RULES, block, 's', { raw: true });

test('S16-2 a malformed body with a \\u-escaped AWS key is blocked, also right after a \\n escape', () => {
  const escaped = `\\u0041${AWS.slice(1)}`;
  for (const content of [`key ${escaped}`, `line\\n${escaped}`, `tab\\t${escaped}`, `slash\\/${escaped}`]) {
    const broken = Buffer.from(`{"model":"m","messages":[{"role":"user","content":"${content}"}`);
    expect(scanRaw(broken), content).toEqual([{ rule: 'aws-access-key-id', action: 'block', valueHmac: pseudonym('s', AWS), where: 'last-turn' }]);
  }
});

test('S16-2 an invalid escape in the malformed body does not hide the decoded copy', () => {
  const broken = Buffer.from(`{"model":"m","messages":[{"role":"user","content":"\\q \\u0067${GH.slice(1)}"`);
  expect(scanRaw(broken)).toMatchObject([{ rule: 'github-pat', valueHmac: pseudonym('s', GH) }]);
});

test('S16-2 raw and decoded views report one key once, not twice', () => {
  const broken = Buffer.from(`{"model":"m","messages":[{"role":"user","content":"${AWS} then ${AWS}`);
  expect(scanRaw(broken)).toHaveLength(1);
});
