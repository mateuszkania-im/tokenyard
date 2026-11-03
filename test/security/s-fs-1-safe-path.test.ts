// S-FS-1 (coordinator finding, MEDIUM): policy loading opened files with O_NOFOLLOW, but the directory and its
// ancestors could be symbolic links, so policy files were read from outside the repository or workspace. One helper
// (src/fsutil/safe-path.ts) now covers every read and write of a user-controlled path: it lstats each component from
// the trusted root, refuses any link, requires the real path to stay under the root, opens without following links
// and bounds reads. FIFOs are refused instead of waited on.
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { checkPath, cliRoot, readFileUnder, UnsafePathError, writeFileUnder } from '../../src/fsutil/safe-path.js';
import { readLedger } from '../../src/ledger/reader.js';
import { loadPolicyDir } from '../../src/policy-loader/load-dir.js';
import { readLkg } from '../../src/policy-loader/lkg.js';

const EXAMPLES = join(import.meta.dirname, '..', '..', 'examples');
let root: string;
let outside: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'ty-sfs1-')));
  outside = await realpath(await mkdtemp(join(tmpdir(), 'ty-sfs1-out-')));
  await writeFile(join(outside, 'secret.txt'), 'outside the root');
  await cp(join(EXAMPLES, 'policy'), join(outside, 'policy'), { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

test('S-FS-1 a policy directory that is a link, or sits below one, is refused and nothing outside is read', async () => {
  await symlink(join(outside, 'policy'), join(root, 'policy-link'));
  await expect(loadPolicyDir(join(root, 'policy-link'), { root })).rejects.toThrow(UnsafePathError);
  await symlink(outside, join(root, 'parent-link'));
  await expect(loadPolicyDir(join(root, 'parent-link', 'policy'), { root })).rejects.toThrow(UnsafePathError);
});

test('S-FS-1 a CLI path through a user-owned link anywhere (../x/link/policy) is refused with the default root', async () => {
  if (process.platform === 'win32') return;
  await mkdir(join(root, 'x'));
  await symlink(outside, join(root, 'x', 'link'));
  const rel = relative(process.cwd(), join(root, 'x', 'link', 'policy'));
  expect(rel.startsWith('..')).toBe(true);
  await expect(loadPolicyDir(rel)).rejects.toThrow(UnsafePathError);
  await expect(checkPath(cliRoot(rel), rel)).rejects.toThrow(/symbolic link/);
});

test('S-FS-1 a linked file is neither read nor written through, and a path outside the root is refused', async () => {
  await symlink(join(outside, 'secret.txt'), join(root, 'l.txt'));
  await expect(readFileUnder(root, join(root, 'l.txt'), 100)).rejects.toThrow(UnsafePathError);
  await expect(writeFileUnder(root, join(root, 'l.txt'), 'x')).rejects.toThrow(UnsafePathError);
  expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('outside the root');
  await expect(checkPath(root, outside)).rejects.toThrow(/outside/);
  await writeFile(join(root, 'big.txt'), 'hello');
  await expect(readFileUnder(root, join(root, 'big.txt'), 3)).rejects.toThrow(/larger than 3 bytes/);
});

test('S-FS-1 the last-known-good file is refused through a link', async () => {
  await symlink(outside, join(root, 'state'));
  await expect(readLkg(join(root, 'state'))).rejects.toThrow(UnsafePathError);
});

test('S-FS-1 a FIFO where a file is expected is refused at once, not waited on', async (ctx) => {
  if (process.platform === 'win32') return ctx.skip();
  const fifo = join(root, 'pipe');
  execFileSync('mkfifo', [fifo]);
  await expect(writeFileUnder(root, fifo, 'x')).rejects.toThrow();
  await expect(readFileUnder(root, fifo, 10)).rejects.toThrow(/regular file/);
  await expect((async () => { for await (const _ of readLedger([fifo])) void _; })()).rejects.toThrow(/regular file/);
}, 5_000);
