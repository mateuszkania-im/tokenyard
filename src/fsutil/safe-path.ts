// One helper for every read and write of a user-controlled path (S-FS-1). Given a trusted root (the repository or
// workspace, the package root, or for a path from the command line or configuration the filesystem root), every path
// component below the root is checked with lstat and a symbolic link refuses the path (below the filesystem root a
// root-owned link such as macOS /tmp is allowed, as OpenSSH's safe_path does); the real path must stay under the real
// root. This covers links that are already there, such as links committed to a repository. It is not proof against a
// race: a directory component swapped for a link between the check and the open is followed; O_NOFOLLOW protects only
// the last component, the file itself. Files are opened with O_NOFOLLOW and O_NONBLOCK (a FIFO is refused, never waited
// on) and must be regular files, reads are bounded, and directories are created one component at a time below the
// root, never through a link.
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync, type Dirent } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

export class UnsafePathError extends Error {
  override name = 'UnsafePathError';
}

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const NONBLOCK = constants.O_NONBLOCK ?? 0;

/**
 * The trusted root for a path given on the command line or in configuration: the filesystem root, so every component
 * is checked and only root-owned links are allowed (ruling, OpenSSH safe_path). Windows, where ownership does not say
 * the same, keeps the earlier rule: the working directory when the path lies inside it, else the path's parent.
 */
export function cliRoot(target: string, cwd: string = process.cwd()): string {
  const abs = resolve(cwd, target);
  if (process.platform !== 'win32') return parse(abs).root;
  return inside(resolve(cwd), abs) ? resolve(cwd) : dirname(abs);
}

/** What `trustedSystemLink` reads; tests inject a fake tree. */
export interface LinkProbe {
  lstat(p: string): { uid: number; mode: number; isSymbolicLink(): boolean };
  stat(p: string): { uid: number; mode: number; isDirectory(): boolean };
  realpath(p: string): string;
}
const realProbe: LinkProbe = { lstat: (p) => lstatSync(p), stat: (p) => statSync(p), realpath: (p) => realpathSync(p) };

const GROUP_OR_WORLD_WRITABLE = 0o022;
const STICKY = 0o1000;

/** `dir` and every ancestor up to `/` are root-owned and not group- or world-writable (`lenientFirst`: `dir` itself may be writable when sticky). */
function rootOwnedChain(dir: string, fs: LinkProbe, lenientFirst: boolean): boolean {
  let cur = dir;
  for (let first = true; ; first = false) {
    const st = fs.stat(cur);
    if (st.uid !== 0) return false;
    if ((st.mode & GROUP_OR_WORLD_WRITABLE) !== 0 && !(first && lenientFirst && (st.mode & STICKY) !== 0)) return false;
    const up = dirname(cur);
    if (up === cur) return true;
    cur = up;
  }
}

/**
 * The OpenSSH safe_path rule for a symbolic link in a CLI or configuration path (S-FS-2): the link is root-owned, the
 * directory holding it and every ancestor up to `/` are root-owned and not group- or world-writable, and so are the
 * link's resolved target directory and its ancestors. The target directory itself may be world-writable when it has the
 * sticky bit (macOS /tmp is a root link to the root-owned, sticky /private/tmp); everything below it is still walked
 * component by component. Any error (a missing component, a loop) is a refusal.
 */
export function trustedSystemLink(link: string, fs: LinkProbe = realProbe): boolean {
  try {
    if (fs.lstat(link).uid !== 0) return false;
    if (!rootOwnedChain(fs.realpath(dirname(link)), fs, false)) return false;
    const target = fs.realpath(link);
    const targetDir = fs.stat(target).isDirectory() ? target : dirname(target);
    return rootOwnedChain(targetDir, fs, true);
  } catch {
    return false;
  }
}

/** Below the filesystem root (POSIX) a system link that passes `trustedSystemLink` is allowed; any other link is refused. */
const systemLinksAllowed = (absRoot: string): boolean => process.platform !== 'win32' && parse(absRoot).root === absRoot;
const allowedLink = (absRoot: string, path: string, st: { isSymbolicLink(): boolean }): boolean => st.isSymbolicLink() && systemLinksAllowed(absRoot) && trustedSystemLink(path);

/** Whether `target` (resolved against the working directory) lies at or below `root`. */
export function isUnder(root: string, target: string): boolean {
  return inside(resolve(root), resolve(target));
}

function inside(root: string, abs: string): boolean {
  const rel = relative(root, abs);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Components of `abs` below `root`, each as an absolute path, top down. Throws when `abs` is not under `root`. */
function components(root: string, abs: string, label: string): string[] {
  if (!inside(root, abs)) throw new UnsafePathError(`${label} is outside ${root}`);
  const out: string[] = [];
  let cur = root;
  for (const part of relative(root, abs).split(sep).filter((p) => p !== '')) out.push((cur = join(cur, part)));
  return out;
}

const missing = (e: unknown): boolean => (e as NodeJS.ErrnoException).code === 'ENOENT' || (e as NodeJS.ErrnoException).code === 'ENOTDIR';

function refuseLink(path: string, label: string): never {
  throw new UnsafePathError(`${label} passes through a symbolic link (${path}), which is refused; pass the real path instead`);
}

function underRealRoot(realRoot: string, realTarget: string, label: string): void {
  if (!inside(realRoot, realTarget)) throw new UnsafePathError(`${label} resolves outside ${realRoot}`);
}

/**
 * Checks `target` (resolved against the working directory) below `root`: no component is a symbolic link and its real
 * path is under the real root. A missing component throws (ENOENT) unless `allowMissing`, which stops the walk there.
 * Returns the absolute target path.
 */
export async function checkPath(root: string, target: string, o: { allowMissing?: boolean } = {}): Promise<string> {
  const absRoot = resolve(root);
  const abs = resolve(target);
  for (const c of components(absRoot, abs, target)) {
    let st;
    try {
      st = await lstat(c);
    } catch (e) {
      if (o.allowMissing && missing(e)) return abs;
      throw e;
    }
    if (st.isSymbolicLink() && !allowedLink(absRoot, c, st)) refuseLink(c, target);
  }
  underRealRoot(await realpath(absRoot), await realpath(abs), target);
  return abs;
}

/** `checkPath`, synchronous. */
export function checkPathSync(root: string, target: string, o: { allowMissing?: boolean } = {}): string {
  const absRoot = resolve(root);
  const abs = resolve(target);
  for (const c of components(absRoot, abs, target)) {
    let st;
    try {
      st = lstatSync(c);
    } catch (e) {
      if (o.allowMissing && missing(e)) return abs;
      throw e;
    }
    if (st.isSymbolicLink() && !allowedLink(absRoot, c, st)) refuseLink(c, target);
  }
  underRealRoot(realpathSync(absRoot), realpathSync(abs), target);
  return abs;
}

/**
 * An open for writing that failed: a link at the file itself (ELOOP) or a FIFO without a reader (ENXIO, from
 * O_NONBLOCK) is refused as unsafe. O_NONBLOCK stays set: it changes nothing for a regular file.
 */
function openFailed(e: unknown, target: string): never {
  const code = (e as NodeJS.ErrnoException).code;
  if (code === 'ELOOP') refuseLink(target, target);
  if (code === 'ENXIO') throw new UnsafePathError(`${target} is not a regular file`);
  throw e;
}

const tooLarge = (target: string, cap: number): Error => new UnsafePathError(`${target} is larger than ${cap} bytes`);

/**
 * A regular file below `root`, read up to `capBytes` (more throws), or undefined when it does not exist. Opened with
 * O_NOFOLLOW and O_NONBLOCK (a FIFO never blocks the read); anything but a regular file is refused.
 */
export async function readFileUnder(root: string, target: string, capBytes: number): Promise<Buffer | undefined> {
  try {
    await checkPath(root, target);
  } catch (e) {
    if (missing(e)) return undefined;
    throw e;
  }
  let fh;
  try {
    fh = await open(resolve(target), constants.O_RDONLY | NOFOLLOW | NONBLOCK);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ELOOP') refuseLink(target, target);
    if (missing(e)) return undefined;
    throw e;
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new UnsafePathError(`${target} is not a regular file`);
    if (st.size > capBytes) throw tooLarge(target, capBytes);
    const buf = Buffer.alloc(capBytes + 1);
    let n = 0;
    for (;;) {
      const { bytesRead } = await fh.read(buf, n, buf.length - n, n);
      if (bytesRead === 0) break;
      n += bytesRead;
      if (n > capBytes) throw tooLarge(target, capBytes);
    }
    return buf.subarray(0, n);
  } finally {
    await fh.close();
  }
}

/** `readFileUnder`, synchronous. */
export function readFileUnderSync(root: string, target: string, capBytes: number): Buffer | undefined {
  try {
    checkPathSync(root, target);
  } catch (e) {
    if (missing(e)) return undefined;
    throw e;
  }
  let fd: number;
  try {
    fd = openSync(resolve(target), constants.O_RDONLY | NOFOLLOW | NONBLOCK);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ELOOP') refuseLink(target, target);
    if (missing(e)) return undefined;
    throw e;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new UnsafePathError(`${target} is not a regular file`);
    if (st.size > capBytes) throw tooLarge(target, capBytes);
    const buf = Buffer.alloc(capBytes + 1);
    let n = 0;
    for (;;) {
      const bytesRead = readSync(fd, buf, n, buf.length - n, n);
      if (bytesRead === 0) break;
      n += bytesRead;
      if (n > capBytes) throw tooLarge(target, capBytes);
    }
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

/**
 * Creates `dir` below `root` one component at a time: an existing component must be a real directory (a link is
 * refused before anything is created through it), a missing one is created. Returns the absolute path.
 */
export async function ensureDirUnder(root: string, dir: string): Promise<string> {
  const absRoot = resolve(root);
  const abs = resolve(dir);
  await mkdir(absRoot, { recursive: true });
  for (const c of components(absRoot, abs, dir)) {
    let st;
    try {
      st = await lstat(c);
    } catch (e) {
      if (!missing(e)) throw e;
      try {
        await mkdir(c);
      } catch (e2) {
        if ((e2 as NodeJS.ErrnoException).code !== 'EEXIST') throw e2;
      }
      st = await lstat(c);
    }
    if (st.isSymbolicLink()) {
      if (!allowedLink(absRoot, c, st)) refuseLink(c, dir);
      st = await stat(c);
    }
    if (!st.isDirectory()) throw new UnsafePathError(`${c} is not a directory`);
  }
  underRealRoot(await realpath(absRoot), await realpath(abs), dir);
  return abs;
}

/**
 * Writes (or with `append`, appends) `data` to `target` below `root`: its directory is created with `ensureDirUnder`,
 * the file is opened with O_NOFOLLOW (a link at the file itself is refused), and with `exclusive` it must not exist.
 */
export async function writeFileUnder(root: string, target: string, data: string | Uint8Array, o: { append?: boolean; exclusive?: boolean; mode?: number } = {}): Promise<void> {
  await ensureDirUnder(root, dirname(resolve(target)));
  const flags = constants.O_WRONLY | constants.O_CREAT | NOFOLLOW | NONBLOCK | (o.append ? constants.O_APPEND : constants.O_TRUNC) | (o.exclusive ? constants.O_EXCL : 0);
  let fh;
  try {
    fh = await open(resolve(target), flags, o.mode ?? 0o666);
  } catch (e) {
    openFailed(e, target);
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new UnsafePathError(`${target} is not a regular file`);
    await fh.writeFile(data);
  } finally {
    await fh.close();
  }
}

/** A write stream to `target` below `root`, opened like `writeFileUnder` (truncating). */
export async function createWriteStreamUnder(root: string, target: string): Promise<NodeJS.WritableStream> {
  await ensureDirUnder(root, dirname(resolve(target)));
  let fh;
  try {
    fh = await open(resolve(target), constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | NOFOLLOW | NONBLOCK, 0o666);
  } catch (e) {
    openFailed(e, target);
  }
  if (!(await fh.stat()).isFile()) {
    await fh.close();
    throw new UnsafePathError(`${target} is not a regular file`);
  }
  return fh.createWriteStream();
}

/** Entries of a directory below `root` that are real files or directories; symbolic links and special files are left out. */
export async function listDirUnder(root: string, dir: string): Promise<Dirent[]> {
  await checkPath(root, dir);
  return (await readdir(resolve(dir), { withFileTypes: true })).filter((e) => e.isFile() || e.isDirectory());
}
