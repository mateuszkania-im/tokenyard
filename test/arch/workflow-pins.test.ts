// Every third-party action in .github/workflows is pinned to a full commit SHA (local ./ actions excepted).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

const DIR = join(import.meta.dirname, '..', '..', '.github', 'workflows');

test('every uses: in the workflows is pinned to a 40-hex SHA', () => {
  const files = readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f));
  expect(files.length).toBeGreaterThan(0);
  const bad: string[] = [];
  for (const f of files) {
    readFileSync(join(DIR, f), 'utf8').split('\n').forEach((line, i) => {
      const m = /^\s*(?:-\s+)?uses:\s*(\S+)/.exec(line);
      if (!m) return;
      const ref = m[1] ?? '';
      if (ref.startsWith('./')) return;
      if (!/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/.test(ref)) bad.push(`${f}:${i + 1} ${ref}`);
    });
  }
  expect(bad).toEqual([]);
});
