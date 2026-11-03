// Task 25 checklist (threat class: PR-controlled input influencing the base side of the diff), the head-tree config
// files: a pull request can commit `.gitattributes` (and `policy/.gitattributes`) naming a textconv driver or a
// clean/smudge filter for the policy files. If the runner's git config defines such a driver (git-lfs installs a
// filter globally on GitHub runners), a base read that applied attributes would return the driver's output instead of
// the base blob. The base side reads blobs with `git show <commit>:<path>` and `git cat-file`, which apply neither, and
// runs git without global or system config (C9); this pins it with drivers defined in the repository's own config,
// which the base-side git does read. The other members of the class are pinned by C9 (environment), S19-3 (planted
// nested and bare repositories), S19-4 (symlinked policy directory), C2 (traces at the base commit) and C11 (refs).
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { copyFileAtCommit, loadPolicyAtCommit, locateRepoDir } from '../../src/policy-loader/replay-input.js';

const ROOT = join(import.meta.dirname, '..', '..');
let tmp: string;
let repo: string;
let baseSha: string;
const git = (...args: string[]): string => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8' }).trim();

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ty-gitattr-')));
  repo = join(tmp, 'repo');
  mkdirSync(repo);
  git('init', '-q', '-b', 'main');
  cpSync(join(ROOT, 'examples/policy'), join(repo, 'policy'), { recursive: true });
  mkdirSync(join(repo, 'traces'));
  writeFileSync(join(repo, 'traces', 'base.ndjson'), '{"v":1}\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  baseSha = git('rev-parse', 'HEAD');
  // Drivers a runner could have configured. Each one, if applied, rewrites the content to a weakened policy.
  // `sed` reads stdin as a filter and the file git appends as a textconv; checked to change the output when applied.
  const evil = "sed 's/usd: 6000/usd: 999999/'";
  for (const [k, v] of [['diff.evil.textconv', evil], ['filter.evil.smudge', evil], ['filter.evil.clean', evil], ['filter.evil.required', 'true']]) git('config', k as string, v as string);
  // The pull request's head tree: attributes routing every file through the drivers, at the top and in policy/.
  writeFileSync(join(repo, '.gitattributes'), '*.yaml diff=evil filter=evil text eol=crlf\n*.ndjson diff=evil filter=evil\n');
  writeFileSync(join(repo, 'policy', '.gitattributes'), '*.yaml diff=evil filter=evil\n');
  git('add', '.gitattributes', 'policy/.gitattributes');
  git('commit', '-qm', 'head');
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

test('T25 head-tree .gitattributes with textconv and filter drivers do not change the base policy read', () => {
  const repoDir = locateRepoDir(join(repo, 'policy'), repo);
  const base = loadPolicyAtCommit({ commit: baseSha, repo: repoDir, experimentalSubscription: false });
  const org = base.budgets.find((b) => b.name === 'org-month');
  expect(org?.limitMicroUsd).toBe(6000 * 1_000_000);
  // The base commit has no attributes at all; the head commit's files do not reach the base read either.
  expect(git('show', '--textconv', `HEAD:policy/policy.yaml`)).toContain('usd: 999999'); // the drivers are live
  expect(git('show', `${baseSha}:policy/policy.yaml`)).toBe(readFileSync(join(ROOT, 'examples/policy/policy.yaml'), 'utf8').trimEnd());
});

test('T25 head-tree .gitattributes do not change a traces file copied at the base commit', async () => {
  const repoDir = locateRepoDir(join(repo, 'policy'), repo);
  const dest = join(tmp, 'out', 'base.ndjson');
  mkdirSync(join(tmp, 'out'));
  await copyFileAtCommit({ commit: baseSha, path: 'traces/base.ndjson', repo: repoDir, root: tmp, dest, maxBytes: 1024 });
  expect(readFileSync(dest, 'utf8')).toBe('{"v":1}\n');
});
