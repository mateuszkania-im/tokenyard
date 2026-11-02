import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, expect, test } from 'vitest';

const script = resolve('scripts/check-no-secrets.mjs');
const dir = mkdtempSync(join(tmpdir(), 'ty-secrets-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function scan(content: string) {
  const file = join(dir, 'sample.txt');
  writeFileSync(file, content);
  const r = spawnSync('node', [script, file], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr, file };
}

const tail = 'abcdefghijklmnopqrstuvwx';

test('canary-prefixed value passes', () => {
  expect(scan(`key=sk-ant-test-CANARY-${tail}`).code).toBe(0);
});

test('plain keys fail, naming the file but never the value', () => {
  for (const value of [`sk-ant-${tail}`, `sk-proj-${tail}`, `sk-ant-other-CANARY-${tail}`]) {
    const r = scan(`key=${value}`);
    expect(r.code).toBe(1);
    expect(r.out).toContain(r.file);
    expect(r.out).not.toContain(value);
    expect(r.out).not.toContain(tail);
  }
});
