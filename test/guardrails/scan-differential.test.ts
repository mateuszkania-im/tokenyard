// V1: the scanner was optimised (one keyword pass per view, single-piece messages left out of the joined view, runs
// sliced from one latin1 copy). Every result must stay what the pre-V1 scanner (scan-reference.ts) returns.
import fc from 'fast-check';
import { expect, test } from 'vitest';
import { PII_RULES } from '../../src/guardrails/pii.js';
import { DEFAULT_RULES } from '../../src/guardrails/rules.js';
import { findSpans, scanBody } from '../../src/guardrails/scan.js';
import { extractAnthropicFeatures } from '../../src/surfaces/anthropic-messages.js';
import { RULE_FIXTURES } from './fixtures.js';
import * as ref from './scan-reference.js';
import { fuzz } from '../helpers/fuzz.js';

const SECRETS = [...Object.values(RULE_FIXTURES).flatMap((f) => [f.positive, f.negative]), 'jan.kowalski@example.com', '44051401458', 'DE89370400440532013000', '4111 1111 1111 1111'];
const FILLER = ['export const x = 1;\n', 'token: ', 'apiKey=', '"quoted"', '\\', '\t', 'é', ' ', '\0', ' ', 'AKIA', 'sk-ant-', 'ghp_', '-----BEGIN', 'secret = '];

/** Text that holds secrets (or near misses) among filler, so it can be cut across blocks anywhere. */
const text = fc.array(fc.oneof(fc.constantFrom(...SECRETS), fc.constantFrom(...FILLER), fc.string({ maxLength: 12 })), { maxLength: 6 }).map((p) => p.join(''));
/** One message: its text split into 1 to 4 blocks of text, tool results or thinking, or a plain string content. */
const message = fc.record({
  role: fc.constantFrom('user', 'assistant'),
  text,
  cuts: fc.array(fc.nat(), { maxLength: 3 }),
  kind: fc.constantFrom('string', 'text', 'tool_result', 'thinking', 'mixed'),
}).map(({ role, text: t, cuts, kind }) => {
  if (kind === 'string') return { role, content: t };
  const at = [...new Set(cuts.map((c) => c % (t.length + 1)))].sort((a, b) => a - b);
  const pieces = [0, ...at, t.length].slice(0, -1).map((s, i, a) => t.slice(s, i + 1 < a.length ? a[i + 1] : t.length));
  const block = (p: string, i: number): unknown =>
    kind === 'tool_result' || (kind === 'mixed' && i % 2 === 1) ? { type: 'tool_result', tool_use_id: `t${i}`, content: p }
    : kind === 'thinking' ? { type: 'thinking', thinking: p, signature: 'sig' }
    : { type: 'text', text: p };
  return { role, content: pieces.map(block) };
});
const body = fc.record({ messages: fc.array(message, { minLength: 1, maxLength: 6 }), system: fc.option(text, { nil: undefined }), unicodeEscapes: fc.boolean() }).map(({ messages, system, unicodeEscapes }) => {
  let s = JSON.stringify({ model: 'm', max_tokens: 10, ...(system === undefined ? {} : { system }), messages });
  // Another writer may escape characters JSON.stringify leaves alone: the scanner must decode them the same way.
  if (unicodeEscapes) s = s.replace(/[A-Za-z_-]/g, (c) => (c.charCodeAt(0) % 3 === 0 ? `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}` : c));
  return Buffer.from(s);
});

const spans = (xs: Array<{ rule: { id: string }; start: number; end: number; value: string; segments: unknown[] }>): unknown[] => xs.map((x) => ({ rule: x.rule.id, start: x.start, end: x.end, value: x.value, segments: x.segments }));

test('optimised scanner returns what the pre-V1 scanner returns: hits, spans, segments, on structured and raw bodies', () => {
  fc.assert(
    fc.property(body, fc.constantFrom<'block' | 'warn' | 'redact'>('block', 'warn', 'redact'), fc.boolean(), (b, action, raw) => {
      const f = extractAnthropicFeatures(b);
      const lastTurn = raw ? { start: 0, end: b.length } : f.lastTurn;
      const opts = { ...(f.messages && !raw ? { messages: f.messages } : {}), raw };
      expect(scanBody(b, lastTurn, DEFAULT_RULES, () => action, 'salt', opts)).toEqual(ref.scanBody(b, lastTurn, DEFAULT_RULES, () => action, 'salt', opts));
      const pii = { ...opts, quotedOnly: false, valueHmac: false };
      expect(scanBody(b, lastTurn, PII_RULES, () => action, 'salt', pii)).toEqual(ref.scanBody(b, lastTurn, PII_RULES, () => action, 'salt', pii));
      const rules = [...DEFAULT_RULES, ...PII_RULES];
      expect(spans(findSpans(b, rules, opts))).toEqual(spans(ref.findSpans(b, rules, opts)));
    }),
    fuzz(5111, 1_500),
  );
});
