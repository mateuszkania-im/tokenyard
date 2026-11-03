// V1: the byte-level JSON walkers were optimised (strings skipped with indexOf, one walk where several were made).
// Feature extraction, the ambiguous-key checks and the body-shape refusals must stay what the pre-V1 code returns.
import fc from 'fast-check';
import { expect, test } from 'vitest';
import { extractAnthropicFeatures, rewriteTopLevelModel, capTopLevelInteger } from '../../src/surfaces/anthropic-messages.js';
import { bodyShapeRefusal } from '../../src/surfaces/body-shape.js';
import { arrayElementRanges, duplicateTopLevelKey, skipValue, topLevelValueRanges } from '../../src/surfaces/json-ranges.js';
import { extractResponsesFeatures } from '../../src/surfaces/openai-responses.js';
import * as refA from './reference/anthropic-messages.js';
import * as refShape from './reference/body-shape.js';
import * as refJ from './reference/json-ranges.js';
import * as refO from './reference/openai-responses.js';
import { fuzz } from '../helpers/fuzz.js';

/**
 * The frozen reference with the one deliberate change since: an absent or null `service_tier` on a parsed body reads
 * as `auto` (FR-M2, final review ruling), where the reference leaves the tier out.
 */
function refResponses(b: Buffer): ReturnType<typeof refO.extractResponsesFeatures> {
  const r = refO.extractResponsesFeatures(b);
  if (r.parseError) return r;
  const parsed = JSON.parse(b.toString('utf8')) as { service_tier?: unknown };
  return parsed.service_tier === undefined || parsed.service_tier === null ? { ...r, serviceTier: 'auto' } : r;
}

/** The result or the error name, so a walker that throws on a broken body is compared too. */
const outcome = (f: () => unknown): unknown => {
  try {
    return f();
  } catch (e) {
    return { threw: e instanceof Error ? e.name : String(e) };
  }
};
const KEYS = ['model', 'messages', 'input', 'role', 'content', 'type', 'text', 'max_tokens', 'tools', 'system', 'instructions', 'output', 'arguments', 'stream', 'model\\u0020', 'mod\\u0065l'];
/** JSON text with repeated and escaped keys, escapes in strings, nesting and whitespace, as raw text (duplicates kept). */
const value: fc.Arbitrary<string> = fc.letrec<{ v: string }>((tie) => ({
  v: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    fc.constantFrom('1', '-2.5e3', 'true', 'null', '"x"', '"a\\"b\\\\"', '"\\\\"', '"\\u0041\\n"', '"é\\t"', '""'),
    fc.string({ maxLength: 8 }).map((s) => JSON.stringify(s)),
    fc.array(tie('v'), { maxLength: 4 }).map((xs) => `[ ${xs.join(' ,')}]`),
    fc.array(fc.tuple(fc.constantFrom(...KEYS), tie('v')), { maxLength: 5 }).map((kv) => `{${kv.map(([k, v]) => `"${k}" :${v}`).join(',\n')}}`),
  ),
})).v;
const top = fc.array(fc.tuple(fc.constantFrom(...KEYS), value), { maxLength: 6 }).map((kv) => ` {${kv.map(([k, v]) => `"${k}":${v}`).join(', ')}} `);
/** Mostly valid bodies, some with a BOM, some cut short or with stray bytes (the walkers must agree on those too). */
const body = fc.oneof(
  { weight: 6, arbitrary: top.map((s) => Buffer.from(s)) },
  { weight: 1, arbitrary: top.map((s) => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(s)])) },
  { weight: 2, arbitrary: fc.tuple(top, fc.nat()).map(([s, n]) => Buffer.from(s.slice(0, n % (s.length + 1)))) },
  { weight: 1, arbitrary: fc.uint8Array({ maxLength: 64 }).map((a) => Buffer.from(a)) },
);

test('json-ranges: new walkers return what the pre-V1 walkers return, on valid and broken bodies', () => {
  fc.assert(
    fc.property(body, fc.constantFrom(...KEYS.slice(0, 13)), fc.nat(), (b, key, at) => {
      expect(topLevelValueRanges(b, key)).toEqual(refJ.topLevelValueRanges(b, key));
      expect(outcome(() => arrayElementRanges(b, key))).toEqual(outcome(() => refJ.arrayElementRanges(b, key)));
      const i = b.length === 0 ? 0 : at % b.length;
      expect(skipValue(b, i)).toBe(refJ.skipValue(b, i));
      expect(duplicateTopLevelKey(b, [key, 'content'])).toBe(refJ.topLevelValueRanges(b, key).length > 1 || refJ.topLevelValueRanges(b, 'content').length > 1);
    }),
    fuzz(5151, 3_000),
  );
});

test('feature extraction, rewrites and body-shape refusals are unchanged (Anthropic and OpenAI surfaces)', () => {
  fc.assert(
    fc.property(body, (b) => {
      expect(extractAnthropicFeatures(b)).toEqual(refA.extractAnthropicFeatures(b));
      expect(extractResponsesFeatures(b)).toEqual(refResponses(b));
      expect(rewriteTopLevelModel(b, 'm2')).toEqual(refA.rewriteTopLevelModel(b, 'm2'));
      expect(capTopLevelInteger(b, 'max_tokens', 5)).toEqual(refA.capTopLevelInteger(b, 'max_tokens', 5));
      for (const parsed of [true, false]) expect(bodyShapeRefusal(b, parsed)).toBe(refShape.bodyShapeRefusal(b, parsed));
    }),
    fuzz(5152, 3_000),
  );
});

test('realistic message bodies: features and shape unchanged', () => {
  const msg = fc.record({ role: fc.constantFrom('user', 'assistant'), content: fc.oneof(fc.string(), fc.array(fc.record({ type: fc.constantFrom('text', 'tool_result', 'image'), text: fc.string() }), { maxLength: 3 })) });
  fc.assert(
    fc.property(fc.array(msg, { maxLength: 6 }), fc.option(fc.string(), { nil: undefined }), (messages, system) => {
      const b = Buffer.from(JSON.stringify({ model: 'claude-x', max_tokens: 9, ...(system === undefined ? {} : { system }), messages, input: messages }));
      expect(extractAnthropicFeatures(b)).toEqual(refA.extractAnthropicFeatures(b));
      expect(extractResponsesFeatures(b)).toEqual(refResponses(b));
      expect(bodyShapeRefusal(b, true)).toBe(refShape.bodyShapeRefusal(b, true));
    }),
    fuzz(5153, 1_000),
  );
});
