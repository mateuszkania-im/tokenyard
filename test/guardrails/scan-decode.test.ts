// The scanner's JSON string decoding and token boundaries, pinned directly (V5: the mutation run left the escape
// decoder, the UTF-8 encoder, the surrogate pair rules and the whitespace and structure tests unpinned). The scanner
// matches rules on decoded text, as UTF-8 bytes in latin1, so a value is found however a JSON writer escaped it.
import fc from 'fast-check';
import { expect, test } from 'vitest';
import type { SecretRule } from '../../src/guardrails/rules.js';
import { DEFAULT_RULES } from '../../src/guardrails/rules.js';
import { findSpans, scanBody } from '../../src/guardrails/scan.js';
import { extractAnthropicFeatures } from '../../src/surfaces/anthropic-messages.js';
import { fuzz } from '../helpers/fuzz.js';
import { RULE_FIXTURES } from './fixtures.js';

/** U+0001, the delimiter the two capture rules use (no generated string holds it; JSON writes it escaped). */
const D = String.fromCharCode(1);
/** Captures what sits between two delimiters. */
const CAP: SecretRule = { id: 'cap', keywords: [], regex: new RegExp(`${D}([^${D}]*)${D}`), source: 't', licence: 'MIT' };
/** Captures from one delimiter to the end of the view. */
const TAIL: SecretRule = { id: 'tail', keywords: [], regex: new RegExp(`${D}([^${D}]*)$`), source: 't', licence: 'MIT' };
const latin1 = (s: string): string => Buffer.from(s, 'utf8').toString('latin1');
const values = (b: Buffer, rules: SecretRule[], o: Parameters<typeof findSpans>[2] = {}): string[] => findSpans(b, rules, o).map((s) => s.value);
const body = (lit: string): Buffer => Buffer.from(`{"content":"\\u0001${lit}\\u0001"}`);

const hex = (u: number, upper: boolean): string => {
  const h = u.toString(16).padStart(4, '0');
  return `\\u${upper ? h.toUpperCase() : h}`;
};
const SIMPLE: Record<string, string> = { '"': '\\"', '\\': '\\\\', '/': '\\/', '\b': '\\b', '\f': '\\f', '\n': '\\n', '\r': '\\r', '\t': '\\t' };

/** A JSON string body for `s`: each code point (or lone surrogate) raw, \u-escaped in either case, or a simple escape. */
function literal(s: string, choice: readonly number[]): string {
  let out = '';
  let k = 0;
  for (let i = 0; i < s.length; i++, k++) {
    const u = s.charCodeAt(i);
    const pair = u >= 0xd800 && u <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00;
    const unit = pair ? s.slice(i, i + 2) : s[i] as string;
    const c = (choice[k % choice.length] as number) % 3;
    const lone = !pair && u >= 0xd800 && u <= 0xdfff;
    const mustEscape = lone || u < 0x20 || unit === '"' || unit === '\\';
    if (c === 2 && SIMPLE[unit] !== undefined) out += SIMPLE[unit];
    else if (c > 0 || mustEscape) out += [...Array(unit.length).keys()].map((j) => hex(unit.charCodeAt(j), c === 1)).join('');
    else out += unit;
    if (pair) i++;
  }
  return out;
}

const codeUnit = fc.oneof(
  fc.integer({ min: 0x02, max: 0x7f }),
  fc.constantFrom(0x7f, 0x80, 0x7ff, 0x800, 0xd7ff, 0xe000, 0xfffd, 0xffff),
  fc.integer({ min: 0x80, max: 0xffff }),
  fc.integer({ min: 0xd800, max: 0xdfff }),
).map((u) => String.fromCharCode(u));
const astral = fc.integer({ min: 0x10000, max: 0x10ffff }).map((cp) => String.fromCodePoint(cp));
const text = fc.array(fc.oneof(codeUnit, astral, fc.constantFrom('"', '\\', '/', '\b', '\f', '\n', '\r', '\t')), { minLength: 1, maxLength: 24 }).map((xs) => xs.join(''));

test('property: a JSON string decodes to the UTF-8 of its value whatever the escaping; lone surrogates become U+FFFD', () => {
  fc.assert(
    fc.property(text, fc.array(fc.nat(), { minLength: 1, maxLength: 16 }), (s, choice) => {
      const lit = literal(s, choice);
      const b = body(lit);
      // The body is valid JSON of the same value (a lone surrogate parses to itself and encodes as U+FFFD).
      expect(JSON.parse(b.toString()).content).toBe(`\u0001${s}\u0001`);
      expect(values(b, [CAP])).toEqual([latin1(s)]);
      // An unparsable body (raw scan): the decoded copy finds the same value.
      const raw = Buffer.from(`{"content":"\\u0001${lit}\\u0001`);
      expect(values(raw, [CAP], { raw: true })).toContain(latin1(s));
    }),
    fuzz(0xdec0, 1_500),
  );
});

test('escapes at the end of the scanned range or with bad hex digits are kept literally; a pair needs both halves in range', () => {
  const raw = (s: string, o: { end?: number } = {}): string[] => {
    const b = Buffer.from(`{"content":"\\u0001${s}`);
    return values(b, [TAIL], { raw: true, ...(o.end !== undefined ? { range: { start: 0, end: o.end } } : {}) });
  };
  expect(raw('A\\')).toContain('A\\');
  expect(raw('A\\u00')).toContain('A\\u00');
  expect(raw('A\\u00e')).toContain('A\\u00e');
  expect(raw('A\\uZZZZ')).toContain('A\\uZZZZ');
  expect(raw('A\\x')).toContain('A\\x');
  expect(raw('A\\u00e9')).toContain(`A${latin1('é')}`);
  // \u followed by five hex digits: four are the escape, the fifth is text
  expect(raw('A\\u00e9F')).toContain(`A${latin1('é')}F`);
  expect(raw('\\ud83d\\ude00')).toContain(latin1('😀'));
  // the range ends inside the low half: the high half alone is U+FFFD, the rest literal
  const cut = Buffer.from('{"content":"\\u0001\\ud83d\\ude00').length - 1;
  expect(raw('\\ud83d\\ude00', { end: cut })).toContain(`${latin1('\ufffd')}\\ude0`);
  // a high half followed by an escape that is not a low half, or by plain text, or a lone low half
  expect(raw('\\ud83d\\u0041')).toContain(`${latin1('\ufffd')}A`);
  expect(raw('\\ud83dA')).toContain(`${latin1('\ufffd')}A`);
  expect(raw('\\udc00\\ud800')).toContain(latin1('\ufffd\ufffd'));
  // the boundaries of the UTF-8 encoder
  for (const cp of [0x7f, 0x80, 0x7ff, 0x800, 0xffff, 0x10000, 0x10ffff]) {
    const esc = cp > 0xffff ? [...String.fromCodePoint(cp)].map((c) => [...Array(c.length).keys()].map((j) => hex(c.charCodeAt(j), false)).join('')).join('') : hex(cp, false);
    expect(raw(esc), cp.toString(16)).toContain(latin1(String.fromCodePoint(cp)));
  }
});

const SECRET = (RULE_FIXTURES['anthropic-api-key'] ?? Object.values(RULE_FIXTURES)[0])?.positive as string;
const WS = fc.constantFrom('', ' ', '\t', '\n', '\r', ' \r\n\t ');

test('property: JSON whitespace of any kind between tokens changes nothing the scanner finds, split secrets included', () => {
  const half = Math.floor(SECRET.length / 2);
  fc.assert(
    fc.property(fc.array(WS, { minLength: 40, maxLength: 40 }), (ws) => {
      let n = 0;
      const w = (): string => ws[n++ % ws.length] as string;
      const write = (spaced: boolean): Buffer => {
        const s = spaced ? w : (): string => '';
        const text = (t: string): string => `${s()}{${s()}"type"${s()}:${s()}"text"${s()},${s()}"text"${s()}:${s()}${JSON.stringify(t)}${s()}}${s()}`;
        const msg = `${s()}{${s()}"role"${s()}:${s()}"user"${s()},${s()}"content"${s()}:${s()}[${text(SECRET.slice(0, half))},${text(SECRET.slice(half))}]${s()}}${s()}`;
        return Buffer.from(`${s()}{${s()}"model"${s()}:${s()}"m"${s()},${s()}"n"${s()}:${s()}[${s()}12${s()},${s()}true${s()},${s()}null${s()}]${s()},${s()}"messages"${s()}:${s()}[${msg}]${s()}}${s()}`);
      };
      const hits = (b: Buffer) => {
        const f = extractAnthropicFeatures(b);
        expect(f.parseError).toBe(false);
        return scanBody(b, f.lastTurn, DEFAULT_RULES, () => 'block', 'salt', f.messages ? { messages: f.messages } : {}).map((h) => `${h.rule} ${h.valueHmac} ${h.where}`);
      };
      const compact = hits(write(false));
      expect(compact.length).toBeGreaterThan(0);
      expect(hits(write(true))).toEqual(compact);
    }),
    fuzz(0x5ace, 300),
  );
});

test('bare tokens end at whitespace and structure: a number next to brackets, commas, colons or whitespace is one token', () => {
  const NUM: SecretRule = { id: 'num', keywords: [], regex: /\d{4,}/, source: 't', licence: 'MIT' };
  for (const sep of [' ', '\t', '\n', '\r', ',', ']', '}']) {
    const b = Buffer.from(`{"a":[1234${sep === ']' || sep === '}' ? '' : sep}5678${sep === '}' ? ']}' : ']}'}`);
    const spans = findSpans(b, [NUM]);
    expect(spans.map((s) => s.value), JSON.stringify(sep)).toEqual(sep === ']' || sep === '}' ? ['12345678'] : ['1234', '5678']);
    for (const s of spans) expect(s.segments.every((g) => g.bare === true)).toBe(true);
  }
  // a token directly after a brace, bracket or colon starts there
  expect(findSpans(Buffer.from('{"a":{"b":98765}}'), [NUM]).map((s) => [s.value, s.start])).toEqual([['98765', 10]]);
  expect(findSpans(Buffer.from('[[98765]]'), [NUM]).map((s) => [s.value, s.start])).toEqual([['98765', 2]]);
});
