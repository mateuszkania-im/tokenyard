import { expect, test } from 'vitest';
import { pseudonym } from '../../src/guardrails/hmac.js';
import { DEFAULT_RULES, type SecretRule } from '../../src/guardrails/rules.js';
import { scanBody, shannonEntropy } from '../../src/guardrails/scan.js';
import { extractAnthropicFeatures } from '../../src/surfaces/anthropic-messages.js';
import { RULE_FIXTURES } from './fixtures.js';

const AWS = RULE_FIXTURES['aws-access-key-id']?.positive as string;
const GH = RULE_FIXTURES['github-pat']?.positive as string;
const GENERIC = RULE_FIXTURES['generic-secret-assignment']?.positive as string;
const block = (): 'block' => 'block';

function body(messages: unknown[], extra: Record<string, unknown> = {}): { b: Buffer; lastTurn: ReturnType<typeof extractAnthropicFeatures>['lastTurn']; messages: ReturnType<typeof extractAnthropicFeatures>['messages'] } {
  const b = Buffer.from(JSON.stringify({ model: 'm', ...extra, messages }));
  const f = extractAnthropicFeatures(b);
  return { b, lastTurn: f.lastTurn, messages: f.messages };
}

test('last turn: every rule, hit carries the HMAC of the value and the message index, never the value', () => {
  const { b, lastTurn, messages } = body([
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: `AWS_ACCESS_KEY_ID=${AWS}` }] },
  ]);
  const hits = scanBody(b, lastTurn, DEFAULT_RULES, block, 'salt', { messages });
  expect(hits).toEqual([{ rule: 'aws-access-key-id', action: 'block', valueHmac: pseudonym('salt', AWS), where: 'last-turn', message: 2 }]);
  expect(JSON.stringify(hits)).not.toContain(AWS);
});

test('history: only block rules, reported as HMACs with where history; the same value twice is one hit', () => {
  const { b, lastTurn, messages } = body([
    { role: 'user', content: `token ${GH}` },
    { role: 'assistant', content: `I saw ${GH}` },
    { role: 'user', content: 'continue' },
  ]);
  const hits = scanBody(b, lastTurn, DEFAULT_RULES, block, 'salt', { messages });
  expect(hits).toEqual([{ rule: 'github-pat', action: 'block', valueHmac: pseudonym('salt', GH), where: 'history', message: 0 }]);
  // A warn rule is not scanned in history at all.
  expect(scanBody(b, lastTurn, DEFAULT_RULES, () => 'warn', 'salt', { messages })).toEqual([]);
});

test('system and tools are history, without a message index', () => {
  const { b, lastTurn, messages } = body([{ role: 'user', content: 'x' }], { system: `key ${AWS}` });
  expect(scanBody(b, lastTurn, DEFAULT_RULES, block, 's', { messages })).toEqual([{ rule: 'aws-access-key-id', action: 'block', valueHmac: pseudonym('s', AWS), where: 'history' }]);
});

test('entropy-only hits never block: forced to warn in the last turn, not scanned in history', () => {
  const { b, lastTurn, messages } = body([{ role: 'user', content: GENERIC }]);
  const hits = scanBody(b, lastTurn, DEFAULT_RULES, block, 's', { messages });
  expect(hits).toHaveLength(1);
  expect(hits[0]).toMatchObject({ rule: 'generic-secret-assignment', action: 'warn', where: 'last-turn' });
  const later = body([{ role: 'user', content: GENERIC }, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'go' }]);
  expect(scanBody(later.b, later.lastTurn, DEFAULT_RULES, block, 's', { messages: later.messages })).toEqual([]);
  expect(shannonEntropy('aaaa')).toBe(0);
  expect(shannonEntropy('abcd')).toBe(2);
});

test('keyword prefilter: a rule whose keywords are absent never runs its regex', () => {
  const rule = (keywords: string[]): SecretRule => ({ id: 'probe', keywords, regex: /secret-[a-z]+/, source: 'test', licence: 'MIT' });
  const { b, lastTurn } = body([{ role: 'user', content: 'a secret-abc here' }]);
  // The regex alone would match; a keyword that is not in the body keeps it from running.
  expect(scanBody(b, lastTurn, [rule(['zzz'])], block, 's')).toEqual([]);
  expect(scanBody(b, lastTurn, [rule(['secret-'])], block, 's')).toHaveLength(1);
  // A keyword outside the scanned range does not count either.
  const later = body([{ role: 'user', content: 'zzz' }, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'a secret-abc here' }]);
  expect(scanBody(later.b, later.lastTurn, [rule(['zzz'])], block, 's')).toEqual([]);
});

test('no last turn: the whole body is history', () => {
  const b = Buffer.from(JSON.stringify({ system: `x ${GH}` }));
  expect(scanBody(b, null, DEFAULT_RULES, block, 's')).toEqual([{ rule: 'github-pat', action: 'block', valueHmac: pseudonym('s', GH), where: 'history' }]);
});
