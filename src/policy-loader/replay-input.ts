// The file side of `tokenyard policy replay` (R-P2): reads trace files and policy sources, hands data to src/replay.
import { execFileSync } from 'node:child_process';
import { lstat, stat } from 'node:fs/promises';
import { checkPath, cliRoot } from '../fsutil/safe-path.js';
import { lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { readLedger } from '../ledger/reader.js';
import type { LedgerLine } from '../ledger/record.js';
import { buildBundle } from '../policy/bundle.js';
import { compilePolicy } from '../policy/compile.js';
import { parsePolicyFiles, policyFileNames, POLICY_FILE, PolicyLoadError } from '../policy/load-dir.js';
import type { CompiledPolicy } from '../policy/types.js';
import { RawTraceDirError } from '../replay/engine.js';
import { loadPolicyDir } from './load-dir.js';

/**
 * Lines of one or more export files (plain or .gz). A directory is refused before anything is read: replay needs the
 * merged set `tokenyard traces export` writes, never raw per-instance files (spec 9.2 step 1).
 */
export async function openReplayTraces(paths: string[], o: { root?: string } = {}): Promise<AsyncIterable<LedgerLine>> {
  for (const p of paths) {
    await checkPath(o.root ?? cliRoot(p), p);
    if ((await lstat(p)).isDirectory()) throw new RawTraceDirError(p);
  }
  return readLedger(paths);
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
  const top = realpathSync(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: resolve(dir), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim());
  return { top, rel: relative(top, realpathSync(resolve(dir))).split(sep).join('/'), label: dir };
}

/**
 * git against an explicit repository: its git dir and work tree are `top`, discovery and bare or nested repositories
 * found in the tree are off (`safe.bareRepository=explicit`, a ceiling at the parent of `top`).
 */
function gitIn(repo: RepoDir, args: string[]): string {
  return execFileSync('git', ['-c', 'safe.bareRepository=explicit', '--git-dir', join(repo.top, '.git'), '--work-tree', repo.top, ...args], {
    cwd: repo.top,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(repo.top) },
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

/** Policy files of the directory at git ref `ref` (`git show <commit>:<path>`); the ref is resolved to a commit id first. */
function filesAtRef(ref: string, repo: RepoDir): Record<string, string> {
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
  for (const name of policyFileNames(policy)) {
    if (name === POLICY_FILE) continue;
    const text = show(name);
    if (text !== undefined) files[name] = text;
  }
  return files;
}

/**
 * The policy files of the directory as committed at `commit`, always read as git objects: a directory in the working
 * tree that happens to be named like the commit or its branch is never consulted (the Action uses this for the base).
 */
export function loadPolicyAtCommit(o: { commit: string; repo: RepoDir; experimentalSubscription: boolean }): CompiledPolicy {
  const src = parsePolicyFiles(join(o.repo.top, o.repo.rel, `@${o.commit}`), filesAtRef(o.commit, o.repo));
  const revision = buildBundle(src, { createdAt: '1970-01-01T00:00:00.000Z' }).manifest.revision;
  return compilePolicy(src, revision, { experimentalSubscription: o.experimentalSubscription });
}

/**
 * A policy for replay from a directory, or from a git ref (the head directory's files at that ref). The revision is
 * the one `serve --policy <dir>` records (the first 12 hex of the content sha256), unless `revision` is given (a bundle
 * built in CI records GITHUB_SHA).
 */
export async function loadReplayPolicy(o: { source: string; headDir: string; revision?: string; experimentalSubscription: boolean; root?: string }): Promise<CompiledPolicy> {
  const isDir = await stat(o.source).then((s) => s.isDirectory(), () => false);
  const src = isDir ? await loadPolicyDir(o.source, o.root === undefined ? {} : { root: o.root }) : parsePolicyFiles(join(o.headDir, `@${o.source}`), filesAtRef(o.source, locateRepoDir(o.headDir, null)));
  const revision = o.revision ?? buildBundle(src, { createdAt: '1970-01-01T00:00:00.000Z' }).manifest.revision;
  return compilePolicy(src, revision, { experimentalSubscription: o.experimentalSubscription });
}
