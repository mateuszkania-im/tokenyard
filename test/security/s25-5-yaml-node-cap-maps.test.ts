// S25-5 (review of batch 25.3): the yaml library's visit() calls the most specific visitor only, so the Map visitor
// that checks keys shadowed the Node visitor that counted nodes: a document made of mappings alone never reached
// MAX_YAML_NODES. Every node (mappings, sequences, pairs, scalars) is counted now.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { loadPolicyDir } from '../../src/policy-loader/load-dir.js';
import { MAX_YAML_NODES, parseYamlSafe, YamlError } from '../../src/policy/safe-yaml.js';

const ROOT = join(import.meta.dirname, '..', '..');

const refused = (text: string): string => {
  try {
    parseYamlSafe(text);
    return 'accepted';
  } catch (e) {
    return e instanceof YamlError ? `${e.code} ${e.message}` : `threw ${(e as Error).name}`;
  }
};

test('S25-5 a wide document of mappings only is held to the node cap', () => {
  // each `{}` value is a map node; each entry adds a pair, a key scalar and a map
  const n = Math.ceil(MAX_YAML_NODES / 3) + 10;
  const text = `{${Array.from({ length: n }, (_, i) => `k${i}:{}`).join(',')}}`;
  expect(text.length).toBeLessThan(1_000_000);
  expect(refused(text)).toMatch(/^E_YAML_UNSAFE .*nodes/);
});

test('S25-5 nested mappings count towards the cap', () => {
  // one mapping per level, each holding the next and nothing else; flow style keeps it under the size cap
  const depth = 400;
  const one = `${'{a:'.repeat(depth)}{}${'}'.repeat(depth)}`;
  const n = Math.ceil(MAX_YAML_NODES / (depth * 3)) + 5;
  const text = `[${Array.from({ length: n }, () => one).join(',')}]`;
  expect(text.length).toBeLessThan(1_000_000);
  expect(refused(text)).toMatch(/^E_YAML_UNSAFE/);
});

test('S25-5 the example policies still load', async () => {
  for (const dir of ['examples/policy', 'examples/policy-head']) await expect(loadPolicyDir(join(ROOT, dir), { root: ROOT })).resolves.toBeDefined();
  expect(parseYamlSafe(readFileSync(join(ROOT, 'examples/policy/prices.yaml'), 'utf8'))).toBeTypeOf('object');
});
