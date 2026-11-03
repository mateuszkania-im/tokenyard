// V4 fuzz: the policy YAML loader (src/policy/safe-yaml.ts) reads files from pull requests. For any input it either
// returns plain data (only plain objects, arrays and scalars, no `__proto__` own key, Object.prototype untouched) or
// throws a YamlError; never another error, never an expanded alias, and in bounded time.
import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { expect, test } from 'vitest';
import { isAlias, parseDocument, visit } from 'yaml';
import { parseYamlSafe, YamlError } from '../../src/policy/safe-yaml.js';
import { fuzz, fuzzTimeout } from '../helpers/fuzz.js';

const EXAMPLE = readFileSync(new URL('../../examples/policy/policy.yaml', import.meta.url), 'utf8');

type Outcome = { ok: true; value: unknown } | { ok: false; code: string };
function parse(text: string): Outcome {
  try {
    return { ok: true, value: parseYamlSafe(text) };
  } catch (e) {
    if (e instanceof YamlError) return { ok: false, code: e.code };
    throw e; // any other error is a finding
  }
}

/** Every object in `v` is a plain object or array with no `__proto__` own key and no accessor. */
function assertPlain(v: unknown, depth = 0): void {
  expect(depth).toBeLessThan(10_000);
  if (v === null || typeof v !== 'object') {
    expect(['string', 'number', 'boolean', 'object', 'bigint']).toContain(typeof v);
    return;
  }
  const proto = Object.getPrototypeOf(v);
  expect(proto === Object.prototype || proto === Array.prototype).toBe(true);
  expect(Object.hasOwn(v, '__proto__')).toBe(false);
  for (const d of Object.values(Object.getOwnPropertyDescriptors(v))) {
    expect('get' in d || 'set' in d).toBe(false);
    assertPlain(d.value, depth + 1);
  }
}

const KEY = fc.oneof(fc.constantFrom('__proto__', '"__proto__"', "'__proto__'", '? __proto__', 'constructor', 'prototype', '<<', '"<<"', '~', '"~"', '1', '"1"', 'true', '"true"', 'polluted', 'routes', 'budgets'), fc.stringMatching(/^[a-z_]{1,6}$/));
const SCALAR = fc.oneof(
  fc.constantFrom('1', '0x1F', '0o17', '1e400', '-.inf', '.nan', 'yes', 'null', '~', '"x"', "'y'", '!!str 5', '!!binary aGk=', '!!timestamp 2026-01-01', '!!js/function x', '!custom v', '&a v', '*a', '*b', '[1, *a]', '{ a: *a }', '|\n  text', '>-\n  folded', '"\\u0000"', '"\\x41"', '1:30', '0777'),
  fc.string({ maxLength: 8 }).map((s) => JSON.stringify(s)),
);
const HEAD = fc.constantFrom('', '%YAML 1.2\n---\n', '%YAML 1.1\n---\n', '%TAG ! tag:evil:\n---\n', '---\n', '--- !!map\n', '--- &root\n');

/** Nested block YAML built from hostile keys, anchors, aliases, merges and tags. */
const block: fc.Arbitrary<string> = fc.letrec<{ node: string }>((tie) => ({
  node: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    SCALAR,
    fc.array(fc.tuple(KEY, tie('node'), fc.constantFrom('', '&a ', '&b ', '!!map ')), { maxLength: 4 }).map((xs) =>
      xs.length === 0 ? '{}' : `\n${xs.map(([k, v, anchor]) => `${k}: ${anchor}${v.replace(/\n/g, '\n  ')}`).join('\n')}`.replace(/\n/g, '\n  '),
    ),
    fc.array(tie('node'), { maxLength: 3 }).map((xs) => (xs.length === 0 ? '[]' : `\n${xs.map((v) => `- ${v.replace(/\n/g, '\n  ')}`).join('\n')}`.replace(/\n/g, '\n  '))),
  ),
})).node;
const doc = fc.tuple(HEAD, fc.array(fc.tuple(KEY, block), { minLength: 1, maxLength: 5 })).map(([h, xs]) => h + xs.map(([k, v]) => `${k}: ${v}`).join('\n') + '\n');

/** The example policy with a few characters replaced, inserted or removed. */
const mutated = fc.array(fc.tuple(fc.nat(), fc.constantFrom('insert', 'replace', 'delete'), fc.constantFrom(':', '&a', '*a', '<<', '__proto__', '!!', '"', "'", '\n', ' ', '-', '[', '{', '}', ']', '#', '%', '\t', '\\', '?')), { minLength: 1, maxLength: 6 }).map((ops) => {
  let s = EXAMPLE;
  for (const [at, op, piece] of ops) {
    const p = at % (s.length + 1);
    s = op === 'insert' ? s.slice(0, p) + piece + s.slice(p) : op === 'replace' ? s.slice(0, p) + piece + s.slice(p + 1) : s.slice(0, p) + s.slice(p + 1);
  }
  return s;
});

test('the generators reach both outcomes (sanity: the fuzz is not all refusals)', () => {
  const samples = fc.sample(fc.oneof(doc, mutated), { numRuns: 400, seed: 0x9a71 }).map(parse);
  expect(samples.some((o) => o.ok)).toBe(true);
  expect(samples.some((o) => !o.ok)).toBe(true);
});

test('fuzz: hostile YAML gives plain data or a YamlError, never pollutes Object.prototype, never expands an alias', () => {
  fc.assert(
    fc.property(fc.oneof(doc, mutated, fc.string({ maxLength: 60 })), (text) => {
      const before = Object.getOwnPropertyNames(Object.prototype).length;
      const started = performance.now();
      const r = parse(text);
      expect(performance.now() - started).toBeLessThan(500);
      expect(Object.getOwnPropertyNames(Object.prototype).length).toBe(before);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      if (!r.ok) return;
      assertPlain(r.value);
      // An accepted document holds no alias node, as the yaml library itself reads it.
      let aliases = 0;
      visit(parseDocument(text, { uniqueKeys: false, merge: false, version: '1.2' }), (_k, n) => void (isAlias(n) && aliases++));
      expect(aliases).toBe(0);
    }),
    fuzz(0x9a72, 1_500),
  );
}, fuzzTimeout(10_000));

test('fuzz: an alias bomb of any width and depth is refused quickly', () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 12 }), fc.integer({ min: 2, max: 12 }), (depth, width) => {
      const lines = ['a0: &a0 [x]'];
      for (let d = 1; d <= depth; d++) lines.push(`a${d}: &a${d} [${Array.from({ length: width }, () => `*a${d - 1}`).join(', ')}]`);
      const started = performance.now();
      expect(parse(lines.join('\n'))).toEqual({ ok: false, code: 'E_YAML_UNSAFE' });
      expect(performance.now() - started).toBeLessThan(500);
    }),
    fuzz(0x9a73, 60),
  );
}, fuzzTimeout(10_000));
