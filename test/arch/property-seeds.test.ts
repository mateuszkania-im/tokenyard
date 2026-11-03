// Every fast-check property takes a fixed seed (docs/testing.md), through fuzz(seed, runs) or a `seed:` parameter, so a
// failure reproduces by rerunning (V5 review: keywordsIn and six other properties were unseeded).
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { expect, test } from 'vitest';

const root = join(import.meta.dirname, '..');
const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : /\.ts$/.test(e.name) ? [join(dir, e.name)] : []));

test('every fc.assert call in the tests passes a seed', () => {
  const unseeded: string[] = [];
  let calls = 0;
  for (const f of files(root)) {
    if (f === import.meta.filename) continue;
    const text = readFileSync(f, 'utf8');
    for (const m of text.matchAll(/fc\.assert\(/g)) {
      calls++;
      // the call runs to the end of its test (`\n});`, or `\n}, <timeout>);`)
      const rest = text.slice(m.index);
      const end = rest.search(/\n\}(, [\w_.()]+)?\);/);
      const call = end === -1 ? rest : rest.slice(0, end);
      if (!/fuzz\(|\bseed:/.test(call)) unseeded.push(`${relative(root, f)}:${text.slice(0, m.index).split('\n').length}`);
    }
  }
  expect(calls).toBeGreaterThan(30);
  expect(unseeded).toEqual([]);
});
