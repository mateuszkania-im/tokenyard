import fc from 'fast-check';
import { expect, test } from 'vitest';
import { pseudonym } from '../../src/guardrails/hmac.js';
import { PII_RULES } from '../../src/guardrails/pii.js';
import { DEFAULT_RULES, type SecretRule } from '../../src/guardrails/rules.js';
import { findSpans, keywordsIn, scanBody, shannonEntropy } from '../../src/guardrails/scan.js';
import { extractAnthropicFeatures } from '../../src/surfaces/anthropic-messages.js';
import { RULE_FIXTURES } from './fixtures.js';
import { cpuBoundMs, minCpuMs, TIMING_BOUNDS } from '../helpers/timing.js';
import { fuzz } from '../helpers/fuzz.js';

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

// Fix round 1: rules run on decoded JSON string content, not on the raw escaped bytes.
const raw = (jsonString: string): Buffer => Buffer.from(`{"model":"m","messages":[{"role":"user","content":"${jsonString}"}]}`);
const scanLast = (b: Buffer, salt = 's'): ReturnType<typeof scanBody> => {
  const f = extractAnthropicFeatures(b);
  return scanBody(b, f.lastTurn, DEFAULT_RULES, block, salt, { messages: f.messages });
};

test('decoded content: a secret right after a \\n or \\t escape (cat -n output) is found', () => {
  expect(scanLast(body([{ role: 'user', content: `line1\n${AWS}` }]).b)).toEqual([{ rule: 'aws-access-key-id', action: 'block', valueHmac: pseudonym('s', AWS), where: 'last-turn', message: 0 }]);
  const catN = `     1\t${GH}\n     2\tnext line\n`;
  expect(scanLast(body([{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: catN }] }]).b)).toMatchObject([{ rule: 'github-pat', valueHmac: pseudonym('s', GH) }]);
});

test('decoded content: \\uXXXX and \\/ escapes are decoded before matching, and the HMAC is of the decoded value', () => {
  expect(scanLast(raw(`see \\u0041${AWS.slice(1)} now`))).toMatchObject([{ rule: 'aws-access-key-id', valueHmac: pseudonym('s', AWS) }]);
  expect(scanLast(raw(`see ${AWS.slice(0, 4)}\\u004${AWS.charCodeAt(4).toString(16).slice(1)}${AWS.slice(5)}`))).toMatchObject([{ valueHmac: pseudonym('s', AWS) }]);
  const value = `${GENERIC.slice(11, 31)}/${GENERIC.slice(31, 51)}`;
  const hits = scanLast(raw(`api_key = ${value.replace('/', '\\/')}`));
  expect(hits).toMatchObject([{ rule: 'generic-secret-assignment', action: 'warn', valueHmac: pseudonym('s', value) }]);
});

test('decoded content: a key split across two text blocks of the last message is found once, as the whole value', () => {
  const split = body([{ role: 'user', content: [{ type: 'text', text: `key ${AWS.slice(0, 10)}` }, { type: 'text', text: `${AWS.slice(10)} end` }] }]);
  expect(scanLast(split.b)).toEqual([{ rule: 'aws-access-key-id', action: 'block', valueHmac: pseudonym('s', AWS), where: 'last-turn', message: 0 }]);
  // Inside a tool_result's text blocks too.
  const inTool = body([{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: GH.slice(0, 7) }, { type: 'text', text: GH.slice(7) }] }] }]);
  expect(scanLast(inTool.b)).toMatchObject([{ rule: 'github-pat', valueHmac: pseudonym('s', GH) }]);
});

test('decoded content: joining never crosses messages, keys or structure', () => {
  const across = body([{ role: 'user', content: AWS.slice(0, 10) }, { role: 'assistant', content: AWS.slice(10) }, { role: 'user', content: 'x' }]);
  expect(scanLast(across.b)).toEqual([]);
  // A key name next to a value is not joined into one string.
  const b = Buffer.from(JSON.stringify({ messages: [{ role: 'user', content: [{ type: 'text', text: 'x', AKIAIOSFODNN: 'N7EXAMPLE' }] }] }));
  expect(scanLast(b)).toEqual([]);
});

test('taint matches when the same secret comes back escaped differently in history', () => {
  const first = scanLast(body([{ role: 'user', content: AWS }]).b);
  const later = Buffer.from(`{"model":"m","messages":[{"role":"user","content":"\\u0041${AWS.slice(1)}"},{"role":"assistant","content":"ok"},{"role":"user","content":"go"}]}`);
  const history = scanLast(later);
  expect(history).toMatchObject([{ where: 'history', message: 0 }]);
  expect(history[0]?.valueHmac).toBe(first[0]?.valueHmac);
});

// Fix round 2: the scanner must not see less than a lenient upstream parser would.
test('non-string tokens: a secret in a bare or number-like token is found', () => {
  const lenient = Buffer.from(`{"model":"m","messages":[{"role":"user","content":"x","note":${AWS}}]}`);
  const hits = scanBody(lenient, { start: 0, end: lenient.length }, DEFAULT_RULES, block, 's');
  expect(hits).toMatchObject([{ rule: 'aws-access-key-id', valueHmac: pseudonym('s', AWS) }]);
  const tokenKey = RULE_FIXTURES['tokenyard-key']?.positive as string;
  const bare = Buffer.from(`{"messages":[{"role":"user","content":[${tokenKey}]}]}`);
  expect(scanBody(bare, { start: 0, end: bare.length }, DEFAULT_RULES, block, 's')).toMatchObject([{ rule: 'tokenyard-key' }]);
});

test('object members read as "key: value": an assignment split into a JSON key and its value is found', () => {
  const value = GENERIC.slice(11, 51);
  const { b, lastTurn, messages } = body([{ role: 'user', content: [{ type: 'tool_use_like', api_key: value }] }]);
  expect(scanBody(b, lastTurn, DEFAULT_RULES, block, 's', { messages })).toMatchObject([{ rule: 'generic-secret-assignment', valueHmac: pseudonym('s', value) }]);
});

test('a malformed body is scanned as raw bytes', () => {
  const broken = Buffer.from(`{"model":"m","messages":[{"role":"user","content":"key ${AWS} and \\q"}`);
  expect(scanBody(broken, { start: 0, end: broken.length }, DEFAULT_RULES, block, 's', { raw: true })).toMatchObject([{ rule: 'aws-access-key-id', where: 'last-turn' }]);
});

test('an AKIA key written entirely in \\u escapes is found', () => {
  const escaped = [...AWS].map((c) => `\\u00${c.charCodeAt(0).toString(16)}`).join('');
  expect(scanLast(raw(`k ${escaped} k`))).toMatchObject([{ rule: 'aws-access-key-id', valueHmac: pseudonym('s', AWS) }]);
});

test.skipIf(!TIMING_BOUNDS)('many messages with one hit each: linear, not hits times messages', () => {
  const messages: unknown[] = [];
  let size = 0;
  for (let i = 0; size < 4 * 1024 * 1024; i++) {
    const email = `user${i}@example.com`;
    messages.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `mail ${email}` });
    size += email.length + 45;
  }
  messages.push({ role: 'user', content: 'end' });
  const b = Buffer.from(JSON.stringify({ model: 'm', messages }));
  const f = extractAnthropicFeatures(b);
  let hits: ReturnType<typeof scanBody> = [];
  // CPU time: a loaded machine stretches the wall clock, not the work (V5). The least of three runs: one ~1 s run on
  // a Windows runner (750 to 1079 ms measured) is decided by a GC pause otherwise; quadratic growth fails all three.
  const ms = minCpuMs(() => {
    hits = scanBody(b, f.lastTurn, PII_RULES, block, 's', { messages: f.messages });
  });
  expect(hits.length).toBe(messages.length - 1);
  expect(hits[hits.length - 1]?.message).toBe(messages.length - 2);
  console.log(`many messages: ${messages.length} messages, ${hits.length} hits, ${ms.toFixed(0)} ms`);
  expect(ms).toBeLessThan(cpuBoundMs(1_000));
}, 60_000);

// Fix round 3: a malformed body is scanned both raw and best-effort decoded.
test('malformed body: a \\u-escaped key is found by the decoded copy, also right after a \\n escape', () => {
  const escaped = `\\u0041${AWS.slice(1)}`;
  for (const content of [`key ${escaped}`, `line\\n${escaped}`]) {
    const broken = Buffer.from(`{"model":"m","messages":[{"role":"user","content":"${content}"}`);
    expect(scanBody(broken, { start: 0, end: broken.length }, DEFAULT_RULES, block, 's', { raw: true })).toEqual([
      { rule: 'aws-access-key-id', action: 'block', valueHmac: pseudonym('s', AWS), where: 'last-turn' },
    ]);
  }
});

test('keywordsIn finds exactly the keywords String.includes finds, prefixes and overlaps included (V1: one pass per view)', () => {
  const alphabet = fc.constantFrom('a', 'b', 'k', '-', '_', 'A', 'K', 'I', 'S', '\0', 'x');
  const word = fc.string({ unit: alphabet, minLength: 1, maxLength: 5 });
  fc.assert(
    fc.property(fc.uniqueArray(word, { maxLength: 8 }), fc.string({ unit: alphabet, maxLength: 200 }), (keywords, text) => {
      const want = new Set(keywords.filter((k) => text.includes(k)));
      expect(keywordsIn(text, keywords)).toEqual(want);
    }),
    fuzz(5101, 2_000),
  );
  const all = [...new Set([...DEFAULT_RULES, ...PII_RULES].flatMap((r) => r.keywords))];
  const text = `x ${all.join(' y ')} z api_key apiKey sk-ant- sk-proj-`;
  expect(keywordsIn(text, all)).toEqual(new Set(all));
  expect(keywordsIn('nothing here', all)).toEqual(new Set());
});

test('a rule with an empty keyword is never skipped by the prefilter, as String.includes("") is always true (V1 fix round)', () => {
  expect(keywordsIn('abc', ['', 'x'])).toEqual(new Set(['']));
  const rule: SecretRule = { id: 'any-digits', keywords: [''], regex: /(\d{6})/, source: 'test', licence: 'MIT' };
  const b = Buffer.from(JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'code 123456' }] }));
  expect(findSpans(b, [rule]).map((s) => s.value)).toEqual(['123456']);
});
