// S19-1, S19-2, S19-3 and S19-4 (coordinator findings, Task 19): the base side of the replay diff must not be
// influenced by the pull request.
//   S19-1 (HIGH)   base-ref resolved through a path first: a PR adding a directory named like the base ref set the base.
//   S19-2 (MEDIUM) the sticky comment upsert matched any author's marker comment.
//   S19-3 (MEDIUM) base commit fell back to baseRef and git used cwd discovery (planted nested or bare repository).
//   S19-4 (MEDIUM) the base-side path came from the realpath of a PR-controlled policy dir (symlink redirects it).
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { githubClient, runAction } from '../../src/action/main.js';
import { actionRepo, fakeGh, HEAD_POLICY, type ActionRepo } from './action-fixture.js';

let r: ActionRepo;
beforeEach(() => {
  r = actionRepo();
  writeFileSync(join(r.repo, 'policy/policy.yaml'), HEAD_POLICY);
});
afterEach(() => r.close());
const errors = (): string => (console.error as ReturnType<typeof vi.fn>).mock.calls.flat().join('\n');

test('S19-1 directories named like the base ref, origin/ref or the base sha do not become the base policy', async () => {
  await runAction(r.env(), fakeGh().gh);
  const clean = r.replayJson() as unknown as { base: { costMicroUsd: number }; head: { costMicroUsd: number } };
  expect(clean.base.costMicroUsd).not.toBe(clean.head.costMicroUsd);
  for (const name of ['main', 'origin/main', r.baseSha]) cpSync(join(r.repo, 'policy'), join(r.repo, name), { recursive: true });
  const old = process.cwd();
  process.chdir(r.repo);
  try {
    for (const baseRef of ['main', 'origin/main', r.baseSha, join(r.repo, 'main')]) {
      const env = r.env();
      env['INPUT_BASE-REF'] = baseRef;
      await runAction(env, fakeGh().gh);
      expect((r.replayJson() as unknown as typeof clean).base.costMicroUsd, baseRef).toBe(clean.base.costMicroUsd);
    }
  } finally {
    process.chdir(old);
  }
});

test('S19-2 only comments written by the token identity are updated', async () => {
  const comments = [
    { id: 1, body: '<!-- tokenyard-replay -->\nforged', user: { login: 'mallory' } },
    { id: 2, body: '<!-- tokenyard-replay -->\nours', user: { login: 'github-actions[bot]' } },
  ];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => (String(url).endsWith('/user') ? new Response('{}', { status: 403 }) : new Response(JSON.stringify(comments), { status: 200 })));
  expect((await githubClient(r.env()).listComments()).map((c) => c.id)).toEqual([2]);
  vi.mocked(globalThis.fetch).mockImplementation(async (url) => (String(url).endsWith('/user') ? new Response(JSON.stringify({ login: 'mallory' }), { status: 200 }) : new Response(JSON.stringify(comments), { status: 200 })));
  expect((await githubClient(r.env()).listComments()).map((c) => c.id)).toEqual([1]);
});

test('S19-3 a pull request needs the event base sha, with no fallback to the base-ref input', async () => {
  for (const base of [{ sha: 'c'.repeat(40), repo: { full_name: 'o/r' } }, { repo: { full_name: 'o/r' } }]) {
    const env = r.env();
    writeFileSync(env.GITHUB_EVENT_PATH as string, JSON.stringify({ pull_request: { number: 7, base, head: { sha: 'b'.repeat(40), repo: { full_name: 'o/r', fork: false } } } }));
    expect(await runAction(env, fakeGh().gh)).toBe(1);
  }
  expect(errors()).toContain('base commit');
});

test('S19-3 a nested repository or a bare-repository-shaped directory planted by the PR cannot supply the base commit', async () => {
  const dir = join(r.repo, 'policy');
  const nested = join(dir, 'sub');
  mkdirSync(nested);
  const g = (...a: string[]): string => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd: nested, encoding: 'utf8' }).trim();
  g('init', '-q', '-b', 'main');
  cpSync(join(r.repo, '..', 'repo', 'policy', 'policy.yaml'), join(nested, 'policy.yaml'));
  g('add', '-A');
  g('commit', '-qm', 'evil');
  const evilSha = g('rev-parse', 'HEAD');
  cpSync(join(nested, '.git'), join(dir, '.git'), { recursive: true });
  cpSync(join(nested, '.git'), join(dir, 'bare'), { recursive: true });
  const env = r.env();
  writeFileSync(env.GITHUB_EVENT_PATH as string, JSON.stringify({ pull_request: { number: 7, base: { sha: evilSha, repo: { full_name: 'o/r' } }, head: { sha: 'b'.repeat(40), repo: { full_name: 'o/r', fork: false } } } }));
  expect(await runAction(env, fakeGh().gh)).toBe(1);
  expect(errors()).toContain('base commit');
});

test('S19-4 a symlinked policy directory, or one below a symlinked component, is refused; a directory outside the workspace too', async () => {
  symlinkSync(join(r.repo, 'policy'), join(r.repo, 'linked'));
  const direct = r.env();
  direct['INPUT_POLICY-DIR'] = join(r.repo, 'linked');
  expect(await runAction(direct, fakeGh().gh)).toBe(1);
  expect(errors()).toContain('symbolic link');
  mkdirSync(join(r.repo, 'real'));
  symlinkSync(join(r.repo, 'policy'), join(r.repo, 'real/inner'));
  const below = r.env();
  below['INPUT_POLICY-DIR'] = join(r.repo, 'real/inner');
  expect(await runAction(below, fakeGh().gh)).toBe(1);
  mkdirSync(join(r.tmp, 'elsewhere'));
  const outside = r.env();
  outside['INPUT_POLICY-DIR'] = join(r.tmp, 'elsewhere');
  expect(await runAction(outside, fakeGh().gh)).toBe(1);
  expect(errors()).toContain('outside the workspace');
});
