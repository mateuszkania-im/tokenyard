// C11 (security review C): `tokenyard policy replay --base main`, the form the README showed, resolved --base as a
// working-tree directory first. In a pull request checkout (GitLab CI, a local review of a contributor's branch, a
// hand-written workflow) a PR that adds main/policy.yaml supplied the base side of the diff and passed the gate.
// --base-ref always reads git objects through the hardened path, --base-dir always reads a directory, and --base stays
// only as an alias that refuses a value that is both a directory and a git ref.
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const BIN = join(ROOT, 'bin/tokenyard.mjs');
const TRACES = join(ROOT, 'examples/traces/demo.ndjson.gz');
let tmp: string;
let repo: string;
const git = (...args: string[]): string => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8' }).trim();

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ty-c11-')));
  repo = join(tmp, 'repo');
  mkdirSync(repo);
  git('init', '-q', '-b', 'main');
  cpSync(join(ROOT, 'examples/policy'), join(repo, 'policy'), { recursive: true });
  git('add', '-A');
  git('commit', '-qm', 'base');
  git('checkout', '-qb', 'pr');
  // the PR tightens team-day to $6 (the demo change, which fails the cutSessions gate) and plants main/ as a "base"
  writeFileSync(join(repo, 'policy/policy.yaml'), readFileSync(join(ROOT, 'examples/policy-head/policy.yaml'), 'utf8'));
  cpSync(join(repo, 'policy'), join(repo, 'main'), { recursive: true });
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function replay(base: string[]): { status: number | null; stderr: string; json: { base: { costMicroUsd: number }; head: { costMicroUsd: number }; gates: { failed: string[] } } | null } {
  const out = join(tmp, `r-${Math.random().toString(36).slice(2)}.json`);
  const r = spawnSync(process.execPath, [BIN, 'policy', 'replay', ...base, '--head', 'policy', '--traces', TRACES, '--json', out], { cwd: repo, encoding: 'utf8' });
  let json = null;
  try {
    json = JSON.parse(readFileSync(out, 'utf8'));
  } catch {
    // no result written
  }
  return { status: r.status, stderr: r.stderr, json };
}

test('C11 --base-ref reads the ref as git objects even when a directory of that name exists', () => {
  const r = replay(['--base-ref', 'main']);
  expect(r.json, r.stderr).not.toBeNull();
  expect(r.json?.gates.failed.length).toBeGreaterThan(0);
  expect(r.json?.base.costMicroUsd).not.toBe(r.json?.head.costMicroUsd);
});

test('C11 --base-dir reads the directory', () => {
  const r = replay(['--base-dir', 'main']);
  expect(r.json).not.toBeNull();
  expect(r.json?.base.costMicroUsd).toBe(r.json?.head.costMicroUsd);
});

test('C11 --base refuses a value that is both a directory and a git ref, and names both options', () => {
  const r = replay(['--base', 'main']);
  expect(r.status).toBe(1);
  expect(r.json).toBeNull();
  expect(r.stderr).toMatch(/both a directory and a git ref/);
  expect(r.stderr).toMatch(/--base-ref/);
  expect(r.stderr).toMatch(/--base-dir/);
});

test('C11 --base still works when it is only one of the two', () => {
  rmSync(join(repo, 'main'), { recursive: true });
  const ref = replay(['--base', 'main']);
  expect(ref.json, ref.stderr).not.toBeNull();
  expect(ref.json?.gates.failed.length).toBeGreaterThan(0);
  cpSync(join(repo, 'policy'), join(repo, 'other'), { recursive: true });
  const other = replay(['--base', 'other']).json;
  expect(other).not.toBeNull();
  expect(other?.base.costMicroUsd).toBe(other?.head.costMicroUsd);
});

test('C11 exactly one base option is required', () => {
  expect(replay([]).status).toBe(1);
  const both = replay(['--base-ref', 'main', '--base-dir', 'main']);
  expect(both.status).toBe(1);
  expect(both.json).toBeNull();
});
