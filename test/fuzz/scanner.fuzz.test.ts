// V4 fuzz: the secret scanner, the body-shape check and the S-V3-1 escape budget. A secret is found, with the HMAC of
// its decoded value, however another JSON writer escapes it (\uXXXX for any character, \/) and however it is split
// over the text blocks of one message; a duplicate key is found at any depth whatever its escaping; the escape count
// matches a reference; a body at the budget scans within its time bound.
import fc from 'fast-check';
import { expect, test } from 'vitest';
import { DEFAULT_RULES } from '../../src/guardrails/rules.js';
import { countEscapesUpTo, SCAN_ESCAPE_BUDGET, scanBody } from '../../src/guardrails/scan.js';
import { extractAnthropicFeatures } from '../../src/surfaces/anthropic-messages.js';
import { bodyShapeRefusal } from '../../src/surfaces/body-shape.js';
import { RULE_FIXTURES } from '../guardrails/fixtures.js';
import { fuzz, fuzzTimeout } from '../helpers/fuzz.js';

const BLOCKING = DEFAULT_RULES.filter((r) => !r.entropyOnly).map((r) => r.id);
const SECRETS = Object.entries(RULE_FIXTURES).filter(([id]) => BLOCKING.includes(id)).map(([id, f]) => ({ id, value: f.positive }));

/** JSON string literal for `s`, each character escaped as \uXXXX where `esc(i)` says so, and `/` as `\/` where it says so. */
function literal(s: string, esc: (i: number) => boolean): string {
  let r = '';
  let k = 0;
  for (const ch of s) {
    // Characters JSON.stringify escapes itself (quote, backslash, controls) stay as it writes them.
    const plain = JSON.stringify(ch).slice(1, -1);
    if (plain === ch && esc(k)) r += ch === '/' && k % 2 === 0 ? '\\/' : [...ch].map((u) => `\\u${u.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
    else r += plain;
    k++;
  }
  return `"${r}"`;
}

/** Splits `s` at `cuts` into 1 or more non-empty pieces. */
function pieces(s: string, cuts: readonly number[]): string[] {
  const at = [...new Set(cuts.map((c) => 1 + (c % Math.max(1, s.length - 1))))].filter((c) => c < s.length).sort((a, b) => a - b);
  return [0, ...at].map((p, i, a) => s.slice(p, a[i + 1] ?? s.length));
}

const ctx = fc.constantFrom('', 'here: ', 'key = ', 'export TOKEN=', '\n', '"', ' ');
const placed = fc.record({
  secret: fc.constantFrom(...SECRETS),
  before: ctx,
  after: fc.constantFrom('', ' ok', '\n', '.'),
  where: fc.constantFrom('last-turn', 'history'),
  cuts: fc.array(fc.nat(), { maxLength: 3 }),
  escapes: fc.array(fc.boolean(), { minLength: 1, maxLength: 64 }),
});

type Placed = typeof placed extends fc.Arbitrary<infer T> ? T : never;
function bodyOf(p: Placed, escaped: boolean): Buffer {
  const text = p.before + p.secret.value + p.after;
  const esc = (i: number): boolean => escaped && (p.escapes[i % p.escapes.length] as boolean);
  const blocks = (escaped ? pieces(text, p.cuts) : [text]).map((t) => `{"type":"text","text":${literal(t, esc)}}`).join(',');
  const target = `{"role":"user","content":[${blocks}]}`;
  const messages = p.where === 'last-turn' ? [`{"role":"user","content":"start"}`, `{"role":"assistant","content":"ok"}`, target] : [target, `{"role":"assistant","content":"ok"}`, `{"role":"user","content":"next"}`];
  return Buffer.from(`{"model":"claude-haiku-5-5","max_tokens":8,"messages":[${messages.join(',')}]}`);
}

function hitsOf(b: Buffer): Array<{ rule: string; valueHmac: string; where: string }> {
  const f = extractAnthropicFeatures(b);
  expect(f.parseError).toBe(false);
  return scanBody(b, f.lastTurn, DEFAULT_RULES, () => 'block', 'salt', f.messages ? { messages: f.messages } : {}).map((h) => ({ rule: h.rule, valueHmac: h.valueHmac, where: h.where }));
}

test('fuzz: a secret is found with the same rule, HMAC and place however it is escaped and split over text blocks', () => {
  fc.assert(
    fc.property(placed, (p) => {
      const plainBody = bodyOf(p, false);
      const escapedBody = bodyOf(p, true);
      // Both are the same JSON value.
      expect(JSON.parse(escapedBody.toString())).toEqual(JSON.parse(plainBody.toString().replace(/"content":\[\{"type":"text","text":("(?:[^"\\]|\\.)*")\}\]/, (_m, t) => `"content":[${pieces(JSON.parse(t) as string, p.cuts).map((x) => `{"type":"text","text":${JSON.stringify(x)}}`).join(',')}]`)));
      const expected = hitsOf(plainBody);
      expect(expected.some((h) => h.rule === p.secret.id)).toBe(true);
      const got = hitsOf(escapedBody);
      for (const h of expected.filter((x) => x.rule === p.secret.id)) expect(got).toContainEqual(h);
    }),
    fuzz(0x5ca1, 600),
  );
}, fuzzTimeout(20_000));

/** A JSON value with a known duplicate key or none: keys are written with random \u escaping. */
const keyName = fc.constantFrom('model', 'messages', 'a', 'b', '__proto__', 'constructor', 'type', 'é', 'x y', '');
type Tree = { dup: boolean; json: string };
const tree: fc.Arbitrary<Tree> = fc.letrec<{ t: Tree }>((tie) => ({
  t: fc.oneof(
    { depthSize: 'small' },
    fc.constantFrom('1', '"s"', 'null', 'true', '[]', '{}').map((json) => ({ dup: false, json })),
    fc.array(tie('t'), { maxLength: 3 }).map((xs) => ({ dup: xs.some((x) => x.dup), json: `[${xs.map((x) => x.json).join(',')}]` })),
    fc.tuple(fc.uniqueArray(keyName, { maxLength: 4 }), fc.array(tie('t'), { minLength: 4, maxLength: 4 }), fc.boolean(), fc.array(fc.boolean(), { minLength: 1, maxLength: 8 })).map(([keys, vals, addDup, esc]) => {
      const write = (k: string, salt: number): string => literal(k, (i) => esc[(i + salt) % esc.length] as boolean);
      const members = keys.map((k, i) => `${write(k, i)}:${(vals[i] as Tree).json}`);
      const dupHere = addDup && keys.length > 0;
      if (dupHere) members.push(`${write(keys[0] as string, 3)}:0`);
      return { dup: dupHere || keys.some((_, i) => (vals[i] as Tree).dup), json: `{${members.join(',')}}` };
    }),
  ),
})).t;

test('fuzz: body-shape finds a duplicate key at any depth whatever its escaping, and only then', () => {
  fc.assert(
    fc.property(tree, fc.constantFrom('', ' ', '\n'), (t, ws) => {
      const b = Buffer.from(`{"model":"m",${ws}"x":${t.json}}`);
      expect(() => JSON.parse(b.toString())).not.toThrow();
      const r = bodyShapeRefusal(b, true);
      if (t.dup) expect(r).toBe('duplicate-keys');
      else expect(r === null || r === 'too-deep').toBe(true);
    }),
    fuzz(0xb0d1, 1_500),
  );
}, fuzzTimeout(10_000));

test('fuzz: countEscapesUpTo matches a reference count over whole units and stops one past its limit', () => {
  const unit = fc.constantFrom('a', '\\n', '\\\\', '\\u0041', '\\"', '\\/', '\u00e9', ' ');
  fc.assert(
    fc.property(fc.array(unit, { maxLength: 80 }), fc.nat(), fc.nat(), fc.integer({ min: 0, max: 40 }), (units, x, y, max) => {
      // Range ends on unit boundaries: [lo, hi) holds whole units, each escape unit one escape.
      const [i, j] = [x % (units.length + 1), y % (units.length + 1)].sort((p, q) => p - q) as [number, number];
      const offset = (n: number): number => Buffer.byteLength(units.slice(0, n).join(''));
      const b = Buffer.from(units.join(''));
      const ref = units.slice(i, j).filter((u) => u.startsWith('\\')).length;
      expect(countEscapesUpTo(b, { start: offset(i), end: offset(j) }, max)).toBe(Math.min(ref, max + 1));
    }),
    fuzz(0xe5c1, 2_000),
  );
}, fuzzTimeout(10_000));

test('S-V3-1 bound: a body holding the budget of mixed escapes in every turn scans within its time bound', () => {
  const kinds = ['\\n', '\\u0041', '\\\\', '\\"', '\\t', '\\u00e9'];
  let x = 1;
  const next = (): number => (x = (x * 48_271) % 2_147_483_647); // Park-Miller: exact in doubles
  const turn = (n: number): string => {
    let s = '';
    for (let i = 0; i < n; i++) s += (next() >> 4) % 4 === 0 ? 'word ' : (kinds[(next() >> 4) % kinds.length] as string);
    return s;
  };
  const per = Math.floor(SCAN_ESCAPE_BUDGET / 4);
  const b = Buffer.from(`{"model":"claude-haiku-5-5","max_tokens":8,"messages":[${[0, 1, 2, 3].map((i) => `{"role":"${i % 2 ? 'assistant' : 'user'}","content":"${turn(per)}"}`).join(',')}]}`);
  const n = countEscapesUpTo(b, { start: 0, end: b.length }, SCAN_ESCAPE_BUDGET);
  expect(n).toBeLessThanOrEqual(SCAN_ESCAPE_BUDGET);
  expect(n).toBeGreaterThan(SCAN_ESCAPE_BUDGET * 0.7);
  const f = extractAnthropicFeatures(b);
  const started = performance.now();
  scanBody(b, f.lastTurn, DEFAULT_RULES, () => 'redact', 'salt', f.messages ? { messages: f.messages } : {});
  // S-V3-1 measured at most 0.75 s for a 32 MiB product body at the budget; slack for loaded CI machines.
  expect(performance.now() - started).toBeLessThan(2_500);
}, 20_000);
