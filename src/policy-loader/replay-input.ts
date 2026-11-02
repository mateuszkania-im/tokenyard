// The file side of `tokenyard policy replay` (R-P2): reads trace files and policy sources, hands data to src/replay.
import { execFileSync } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
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
export async function openReplayTraces(paths: string[]): Promise<AsyncIterable<LedgerLine>> {
  for (const p of paths) if ((await stat(p)).isDirectory()) throw new RawTraceDirError(p);
  return readLedger(paths);
}

/**
 * Policy files of `dir` at git ref `ref` (`git show <commit>:<path>`), relative to the repository that holds `dir`.
 * A ref that starts with `-` would be read as a git option and is refused before git runs; any other ref is resolved
 * to a commit id first (`rev-parse --verify --end-of-options`), and only that id reaches `git show`.
 */
function filesAtRef(ref: string, dir: string): Record<string, string> {
  if (ref === '' || ref.startsWith('-')) throw new Error(`--base ${JSON.stringify(ref)} is not a policy directory and not a git ref`);
  const git = (args: string[]): string => execFileSync('git', args, { cwd: resolve(dir), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  let commit: string;
  try {
    commit = git(['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]).trim();
  } catch {
    throw new Error(`--base ${JSON.stringify(ref)} is not a policy directory and not a git ref`);
  }
  if (!/^[0-9a-f]{40,64}$/.test(commit)) throw new Error(`--base ${JSON.stringify(ref)} is not a policy directory and not a git ref`);
  const top = git(['rev-parse', '--show-toplevel']).trim();
  const rel = relative(realpathSync(top), realpathSync(resolve(dir))).split('\\').join('/');
  const show = (name: string): string | undefined => {
    try {
      return git(['show', `${commit}:${rel === '' ? name : `${rel}/${name}`}`]);
    } catch {
      return undefined;
    }
  };
  const policy = show(POLICY_FILE);
  if (policy === undefined) throw new PolicyLoadError('E_FILE_MISSING', POLICY_FILE, [{ path: '', message: `${POLICY_FILE} not found in ${dir} at ${ref} (${commit})` }]);
  const files: Record<string, string> = { [POLICY_FILE]: policy };
  for (const name of policyFileNames(policy)) {
    if (name === POLICY_FILE) continue;
    const text = show(name);
    if (text !== undefined) files[name] = text;
  }
  return files;
}

/** The commit id of `ref` in the repository that holds `dir`, or null when it is not a ref (or starts with `-`). */
export function resolveGitCommit(ref: string, dir: string): string | null {
  if (ref === '' || ref.startsWith('-')) return null;
  try {
    const commit = execFileSync('git', ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], { cwd: resolve(dir), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    return /^[0-9a-f]{40,64}$/.test(commit) ? commit : null;
  } catch {
    return null;
  }
}

/**
 * The policy files of `dir` as committed at `commit`, always read as git objects: a directory in the working tree that
 * happens to be named like the commit or its branch is never consulted (the Action uses this for the base).
 */
export function loadPolicyAtCommit(o: { commit: string; dir: string; experimentalSubscription: boolean }): CompiledPolicy {
  const src = parsePolicyFiles(join(o.dir, `@${o.commit}`), filesAtRef(o.commit, o.dir));
  const revision = buildBundle(src, { createdAt: '1970-01-01T00:00:00.000Z' }).manifest.revision;
  return compilePolicy(src, revision, { experimentalSubscription: o.experimentalSubscription });
}

/**
 * A policy for replay from a directory, or from a git ref (the head directory's files at that ref). The revision is
 * the one `serve --policy <dir>` records (the first 12 hex of the content sha256), unless `revision` is given (a bundle
 * built in CI records GITHUB_SHA).
 */
export async function loadReplayPolicy(o: { source: string; headDir: string; revision?: string; experimentalSubscription: boolean }): Promise<CompiledPolicy> {
  const isDir = await stat(o.source).then((s) => s.isDirectory(), () => false);
  const src = isDir ? await loadPolicyDir(o.source) : parsePolicyFiles(join(o.headDir, `@${o.source}`), filesAtRef(o.source, o.headDir));
  const revision = o.revision ?? buildBundle(src, { createdAt: '1970-01-01T00:00:00.000Z' }).manifest.revision;
  return compilePolicy(src, revision, { experimentalSubscription: o.experimentalSubscription });
}
