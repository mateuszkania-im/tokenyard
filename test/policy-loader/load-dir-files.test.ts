// loadPolicyDir reads policy files as data: regular files only, bounded, never through a symlink (spec 11).
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { loadPolicyDir } from '../../src/policy-loader/load-dir.js';

const EXAMPLE = join(import.meta.dirname, '..', '..', 'examples', 'policy');
let dir: string;
let outside: string;
beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'ty-loaddir-'));
  dir = join(root, 'policy');
  outside = join(root, 'outside');
  cpSync(EXAMPLE, dir, { recursive: true });
});
afterEach(() => rmSync(join(dir, '..'), { recursive: true, force: true }));

const message = async (): Promise<string> => {
  try {
    await loadPolicyDir(dir);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  return 'loaded';
};

test('a symlinked policy file is refused and its target content is not echoed', async () => {
  writeFileSync(outside, 'SECRET_TOKEN_abc123: 1\nanother_secret: 2\n');
  rmSync(join(dir, 'policy.yaml'));
  symlinkSync(outside, join(dir, 'policy.yaml'));
  const m = await message();
  expect(m).toContain('E_YAML_UNSAFE');
  expect(m).toContain('regular file');
  expect(m).not.toContain('SECRET_TOKEN');
  for (const name of ['prices.yaml', 'keys.yaml']) {
    cpSync(join(EXAMPLE, 'policy.yaml'), join(dir, 'policy.yaml'));
    rmSync(join(dir, name));
    symlinkSync(outside, join(dir, name));
    expect(await message()).toContain('regular file');
    rmSync(join(dir, name));
    cpSync(join(EXAMPLE, name), join(dir, name));
  }
});

test('a dangling symlink, a symlink to /dev/zero and a FIFO are refused without reading or hanging', async () => {
  rmSync(join(dir, 'keys.yaml'));
  symlinkSync(join(dir, 'nowhere'), join(dir, 'keys.yaml'));
  expect(await message()).toContain('regular file');
  rmSync(join(dir, 'keys.yaml'));
  symlinkSync('/dev/zero', join(dir, 'keys.yaml'));
  expect(await message()).toContain('regular file');
  rmSync(join(dir, 'keys.yaml'));
  execFileSync('mkfifo', [join(dir, 'keys.yaml')]);
  expect(await message()).toContain('regular file');
});

test('a file over the size cap is refused before it is read', async () => {
  writeFileSync(join(dir, 'prices.yaml'), `# ${'x'.repeat(1_000_001)}\n`);
  const m = await message();
  expect(m).toContain('E_YAML_UNSAFE');
  expect(m).toContain('larger than');
});

test('a missing file is still E_FILE_MISSING and ordinary files still load', async () => {
  expect(await message()).toBe('loaded');
  rmSync(join(dir, 'keys.yaml'));
  expect(await message()).toContain('E_FILE_MISSING');
});

test('an unknown key name echoed in a schema error is cut to 64 characters', async () => {
  const { readFileSync } = await import('node:fs');
  writeFileSync(join(dir, 'policy.yaml'), `${readFileSync(join(EXAMPLE, 'policy.yaml'), 'utf8')}\n${'K'.repeat(200)}: 1\n`);
  const m = await message();
  expect(m).toContain('K'.repeat(64));
  expect(m).not.toContain('K'.repeat(65));
});
