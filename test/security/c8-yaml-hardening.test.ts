// C8 (security review C): policy YAML hardening. (a) A `%YAML 1.1` directive switched the parser to YAML 1.1, where
// `<<` is resolved before the merge-key check and yes/no, 0777 and 1:30 change type; any directive but `%YAML 1.2` is
// refused now, `%TAG` included. (b) The duplicate-key check compared parsed values, so `1` and "1", `true` and "true",
// `~` and "" were different keys to it but one key after conversion (the later one won); keys are compared as the
// strings the JS object uses. (c) The check was quadratic in the keys of one mapping (20k keys took seconds), and the
// Action and `serve --policy` parsed policy.yaml more than once per load; the check is linear, a node-count cap bounds
// the work, and each file is parsed once per load.
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { MAX_YAML_NODES, parseYamlSafe, YamlError } from '../../src/policy/safe-yaml.js';

const ROOT = join(import.meta.dirname, '..', '..');

const refused = (text: string): string => {
  try {
    parseYamlSafe(text);
    return 'accepted';
  } catch (e) {
    return e instanceof YamlError ? e.code : `threw ${(e as Error).name}`;
  }
};

afterEach(() => {
  vi.doUnmock('../../src/policy/safe-yaml.js');
  vi.resetModules();
});

test('C8a: any directive except %YAML 1.2 is refused', () => {
  expect(refused('%YAML 1.1\n---\nc:\n  x: 1\n  <<: {x: 2, y: 3}\n')).toBe('E_YAML_UNSAFE');
  expect(refused('%YAML 1.1\n---\nusd: 1:30\n')).toBe('E_YAML_UNSAFE');
  expect(refused('%YAML 1.3\n---\na: 1\n')).toBe('E_YAML_UNSAFE');
  expect(refused('%TAG !e! tag:e.com,2000:\n---\na: 1\n')).toBe('E_YAML_UNSAFE');
  expect(refused('%TAG !! tag:evil:\n---\na: !!int 1\n')).toBe('E_YAML_UNSAFE');
  expect(refused('%FOO bar\n---\na: 1\n')).toBe('E_YAML_UNSAFE');
  expect(parseYamlSafe('%YAML 1.2\n---\na: 1\n')).toEqual({ a: 1 });
  expect(parseYamlSafe('a: 1\n')).toEqual({ a: 1 });
});

test('C8b: keys that are one key in the resulting object are duplicates, in every mapping', () => {
  expect(refused('providers:\n  1: {a: 1}\n  "1": {a: 2}\n')).toBe('E_YAML_SYNTAX');
  expect(refused('t:\n  true: {a: 1}\n  "true": {a: 2}\n')).toBe('E_YAML_SYNTAX');
  expect(refused('~: 1\n"": 2\n')).toBe('E_YAML_SYNTAX');
  expect(refused('null: 1\n~: 2\n')).toBe('E_YAML_SYNTAX');
  expect(refused('a: [{x: 1, x: 2}]\n')).toBe('E_YAML_SYNTAX');
  expect(refused('1.0: a\n1: b\n')).toBe('E_YAML_SYNTAX');
  // a mapping or sequence used as a key is refused outright (it would be stringified)
  expect(refused('? [1, 2]\n: 3\n')).toBe('E_YAML_UNSAFE');
  // the same key in two different mappings is fine
  expect(parseYamlSafe('a: {k: 1}\nb: {k: 2}\n')).toEqual({ a: { k: 1 }, b: { k: 2 } });
});

test('C8c: the duplicate-key check is linear: 60,000 keys parse in well under a second', () => {
  const time = (n: number): number => {
    const text = Array.from({ length: n }, (_, i) => `k${i}: 1`).join('\n');
    const t0 = performance.now();
    expect(Object.keys(parseYamlSafe(text) as object)).toHaveLength(n);
    return performance.now() - t0;
  };
  time(5_000); // warm-up
  const small = time(20_000);
  const big = time(60_000);
  expect(Math.round(big)).toBeLessThan(1000);
  // quadratic growth would make three times the keys cost about nine times as much
  expect(big / small).toBeLessThan(6);
});

test('C8c: a document with more nodes than the cap is refused', () => {
  const text = `a: [${Array.from({ length: MAX_YAML_NODES }, () => '1').join(',')}]\n`;
  expect(text.length).toBeLessThan(1_000_000);
  expect(refused(text)).toBe('E_YAML_UNSAFE');
});

test('C8c: loading a policy directory parses each file once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ty-c8-'));
  try {
    cpSync(join(ROOT, 'examples/policy'), dir, { recursive: true });
    const calls: string[] = [];
    vi.resetModules();
    vi.doMock('../../src/policy/safe-yaml.js', async (orig) => {
      const real = await orig<typeof import('../../src/policy/safe-yaml.js')>();
      return {
        ...real,
        parseYamlSafe: (text: string) => {
          calls.push(text.slice(0, 40));
          return real.parseYamlSafe(text);
        },
      };
    });
    const { loadPolicyDir } = await import('../../src/policy-loader/load-dir.js');
    await loadPolicyDir(dir, { root: dir });
    // policy.yaml, prices.yaml and keys.yaml: three parses, not four
    expect(calls).toHaveLength(3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Fix round 1: the key checks ran on mapping nodes only, so a !!pairs or !!omap sequence of pairs carried __proto__ or
// << past them. The checks run on every pair now, and any tag outside the YAML 1.2 core schema is refused.
test('C8d: __proto__ and << are refused in every pair, also inside !!pairs and !!omap', () => {
  expect(refused('a: !!pairs [{__proto__: {polluted: 1}}]\n')).toBe('E_YAML_UNSAFE');
  expect(refused('a: !!pairs [{"<<": {x: 1}}]\n')).toBe('E_YAML_UNSAFE');
  expect(refused('!!omap [{x: !!pairs [{__proto__: 2}]}]\n')).toBe('E_YAML_UNSAFE');
});

test('C8d: tags outside the YAML 1.2 core schema are refused; core tags are accepted', () => {
  for (const t of ['a: !!binary aGk=\n', 'a: !!timestamp 2001-12-14\n', 'a: !!set {x: null}\n', 'a: !!omap [{x: 1}]\n', 'a: !!pairs [{x: 1}]\n', 'a: !foo 1\n', 'a: !<tag:example.com,2000:x> 1\n']) {
    expect(refused(t), t).toBe('E_YAML_UNSAFE');
  }
  expect(parseYamlSafe('a: !!str 1\nb: !!int "2"\nc: !!float 1.5\nd: !!bool true\ne: !!null ""\nf: !!map {x: 1}\ng: !!seq [1]\n')).toEqual({ a: '1', b: 2, c: 1.5, d: true, e: null, f: { x: 1 }, g: [1] });
});
