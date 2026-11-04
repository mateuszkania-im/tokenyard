import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

const PURE_DIRS = [
  'src/policy',
  'src/replay',
  'src/surfaces',
  'src/stream',
  'src/pricing',
  'src/guardrails',
  'src/limits/estimator.ts',
];
const FORBIDDEN = [
  /^node:(fs|net|http|https|child_process|dgram|dns)/,
  /^(undici|redis)$/,
  /\/edge\//,
  /\/limits\/redis-store/,
  /\/ledger\/(writer|reader)/,
];

function tsFiles(path: string): string[] {
  if (!existsSync(path)) return [];
  if (statSync(path).isFile()) return path.endsWith('.ts') ? [path] : [];
  return readdirSync(path).flatMap((name) => tsFiles(join(path, name)));
}

function specifiers(source: string): string[] {
  const re = /(?:\bfrom\s+|\bimport\s+|\bimport\s*\(\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;
  return [...source.matchAll(re)].map((m) => m[1] as string);
}

test('pure modules import no I/O', () => {
  const offenders: string[] = [];
  for (const file of PURE_DIRS.flatMap(tsFiles)) {
    for (const spec of specifiers(readFileSync(file, 'utf8'))) {
      if (FORBIDDEN.some((re) => re.test(spec))) offenders.push(`${file}: ${spec}`);
    }
  }
  expect(offenders).toEqual([]);
});

test('import scanner flags forbidden specifiers', () => {
  const found = specifiers(`import fs from 'node:fs';\nimport { x } from "../edge/y";\nconst z = await import('undici');`);
  expect(found.filter((s) => FORBIDDEN.some((re) => re.test(s)))).toEqual(['node:fs', '../edge/y', 'undici']);
});
