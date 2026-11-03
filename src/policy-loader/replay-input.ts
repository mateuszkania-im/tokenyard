// The file side of `tokenyard policy replay` (R-P2): reads trace files and policy sources, hands data to src/replay.
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { lstat, stat } from 'node:fs/promises';
import { checkPath, cliRoot, createWriteStreamUnder } from '../fsutil/safe-path.js';
import { lstatSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { readLedger, type LedgerLimits } from '../ledger/reader.js';
import type { LedgerLine } from '../ledger/record.js';
import { buildBundle } from '../policy/bundle.js';
import { compilePolicy } from '../policy/compile.js';
import { parsePolicyFiles, parsePolicyText, policyFileNames, POLICY_FILE, PolicyLoadError, type ParsedPolicyText, type PolicySource } from '../policy/load-dir.js';
import type { CompiledPolicy } from '../policy/types.js';
import { RawTraceDirError } from '../replay/engine.js';
import { loadPolicyDir } from './load-dir.js';

/** Caps on one trace export after decompression (C2): a gzip bomb or a file without line breaks stops the read. */
export const REPLAY_TRACE_LIMITS = { maxBytes: 1024 * 1024 * 1024, maxLineBytes: 1024 * 1024 } as const;

/**
 * Lines of one or more export files (plain or .gz). A directory is refused before anything is read: replay needs the
 * merged set `tokenyard traces export` writes, never raw per-instance files (spec 9.2 step 1). Each file is held to
 * REPLAY_TRACE_LIMITS (or `limits`) after decompression.
 */
export async function openReplayTraces(paths: string[], o: { root?: string; limits?: LedgerLimits } = {}): Promise<AsyncIterable<LedgerLine>> {
  for (const p of paths) {
    await checkPath(o.root ?? cliRoot(p), p);
    if ((await lstat(p)).isDirectory()) throw new RawTraceDirError(p);
  }
  return readLedger(paths, { ...REPLAY_TRACE_LIMITS, ...o.limits });
}

/** A policy directory inside a repository: the repository top level (real path) and the directory relative to it. */
export interface RepoDir {
  top: string;
  rel: string;
  /** For messages only. */
  label: string;
}

/**
 * Places `dir` in its repository. With `workspace` (the Action: GITHUB_WORKSPACE) the top level is the workspace and
 * `dir` must lie inside it and pass through no symbolic link, so a PR cannot redirect which path is read at the base
 * commit. Without it (the CLI) the top level is what git finds from `dir`.
 */
export function locateRepoDir(dir: string, workspace: string | null): RepoDir {
  if (workspace !== null) {
    const root = resolve(workspace);
    const abs = resolve(dir);
    const rel = relative(root, abs);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`policy directory ${JSON.stringify(dir)} is outside the workspace`);
    let cur = root;
    for (const part of rel.split(sep).filter((x) => x !== '')) {
      cur = join(cur, part);
      let link = false;
      try {
        link = lstatSync(cur).isSymbolicLink();
      } catch {
        // a missing component is reported when the files are read
      }
      if (link) throw new Error(`policy directory ${JSON.stringify(dir)} passes through a symbolic link, which is refused`);
    }
    return { top: realpathSync(root), rel: rel.split(sep).join('/'), label: dir };
  }
  const top = realpathSync(execFileSync('git', ['--no-replace-objects', 'rev-parse', '--show-toplevel'], { cwd: resolve(dir), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv(null) }).trim());
  return { top, rel: relative(top, realpathSync(resolve(dir))).split(sep).join('/'), label: dir };
}

let emptyConfig: string | null = null;
/** A config file that holds nothing: /dev/null, or on Windows an empty file in the temp directory. */
function nullConfig(): string {
  if (process.platform !== 'win32') return '/dev/null';
  if (emptyConfig === null) {
    const dir = mkdtempSync(join(tmpdir(), 'tokenyard-git-'));
    emptyConfig = join(dir, 'empty.gitconfig');
    writeFileSync(emptyConfig, '');
  }
  return emptyConfig;
}

/**
 * The environment git runs with, built from scratch (C9): no GIT_* variable of the process reaches it, so an earlier
 * step that wrote $GITHUB_ENV cannot point git at other objects, replace refs or config. Only what git needs to start.
 */
function gitEnv(repo: RepoDir | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const keep = process.platform === 'win32' ? ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH'] : ['PATH', 'HOME', 'TMPDIR'];
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  return {
    ...env,
    ...(repo === null ? {} : { GIT_CEILING_DIRECTORIES: dirname(repo.top) }),
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: nullConfig(),
    GIT_TERMINAL_PROMPT: '0',
  };
}

/**
 * git against an explicit repository: its git dir and work tree are `top`, discovery and bare or nested repositories
 * found in the tree are off (`safe.bareRepository=explicit`, a ceiling at the parent of `top`), replace refs are
 * ignored and the environment is gitEnv's.
 */
const gitArgs = (repo: RepoDir, args: string[]): string[] => ['--no-replace-objects', '--literal-pathspecs', '-c', 'safe.bareRepository=explicit', '--git-dir', join(repo.top, '.git'), '--work-tree', repo.top, ...args];

function gitIn(repo: RepoDir, args: string[]): string {
  return execFileSync('git', gitArgs(repo, args), {
    cwd: repo.top,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
    env: gitEnv(repo),
  });
}

/** The commit id of `ref` in `repo`, or null when it is not a ref (or starts with `-`). */
export function resolveGitCommit(ref: string, repo: RepoDir): string | null {
  if (ref === '' || ref.startsWith('-')) return null;
  try {
    const commit = gitIn(repo, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]).trim();
    return /^[0-9a-f]{40,64}$/.test(commit) ? commit : null;
  } catch {
    return null;
  }
}

/**
 * Copies the file at repository path `path` (slash-separated, relative to the top level) as committed at `commit` to
 * `dest` below `root`, through the same hardened git (C2: the Action reads a workspace traces path at the PR's base
 * commit, never from the PR's working tree). Only a regular file is copied (a symbolic link or submodule is refused),
 * and only up to `maxBytes`. Returns the sha256 of the bytes written.
 */
export async function copyFileAtCommit(o: { commit: string; path: string; repo: RepoDir; root: string; dest: string; maxBytes: number }): Promise<string> {
  const what = `${JSON.stringify(o.path)} at the base commit ${o.commit.slice(0, 12)}`;
  if (o.path === '' || o.path.split('/').some((p) => p === '' || p === '.' || p === '..')) throw new Error(`traces path ${JSON.stringify(o.path)} is not a plain path in the repository`);
  let entry = '';
  try {
    entry = gitIn(o.repo, ['ls-tree', '-z', '--full-tree', o.commit, '--', o.path]);
  } catch {
    // reported below
  }
  const m = /^(\d{6}) (\w+) ([0-9a-f]{40,64})\t([^\0]*)\0$/.exec(entry);
  if (!m || m[4] !== o.path) throw new Error(`traces file ${what} does not exist in the base commit (in a pull request the traces are read from the base commit, never from the pull request)`);
  if (m[2] !== 'blob' || (m[1] !== '100644' && m[1] !== '100755')) throw new Error(`traces file ${what} must be a regular file`);
  const oid = m[3] ?? '';
  const size = Number(gitIn(o.repo, ['cat-file', '-s', oid]).trim());
  if (!Number.isSafeInteger(size) || size > o.maxBytes) throw new Error(`traces file ${what} is larger than ${o.maxBytes} bytes`);
  const out = await createWriteStreamUnder(o.root, o.dest);
  const hash = createHash('sha256');
  const child = spawn('git', gitArgs(o.repo, ['cat-file', 'blob', oid]), { cwd: o.repo.top, env: gitEnv(o.repo), stdio: ['ignore', 'pipe', 'ignore'] });
  const exited = new Promise<number | null>((done, fail) => {
    child.on('error', fail);
    child.on('close', done);
  });
  let seen = 0;
  const count = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      seen += chunk.length;
      hash.update(chunk);
      cb(seen > o.maxBytes ? new Error(`traces file ${what} is larger than ${o.maxBytes} bytes`) : null, chunk);
    },
  });
  await pipeline(child.stdout, count, out);
  if ((await exited) !== 0 || seen !== size) throw new Error(`could not read traces file ${what}`);
  return hash.digest('hex');
}

/** Policy files of the directory at git ref `ref` (`git show <commit>:<path>`); the ref is resolved to a commit id first. */
function filesAtRef(ref: string, repo: RepoDir): { files: Record<string, string>; parsed: ParsedPolicyText } {
  const commit = resolveGitCommit(ref, repo);
  if (commit === null) throw new Error(`--base ${JSON.stringify(ref)} is not a policy directory and not a git ref`);
  const show = (name: string): string | undefined => {
    try {
      return gitIn(repo, ['show', `${commit}:${repo.rel === '' ? name : `${repo.rel}/${name}`}`]);
    } catch {
      return undefined;
    }
  };
  const policy = show(POLICY_FILE);
  if (policy === undefined) throw new PolicyLoadError('E_FILE_MISSING', POLICY_FILE, [{ path: '', message: `${POLICY_FILE} not found in ${repo.label} at ${ref} (${commit})` }]);
  const files: Record<string, string> = { [POLICY_FILE]: policy };
  const parsed = parsePolicyText(policy);
  for (const name of policyFileNames(parsed)) {
    if (name === POLICY_FILE) continue;
    const text = show(name);
    if (text !== undefined) files[name] = text;
  }
  return { files, parsed };
}

/** The policy source of the directory at `ref`, each file parsed once. */
function sourceAtRef(dirLabel: string, ref: string, repo: RepoDir): PolicySource {
  const { files, parsed } = filesAtRef(ref, repo);
  return parsePolicyFiles(dirLabel, files, parsed);
}

/**
 * The policy files of the directory as committed at `commit`, always read as git objects: a directory in the working
 * tree that happens to be named like the commit or its branch is never consulted (the Action uses this for the base).
 */
export function loadPolicyAtCommit(o: { commit: string; repo: RepoDir; experimentalSubscription: boolean }): CompiledPolicy {
  return compileReplaySource(sourceAtRef(join(o.repo.top, o.repo.rel, `@${o.commit}`), o.commit, o.repo), { experimentalSubscription: o.experimentalSubscription });
}

/**
 * A loaded policy source compiled for replay. The revision is the one `serve --policy <dir>` records (the first 12 hex
 * of the content sha256), unless `revision` is given (a bundle built in CI records GITHUB_SHA).
 */
export function compileReplaySource(src: PolicySource, o: { revision?: string; experimentalSubscription: boolean }): CompiledPolicy {
  const revision = o.revision ?? buildBundle(src, { createdAt: '1970-01-01T00:00:00.000Z' }).manifest.revision;
  return compilePolicy(src, revision, { experimentalSubscription: o.experimentalSubscription });
}

/**
 * A policy for replay. `as` says how `source` is read (C11): 'dir' a policy directory; 'ref' the head directory's files
 * at that git ref, always as git objects through the hardened path, whatever the working tree holds; 'either' (the
 * `--base` alias) whichever of the two it is, refused when it is both.
 */
export async function loadReplayPolicy(o: { source: string; headDir: string; as?: 'dir' | 'ref' | 'either'; revision?: string; experimentalSubscription: boolean; root?: string }): Promise<CompiledPolicy> {
  const as = o.as ?? 'either';
  const isDir = as === 'ref' ? false : await stat(o.source).then((s) => s.isDirectory(), () => false);
  let src: PolicySource;
  if (as === 'dir' || (as === 'either' && isDir)) {
    if (as === 'either' && isRefIn(o.source, o.headDir)) {
      throw new Error(`--base ${JSON.stringify(o.source)} is both a directory and a git ref; say which with --base-ref ${o.source} (git objects) or --base-dir ${o.source} (the directory)`);
    }
    src = await loadPolicyDir(o.source, o.root === undefined ? {} : { root: o.root });
  } else {
    const repo = locateRepoDir(o.headDir, null);
    if (resolveGitCommit(o.source, repo) === null) throw new Error(as === 'ref' ? `--base-ref ${JSON.stringify(o.source)} is not a git ref` : `--base ${JSON.stringify(o.source)} is not a policy directory and not a git ref`);
    src = sourceAtRef(join(o.headDir, `@${o.source}`), o.source, repo);
  }
  return compileReplaySource(src, { ...(o.revision === undefined ? {} : { revision: o.revision }), experimentalSubscription: o.experimentalSubscription });
}

/** Whether `ref` is a git ref in the repository of `headDir` (false when that is not a repository). */
function isRefIn(ref: string, headDir: string): boolean {
  try {
    return resolveGitCommit(ref, locateRepoDir(headDir, null)) !== null;
  } catch {
    return false;
  }
}
