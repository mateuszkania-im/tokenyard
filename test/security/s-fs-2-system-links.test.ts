// S-FS-2 (coordinator finding, MEDIUM): the root-owned-symlink exception trusted link ownership alone, so a root-owned
// link below a user-writable directory was accepted. The full OpenSSH safe_path rule applies: a symlink in a CLI or
// config path is accepted only when the link and every ancestor directory up to / are owned by root and not group or
// world writable. Tested against an injected file system.
import { describe, expect, test } from 'vitest';
import { trustedSystemLink } from '../../src/fsutil/safe-path.js';

type Node = { uid: number; mode: number; link?: string };
const DIR = 0o040000;
const fakeFs = (tree: Record<string, Node>) => {
  const get = (p: string): Node => {
    const n = tree[p];
    if (!n) throw Object.assign(new Error(`ENOENT ${p}`), { code: 'ENOENT' });
    return n;
  };
  const real = (p: string): string => {
    let cur = '/';
    for (const part of p.split('/').filter(Boolean)) {
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

describe('S-FS-2', () => {
  test('the macOS system links /tmp and /var are accepted', () => {
    const fs = fakeFs({ ...base, '/tmp': { uid: 0, mode: 0o755, link: '/private/tmp' }, '/var': { uid: 0, mode: 0o755, link: '/private/var' } });
    expect(trustedSystemLink('/tmp', fs)).toBe(true);
    expect(trustedSystemLink('/var', fs)).toBe(true);
  });
  test('a link owned by a user is refused', () => {
    expect(trustedSystemLink('/tmp', fakeFs({ ...base, '/tmp': { uid: 501, mode: 0o755, link: '/private/tmp' } }))).toBe(false);
  });
  test('a root-owned link below a user-owned directory is refused', () => {
    const fs = fakeFs({ ...base, '/home': rootDir(), '/home/u': { uid: 501, mode: DIR | 0o755 }, '/home/u/l': { uid: 0, mode: 0o755, link: '/private/var' } });
    expect(trustedSystemLink('/home/u/l', fs)).toBe(false);
  });
  test('a root-owned link below a group- or world-writable directory is refused', () => {
    for (const mode of [0o777, 0o775, 0o1777]) {
      expect(trustedSystemLink('/shared/l', fakeFs({ ...base, '/shared': rootDir(mode), '/shared/l': { uid: 0, mode: 0o755, link: '/private/var' } })), mode.toString(8)).toBe(false);
    }
  });
  test('a root-owned link whose target is in a user-owned tree is refused', () => {
    const fs = fakeFs({ ...base, '/home': rootDir(), '/home/u': { uid: 501, mode: DIR | 0o755 }, '/home/u/p': { uid: 501, mode: DIR | 0o755 }, '/l': { uid: 0, mode: 0o755, link: '/home/u/p' } });
    expect(trustedSystemLink('/l', fs)).toBe(false);
  });
});
