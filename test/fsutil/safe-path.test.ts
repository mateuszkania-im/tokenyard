// S-FS-1: one helper for every read and write of a user-controlled path. Symbolic links anywhere below the trusted
// root are refused, the real path must stay under the root, files are opened without following links and reads are
// bounded.
import { execFileSync, spawnSync } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { checkPath, cliRoot, createWriteStreamUnder, ensureDirUnder, readFileUnder, readFileUnderSync, trustedSystemLink, UnsafePathError, writeFileUnder } from '../../src/fsutil/safe-path.js';
import { readLedger } from '../../src/ledger/reader.js';
import { validatePolicy } from '../../src/policy/validate.js';
import { exportTraces, listLedgerFiles, loadTraceRecords } from '../../src/ledger/export.js';
import { TraceWriter } from '../../src/ledger/writer.js';
import { readLkg, writeLkg } from '../../src/policy-loader/lkg.js';
import { loadPolicyDir } from '../../src/policy-loader/load-dir.js';
import { openReplayTraces } from '../../src/policy-loader/replay-input.js';
import { baseRecord } from '../helpers/trace.js';

const EXAMPLES = join(import.meta.dirname, '..', '..', 'examples');
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

test('fix 5: a CLI path is walked from the filesystem root; a user-owned link anywhere refuses it, a root-owned system link is allowed', async () => {
  if (process.platform === 'win32') return;
  // ../x/link/policy relative to the working directory, through a link the user owns: refused with the default root.
  await mkdir(join(outside, 'policy'));
  await cp(join(EXAMPLES, 'policy'), join(outside, 'policy'), { recursive: true });
  await mkdir(join(root, 'x'));
  await symlink(outside, join(root, 'x', 'link'));
  const rel = relative(process.cwd(), join(root, 'x', 'link', 'policy'));
  expect(rel.startsWith('..')).toBe(true);
  await expect(loadPolicyDir(rel)).rejects.toThrow(UnsafePathError);
  await expect(checkPath(cliRoot(rel), rel)).rejects.toThrow(/symbolic link/);
  // The same files without the link load.
  expect((await loadPolicyDir(relative(process.cwd(), join(outside, 'policy')))).policy.metadata.name).toBeTruthy();
});

test('fix 5: a path through a root-owned system link (/tmp on macOS) is allowed with the default root', async (ctx) => {
  let st;
  try {
    st = await lstat('/tmp');
  } catch {
    return ctx.skip();
  }
  if (process.platform === 'win32' || !st.isSymbolicLink() || st.uid !== 0) return ctx.skip();
  const dir = await mkdtemp('/tmp/ty-systemlink-');
  try {
    await cp(join(EXAMPLES, 'policy'), join(dir, 'policy'), { recursive: true });
    expect((await loadPolicyDir(join(dir, 'policy'))).policy.metadata.name).toBeTruthy();
    await writeFileUnder(cliRoot(join(dir, 'out', 'f.txt')), join(dir, 'out', 'f.txt'), 'ok');
    expect(await readFile(join(dir, 'out', 'f.txt'), 'utf8')).toBe('ok');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('fix 6: a FIFO is refused at once by writes and by the ledger reader, never waited on', async (ctx) => {
  if (process.platform === 'win32') return ctx.skip();
  const fifo = join(root, 'pipe');
  execFileSync('mkfifo', [fifo]);
  await expect(writeFileUnder(root, fifo, 'x')).rejects.toThrow();
  await expect(createWriteStreamUnder(root, fifo)).rejects.toThrow();
  const lines = async (): Promise<number> => {
    let n = 0;
    for await (const _ of readLedger([fifo])) n++;
    return n;
  };
  await expect(lines()).rejects.toThrow(/regular file/);
  await expect(readFileUnder(root, fifo, 10)).rejects.toThrow(/regular file/);
}, 5_000);

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
  await cp(join(EXAMPLES, 'policy'), real, { recursive: true });
  // fix 8: a full example policy loads and validates without errors.
  const loaded = await loadPolicyDir(real, { root });
  expect(validatePolicy(loaded, { experimentalSubscription: false }).errors).toEqual([]);
  await symlink(real, join(root, 'policy-link'));
  await expect(loadPolicyDir(join(root, 'policy-link'), { root })).rejects.toThrow(UnsafePathError);
  await mkdir(join(outside, 'p'));
  await writeFile(join(outside, 'p', 'policy.yaml'), POLICY);
  await symlink(outside, join(root, 'parent-link'));
  await expect(loadPolicyDir(join(root, 'parent-link', 'p'), { root })).rejects.toThrow(UnsafePathError);
});

test('fix 9: policy check and build print one line for a refused path, no stack', async () => {
  const real = join(root, 'policy');
  await cp(join(EXAMPLES, 'policy'), real, { recursive: true });
  await symlink(real, join(root, 'policy-link'));
  const rel = relative(process.cwd(), join(root, 'policy-link'));
  for (const args of [['policy', 'check', rel], ['policy', 'build', rel, '--out', join(root, 'b.json')]]) {
    const r = spawnSync('node', ['bin/tokenyard.mjs', ...args], { encoding: 'utf8' });
    expect(r.status, args.join(' ')).toBe(1);
    expect(r.stderr.trim().split('\n')).toHaveLength(1);
    expect(r.stderr).toMatch(/^tokenyard policy (check|build): .*symbolic link/);
    expect(r.stderr).not.toMatch(/\n\s+at /);
  }
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

// S-FS-2: the full OpenSSH safe_path rule for system links, with an injected file system.
describe('S-FS-2 trustedSystemLink', () => {
  type Node = { uid: number; mode: number; link?: string };
  const DIR = 0o040000;
  /** A fake tree: paths to owner, mode (with the directory type bits) and, for a link, its target. */
  const fakeFs = (tree: Record<string, Node>) => {
    const get = (p: string): Node => {
      const n = tree[p];
      if (!n) throw Object.assign(new Error(`ENOENT ${p}`), { code: 'ENOENT' });
      return n;
    };
    const real = (p: string): string => {
      const parts = p.split('/').filter(Boolean);
      let cur = '/';
      for (const part of parts) {
        const next = cur === '/' ? `/${part}` : `${cur}/${part}`;
        const n = get(next);
        cur = n.link ? real(n.link) : next;
      }
      return cur;
    };
    const st = (n: Node) => ({ uid: n.uid, mode: n.mode, isSymbolicLink: () => n.link !== undefined, isDirectory: () => n.link === undefined && (n.mode & DIR) !== 0 });
    return { lstat: (p: string) => st(get(p)), stat: (p: string) => st(get(real(p))), realpath: real };
  };
  const rootDir = (mode = 0o755): Node => ({ uid: 0, mode: DIR | mode });
  const base = { '/': rootDir(), '/private': rootDir(), '/private/tmp': rootDir(0o1777), '/private/var': rootDir() };

  test('macOS style /tmp and /var (root links under a root 0755 /, sticky world-writable /private/tmp) are accepted', () => {
    const fs = fakeFs({ ...base, '/tmp': { uid: 0, mode: 0o755, link: '/private/tmp' }, '/var': { uid: 0, mode: 0o755, link: '/private/var' } });
    expect(trustedSystemLink('/tmp', fs)).toBe(true);
    expect(trustedSystemLink('/var', fs)).toBe(true);
  });

  test('a link not owned by root is refused', () => {
    expect(trustedSystemLink('/tmp', fakeFs({ ...base, '/tmp': { uid: 501, mode: 0o755, link: '/private/tmp' } }))).toBe(false);
  });

  test('a root-owned link inside a user-owned directory is refused', () => {
    const fs = fakeFs({ ...base, '/home': rootDir(), '/home/u': { uid: 501, mode: DIR | 0o755 }, '/home/u/l': { uid: 0, mode: 0o755, link: '/private/var' } });
    expect(trustedSystemLink('/home/u/l', fs)).toBe(false);
  });

  test('a root-owned link inside a world- or group-writable directory is refused', () => {
    for (const mode of [0o777, 0o775, 0o1777]) {
      const fs = fakeFs({ ...base, '/shared': rootDir(mode), '/shared/l': { uid: 0, mode: 0o755, link: '/private/var' } });
      expect(trustedSystemLink('/shared/l', fs), mode.toString(8)).toBe(false);
    }
  });

  test('a root-owned link pointing into a user-owned tree, or below a writable ancestor, is refused', () => {
    const user = fakeFs({ ...base, '/home': rootDir(), '/home/u': { uid: 501, mode: DIR | 0o755 }, '/home/u/p': { uid: 501, mode: DIR | 0o755 }, '/l': { uid: 0, mode: 0o755, link: '/home/u/p' } });
    expect(trustedSystemLink('/l', user)).toBe(false);
    const writable = fakeFs({ ...base, '/w': rootDir(0o777), '/w/p': rootDir(), '/l': { uid: 0, mode: 0o755, link: '/w/p' } });
    expect(trustedSystemLink('/l', writable)).toBe(false);
  });

  test('the refusal tells the user to pass the real path', async () => {
    await symlink(outside, join(root, 'l'));
    await expect(checkPath(root, join(root, 'l'))).rejects.toThrow(/pass the real path/);
  });
});
