// S-FS-1: one helper for every read and write of a user-controlled path. Symbolic links anywhere below the trusted
// root are refused, the real path must stay under the root, files are opened without following links and reads are
// bounded.
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { checkPath, cliRoot, ensureDirUnder, readFileUnder, readFileUnderSync, UnsafePathError, writeFileUnder } from '../../src/fsutil/safe-path.js';
import { exportTraces, listLedgerFiles, loadTraceRecords } from '../../src/ledger/export.js';
import { TraceWriter } from '../../src/ledger/writer.js';
import { readLkg, writeLkg } from '../../src/policy-loader/lkg.js';
import { loadPolicyDir } from '../../src/policy-loader/load-dir.js';
import { openReplayTraces } from '../../src/policy-loader/replay-input.js';
import { baseRecord } from '../helpers/trace.js';

let root: string;
let outside: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'ty-safe-')));
  outside = await realpath(await mkdtemp(join(tmpdir(), 'ty-outside-')));
  await writeFile(join(outside, 'secret.txt'), 'outside the root');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

test('checkPath accepts a plain path under the root and refuses a link in any component, or a path outside', async () => {
  await mkdir(join(root, 'a', 'b'), { recursive: true });
  expect(await checkPath(root, join(root, 'a', 'b'))).toBe(join(root, 'a', 'b'));
  await symlink(outside, join(root, 'link'));
  await expect(checkPath(root, join(root, 'link'))).rejects.toThrow(UnsafePathError);
  await expect(checkPath(root, join(root, 'link', 'secret.txt'))).rejects.toThrow(/symbolic link/);
  await symlink(join(root, 'a'), join(root, 'inner-link'));
  await expect(checkPath(root, join(root, 'inner-link', 'b'))).rejects.toThrow(/symbolic link/);
  await expect(checkPath(root, outside)).rejects.toThrow(/outside/);
  await expect(checkPath(root, join(root, '..', 'x'))).rejects.toThrow(/outside/);
  await expect(checkPath(root, join(root, 'missing'))).rejects.toThrow(/ENOENT|does not exist/);
  expect(await checkPath(root, join(root, 'missing', 'deeper'), { allowMissing: true })).toBe(join(root, 'missing', 'deeper'));
});

test('cliRoot is the working directory for a path inside it, else the path itself is the only checked component', () => {
  expect(cliRoot('policy', '/work/repo')).toBe('/work/repo');
  expect(cliRoot('/work/repo/a/b', '/work/repo')).toBe('/work/repo');
  expect(cliRoot('/etc/tokenyard/policy', '/work/repo')).toBe('/etc/tokenyard');
  expect(cliRoot('../other/policy', '/work/repo')).toBe('/work/other');
});

test('reads are bounded and never follow a link; writes refuse a linked file or directory', async () => {
  await writeFile(join(root, 'f.txt'), 'hello');
  expect((await readFileUnder(root, join(root, 'f.txt'), 10))?.toString()).toBe('hello');
  expect(readFileUnderSync(root, join(root, 'f.txt'), 10)?.toString()).toBe('hello');
  expect(await readFileUnder(root, join(root, 'none.txt'), 10)).toBeUndefined();
  await expect(readFileUnder(root, join(root, 'f.txt'), 3)).rejects.toThrow(/larger than 3 bytes/);
  await symlink(join(outside, 'secret.txt'), join(root, 'l.txt'));
  await expect(readFileUnder(root, join(root, 'l.txt'), 100)).rejects.toThrow(UnsafePathError);
  expect(() => readFileUnderSync(root, join(root, 'l.txt'), 100)).toThrow(UnsafePathError);
  await expect(writeFileUnder(root, join(root, 'l.txt'), 'x')).rejects.toThrow(UnsafePathError);
  expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('outside the root');
  await symlink(outside, join(root, 'dirlink'));
  await expect(writeFileUnder(root, join(root, 'dirlink', 'new.txt'), 'x')).rejects.toThrow(UnsafePathError);
  await expect(ensureDirUnder(root, join(root, 'dirlink', 'sub'))).rejects.toThrow(UnsafePathError);
  await writeFileUnder(root, join(root, 'n', 'm', 'out.txt'), 'one');
  await writeFileUnder(root, join(root, 'n', 'm', 'out.txt'), 'two', { append: true });
  expect(await readFile(join(root, 'n', 'm', 'out.txt'), 'utf8')).toBe('onetwo');
});

const POLICY = 'apiVersion: tokenyard/v1\nkind: Policy\n';

test('a symlinked policy directory, or one below a symlinked component, is refused; a plain one still loads', async () => {
  const real = join(root, 'policy');
  await mkdir(real);
  await writeFile(join(real, 'policy.yaml'), POLICY);
  await expect(loadPolicyDir(real, { root })).rejects.not.toThrow(UnsafePathError);
  await symlink(real, join(root, 'policy-link'));
  await expect(loadPolicyDir(join(root, 'policy-link'), { root })).rejects.toThrow(UnsafePathError);
  await mkdir(join(outside, 'p'));
  await writeFile(join(outside, 'p', 'policy.yaml'), POLICY);
  await symlink(outside, join(root, 'parent-link'));
  await expect(loadPolicyDir(join(root, 'parent-link', 'p'), { root })).rejects.toThrow(UnsafePathError);
});

test('a trace dir symlinked outside is refused for reading, export, replay and writing; symlinked entries inside are skipped', async () => {
  const day = join(outside, 'traces', 'acme', '2026-11-02');
  await mkdir(day, { recursive: true });
  await writeFile(join(day, '10.i1.ndjson'), '{"v":1,"kind":"heartbeat","instance":"i1","ts":"2026-11-02T10:00:00.000Z","seq":1}\n');
  const linked = join(root, 'traces');
  await symlink(join(outside, 'traces'), linked);
  const T = Date.UTC(2026, 10, 2);
  await expect(loadTraceRecords({ path: linked, sinceMs: T, untilMs: T + 86_400_000 })).rejects.toThrow(UnsafePathError);
  await expect(exportTraces({ dir: linked, sinceMs: T, untilMs: T + 86_400_000, out: join(root, 'x.ndjson') })).rejects.toThrow(UnsafePathError);
  await expect(listLedgerFiles(linked, T, T + 86_400_000)).rejects.toThrow(UnsafePathError);
  await expect(openReplayTraces([join(linked, 'acme', '2026-11-02', '10.i1.ndjson')], { root })).rejects.toThrow(UnsafePathError);
  const w = new TraceWriter({ dir: linked, instanceId: 'i1', queueMax: 10, clock: () => T + 10 * 3_600_000 });
  w.write(baseRecord({ tenant: 'acme' }));
  await w.close();
  expect(w.dropped).toBe(1);
  // Nothing was written through the link.
  expect(await readFile(join(day, '10.i1.ndjson'), 'utf8')).toBe('{"v":1,"kind":"heartbeat","instance":"i1","ts":"2026-11-02T10:00:00.000Z","seq":1}\n');

  // A real trace dir whose tenant folder is a link: that entry is skipped, not followed.
  const realDir = join(root, 'real-traces');
  await mkdir(realDir);
  await symlink(join(outside, 'traces', 'acme'), join(realDir, 'acme'));
  expect(await listLedgerFiles(realDir, T, T + 86_400_000)).toEqual([]);
});

test('the last-known-good file is refused through a link, and writing refuses a linked state dir', async () => {
  await symlink(outside, join(root, 'state'));
  await expect(readLkg(join(root, 'state'))).rejects.toThrow(UnsafePathError);
  await expect(writeLkg(join(root, 'state'), '{}')).rejects.toThrow(UnsafePathError);
  const plain = join(root, 'plain-state');
  await mkdir(plain);
  await symlink(join(outside, 'secret.txt'), join(plain, 'last-known-good.json'));
  await expect(readLkg(plain)).rejects.toThrow(UnsafePathError);
});

test('keys create refuses a keys file that is a symbolic link', async () => {
  const { appendKey } = await import('../../src/edge/keys.js');
  await symlink(join(outside, 'secret.txt'), join(root, 'keys.yaml'));
  const rec = { hash: 'h', keyId: 'k', tenant: 't', team: null, name: 'n', kind: 'developer' as const, billing: 'api' as const };
  await expect(appendKey(join(root, 'keys.yaml'), rec)).rejects.toThrow(UnsafePathError);
  expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('outside the root');
  await appendKey(join(root, 'plain-keys.yaml'), rec);
  expect(await readFile(join(root, 'plain-keys.yaml'), 'utf8')).toContain('"keyId":"k"');
});
