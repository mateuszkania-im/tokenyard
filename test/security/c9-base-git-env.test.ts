// C9 (security review C): git for the base side of a replay ran with the whole process environment. GIT_REPLACE_REF_BASE
// plus an ordinary tag named like the base policy blob swapped the blob `git show` returned (as would
// GIT_OBJECT_DIRECTORY, GIT_ALTERNATE_OBJECT_DIRECTORIES or GIT_CONFIG_COUNT/KEY/VALUE), so any earlier workflow step
// that can write $GITHUB_ENV chose the base policy. git now runs with an environment built from scratch, replace
// objects off (GIT_NO_REPLACE_OBJECTS=1 and --no-replace-objects), and no system or global config.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { loadPolicyAtCommit, locateRepoDir, resolveGitCommit } from '../../src/policy-loader/replay-input.js';

const ROOT = join(import.meta.dirname, '..', '..');
let tmp: string;
let repo: string;
let baseSha: string;
let savedEnv: NodeJS.ProcessEnv;
const git = (...args: string[]): string => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8' }).trim();

beforeEach(() => {
  savedEnv = { ...process.env };
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ty-c9-')));
  repo = join(tmp, 'repo');
  mkdirSync(repo);
  git('init', '-q', '-b', 'main');
  cpSync(join(ROOT, 'examples/policy'), join(repo, 'policy'), { recursive: true });
  git('add', '-A');
  git('commit', '-qm', 'base');
  baseSha = git('rev-parse', 'HEAD');
});
afterEach(() => {
  process.env = savedEnv;
  rmSync(tmp, { recursive: true, force: true });
});

const budgets = (): number[] => loadPolicyAtCommit({ commit: baseSha, repo: locateRepoDir(join(repo, 'policy'), repo), experimentalSubscription: false }).budgets.map((b) => b.limitMicroUsd);

function evilBlob(): { blob: string; evil: string } {
  const blob = git('rev-parse', `${baseSha}:policy/policy.yaml`);
  const text = readFileSync(join(repo, 'policy/policy.yaml'), 'utf8').replace(/usd: 6000/, 'usd: 999999');
  expect(text).toContain('usd: 999999');
  const evil = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: repo, input: text, encoding: 'utf8' }).trim();
  return { blob, evil };
}

test('C9 a replace ref under GIT_REPLACE_REF_BASE does not swap the base policy blob', () => {
  const before = budgets();
  const { blob, evil } = evilBlob();
  git('tag', blob, evil);
  process.env.GIT_REPLACE_REF_BASE = 'refs/tags/';
  expect(budgets()).toEqual(before);
});

test('C9 a replace ref in the default refs/replace/ namespace is ignored too', () => {
  const before = budgets();
  const { blob, evil } = evilBlob();
  git('replace', blob, evil);
  expect(budgets()).toEqual(before);
});

test('C9 GIT_CONFIG_COUNT / KEY / VALUE and GIT_CONFIG_GLOBAL from the environment do not reach git', () => {
  const before = budgets();
  const { blob, evil } = evilBlob();
  git('tag', blob, evil);
  const cfg = join(tmp, 'gitconfig');
  writeFileSync(cfg, '[core]\n\tuseReplaceRefs = true\n');
  Object.assign(process.env, { GIT_CONFIG_GLOBAL: cfg, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.useReplaceRefs', GIT_CONFIG_VALUE_0: 'true', GIT_REPLACE_REF_BASE: 'refs/tags/' });
  expect(budgets()).toEqual(before);
});

test('C9 GIT_OBJECT_DIRECTORY / GIT_ALTERNATE_OBJECT_DIRECTORIES from the environment do not reach git', () => {
  const other = join(tmp, 'other');
  mkdirSync(other);
  execFileSync('git', ['init', '-q', '--bare', other]);
  Object.assign(process.env, { GIT_OBJECT_DIRECTORY: join(other, 'objects'), GIT_ALTERNATE_OBJECT_DIRECTORIES: join(other, 'objects') });
  expect(resolveGitCommit(baseSha, locateRepoDir(join(repo, 'policy'), repo))).toBe(baseSha);
  expect(budgets().length).toBeGreaterThan(0);
});
