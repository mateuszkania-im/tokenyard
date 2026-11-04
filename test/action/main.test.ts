// Spec 9.5 and 11: the GitHub Action. Reads policy files as data, never runs PR code, never reads a trace token in a fork PR.
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { cpSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { githubClient, runAction } from '../../src/action/main.js';

const ROOT = join(import.meta.dirname, '..', '..');
const TRACES = join(ROOT, 'examples/traces/demo.ndjson.gz');
const HEAD_POLICY = readFileSync(join(ROOT, 'examples/policy-head/policy.yaml'), 'utf8');

function fakeGh(existing: Array<{ id: number; body: string }> = []) {
  const calls = { list: 0, create: [] as string[], update: [] as Array<[number, string]> };
  return {
    calls,
    gh: {
      async listComments() {
        calls.list++;
        return existing;
      },
      async createComment(b: string) {
        calls.create.push(b);
      },
      async updateComment(id: number, b: string) {
        calls.update.push([id, b]);
      },
    },
  };
}

let tmp: string;
let repo: string;
let baseSha: string;
const git = (...args: string[]): string => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8' }).trim();

beforeEach(async () => {
  tmp = realpathSync(await mkdtemp(join(tmpdir(), 'ty-action-')));
  repo = join(tmp, 'repo');
  mkdirSync(repo);
  git('init', '-q', '-b', 'main');
  cpSync(join(ROOT, 'examples/policy'), join(repo, 'policy'), { recursive: true });
  git('add', '-A');
  git('commit', '-qm', 'base');
  baseSha = git('rev-parse', 'HEAD');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tmp, { recursive: true, force: true });
});

/** The pull request's head is the working tree of `repo/policy`: the demo change unless `headPolicy` says otherwise. */
function setHead(policy: string = HEAD_POLICY): void {
  writeFileSync(join(repo, 'policy/policy.yaml'), policy);
}

function envFor(o: { fork?: boolean; baseRef?: string; traces?: string; noEvent?: boolean; extra?: Record<string, string> } = {}): NodeJS.ProcessEnv {
  const event = join(tmp, 'event.json');
  writeFileSync(event, JSON.stringify({ pull_request: { number: 7, base: { sha: baseSha, repo: { full_name: 'o/r' } }, head: { sha: 'b'.repeat(40), repo: { full_name: o.fork ? 'someone/r' : 'o/r', fork: o.fork === true } } } }));
  return {
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_EVENT_PATH: o.noEvent ? join(tmp, 'missing.json') : event,
    GITHUB_STEP_SUMMARY: join(tmp, 'summary.md'),
    GITHUB_OUTPUT: join(tmp, 'output.txt'),
    GITHUB_SHA: 'b'.repeat(40),
    GITHUB_REPOSITORY: 'o/r',
    GITHUB_WORKSPACE: repo,
    RUNNER_TEMP: tmp,
    'INPUT_POLICY-DIR': join(repo, 'policy'),
    'INPUT_BASE-REF': o.baseRef ?? 'main',
    INPUT_TRACES: o.traces ?? TRACES,
    INPUT_COMMENT: 'true',
    INPUT_TOKEN: 'ghs_secret_token_value',
    'INPUT_TRACES-TOKEN': 'trace_secret_value',
    ...o.extra,
  };
}

const replayJson = (): { schemaVersion: number; base: { costMicroUsd: number }; head: { costMicroUsd: number }; gates: { failed: string[] } } => JSON.parse(readFileSync(join(tmp, 'replay.json'), 'utf8'));

test('action updates the existing sticky comment instead of adding a second', async () => {
  setHead();
  const f = fakeGh([
    { id: 1, body: 'unrelated' },
    { id: 42, body: '<!-- tokenyard-replay -->\nold' },
  ]);
  await runAction(envFor(), f.gh);
  expect(f.calls.create).toEqual([]);
  expect(f.calls.update).toHaveLength(1);
  expect(f.calls.update[0]?.[0]).toBe(42);
  expect(f.calls.update[0]?.[1].startsWith('<!-- tokenyard-replay -->')).toBe(true);
  const g = fakeGh([]);
  await runAction(envFor(), g.gh);
  expect(g.calls.create).toHaveLength(1);
  expect(g.calls.update).toEqual([]);
  expect(await readFile(join(tmp, 'summary.md'), 'utf8')).toContain('tokenyard policy replay');
});

test('fork PR: job summary only, no comment, no trace token read', async () => {
  setHead();
  const f = fakeGh();
  const read: string[] = [];
  const spy = new Proxy(envFor({ fork: true }), {
    get(t, k, r) {
      if (typeof k === 'string') read.push(k);
      return Reflect.get(t, k, r);
    },
  });
  await runAction(spy, f.gh);
  expect(f.calls.list + f.calls.create.length + f.calls.update.length).toBe(0);
  expect(read).not.toContain('INPUT_TRACES-TOKEN');
  expect(read).not.toContain('INPUT_TOKEN');
  expect(await readFile(join(tmp, 'summary.md'), 'utf8')).toContain('<!-- tokenyard-replay -->');
});

test('fork detection fails closed: a pull_request event with a missing or unparsable event file is treated as a fork', async () => {
  setHead();
  for (const bad of [true, false]) {
    const f = fakeGh();
    const env = envFor({ noEvent: true, ...(bad ? {} : {}) });
    if (!bad) writeFileSync(join(tmp, 'garbage.json'), '{not json');
    if (!bad) env.GITHUB_EVENT_PATH = join(tmp, 'garbage.json');
    env.GITHUB_BASE_REF = 'main';
    const read: string[] = [];
    const spy = new Proxy(env, {
      get(t, k, r) {
        if (typeof k === 'string') read.push(k);
        return Reflect.get(t, k, r);
      },
    });
    await runAction(spy, f.gh);
    expect(f.calls.list + f.calls.create.length + f.calls.update.length).toBe(0);
    expect(read).not.toContain('INPUT_TRACES-TOKEN');
    expect(read).not.toContain('INPUT_TOKEN');
  }
});

test('exit 1 when a ci.failOn gate fails; replay.json written for upload', async () => {
  setHead();
  const f = fakeGh();
  const code = await runAction(envFor(), f.gh);
  expect(code).toBe(1);
  expect(replayJson().schemaVersion).toBe(1);
  expect(replayJson().gates.failed.length).toBeGreaterThan(0);
  expect(readFileSync(join(tmp, 'output.txt'), 'utf8')).toContain(`replay-json=${join(tmp, 'replay.json')}`);
  expect(f.calls.create[0]).toContain('Check: **failed**');
  // head equal to base: nothing fails
  git('checkout', '-q', '--', 'policy/policy.yaml');
  expect(await runAction(envFor(), fakeGh().gh)).toBe(0);
});

test('the base policy is the git object at the PR base commit, never a working-tree path named like the ref', async () => {
  setHead();
  await runAction(envFor(), fakeGh().gh);
  const clean = replayJson();
  expect(clean.base.costMicroUsd).not.toBe(clean.head.costMicroUsd);
  // the PR head adds directories named like the base ref, like origin/main and like the base SHA, holding the head policy
  for (const name of ['main', 'origin/main', baseSha]) cpSync(join(repo, 'policy'), join(repo, name), { recursive: true });
  const old = process.cwd();
  process.chdir(repo);
  try {
    for (const baseRef of ['main', 'origin/main', baseSha, join(repo, 'main')]) {
      expect(await runAction(envFor({ baseRef }), fakeGh().gh)).toBe(1);
      expect(replayJson().base.costMicroUsd).toBe(clean.base.costMicroUsd);
    }
    // without an event base sha the input ref is resolved as a git ref, and a directory name alone is refused
    const env = envFor({ baseRef: 'main' });
    env.GITHUB_EVENT_PATH = join(tmp, 'missing.json');
    env.GITHUB_EVENT_NAME = 'workflow_dispatch';
    expect(await runAction(env, fakeGh().gh)).toBe(1);
    expect(replayJson().base.costMicroUsd).toBe(clean.base.costMicroUsd);
    const notRef = envFor({ baseRef: 'no-such-ref' });
    notRef.GITHUB_EVENT_PATH = join(tmp, 'missing.json');
    notRef.GITHUB_EVENT_NAME = 'workflow_dispatch';
    mkdirSync(join(repo, 'no-such-ref'));
    cpSync(join(repo, 'policy'), join(repo, 'no-such-ref'), { recursive: true });
    expect(await runAction(notRef, fakeGh().gh)).toBe(1);
    expect((console.error as ReturnType<typeof vi.fn>).mock.calls.flat().join('\n')).toContain('not a git ref');
  } finally {
    process.chdir(old);
  }
});

test('policy errors in the head fail the job before any replay and never log the token', async () => {
  const bad = join(repo, 'bad');
  mkdirSync(bad);
  writeFileSync(join(bad, 'policy.yaml'), 'routes: not-a-list\n');
  const f = fakeGh();
  const env = envFor();
  env['INPUT_POLICY-DIR'] = bad;
  expect(await runAction(env, f.gh)).toBe(1);
  const logged = JSON.stringify([...(console.log as ReturnType<typeof vi.fn>).mock.calls, ...(console.error as ReturnType<typeof vi.fn>).mock.calls]);
  expect(logged).not.toContain('ghs_secret_token_value');
  expect(logged).not.toContain('trace_secret_value');
});

test('a URL for traces is fetched with the traces token, but not in a fork PR', async () => {
  setHead();
  const seen: Array<string | undefined> = [];
  const body = readFileSync(TRACES);
  const srv: Server = createServer((req, res) => {
    seen.push(req.headers.authorization);
    res.end(body);
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as { port: number }).port;
  try {
    const url = `http://127.0.0.1:${port}/demo.ndjson.gz`;
    await runAction(envFor({ traces: url }), fakeGh().gh);
    await runAction(envFor({ traces: url, fork: true }), fakeGh().gh);
    expect(seen).toEqual(['Bearer trace_secret_value', undefined]);
  } finally {
    srv.close();
  }
});

test('a redirect from the traces URL is not followed', async () => {
  setHead();
  const hits: string[] = [];
  const target = createServer((req, res) => {
    hits.push(`target ${req.headers.authorization ?? 'no-auth'}`);
    res.end('x');
  });
  await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
  const tport = (target.address() as { port: number }).port;
  const first = createServer((_req, res) => {
    hits.push('first');
    res.writeHead(302, { location: `http://127.0.0.1:${tport}/t.ndjson.gz` }).end();
  });
  await new Promise<void>((r) => first.listen(0, '127.0.0.1', r));
  const fport = (first.address() as { port: number }).port;
  try {
    expect(await runAction(envFor({ traces: `http://127.0.0.1:${fport}/t.ndjson.gz` }), fakeGh().gh)).toBe(1);
    expect(hits).toEqual(['first']);
  } finally {
    first.close();
    target.close();
  }
});

test('only comments written by the token identity are updated; a foreign comment with the marker is left alone', async () => {
  const calls: string[] = [];
  const comments = [
    { id: 1, body: '<!-- tokenyard-replay -->\nforged', user: { login: 'mallory' } },
    { id: 2, body: '<!-- tokenyard-replay -->\nours', user: { login: 'github-actions[bot]' } },
    { id: 3, body: 'other', user: { login: 'github-actions[bot]' } },
  ];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.endsWith('/user')) return new Response('{}', { status: 403 });
    return new Response(JSON.stringify(comments), { status: 200 });
  });
  const env = envFor();
  const gh = githubClient(env);
  const listed = await gh.listComments();
  expect(listed.map((c) => c.id)).toEqual([2]);
  // a personal access token: the identity is the login from GET /user
  vi.mocked(globalThis.fetch).mockImplementation(async (url) => {
    const u = String(url);
    if (u.endsWith('/user')) return new Response(JSON.stringify({ login: 'mallory' }), { status: 200 });
    return new Response(JSON.stringify(comments), { status: 200 });
  });
  expect((await githubClient(env).listComments()).map((c) => c.id)).toEqual([1]);
});

test('a pull request base must be the event base sha: no fallback to the base-ref input', async () => {
  setHead();
  const env = envFor({ baseRef: 'main' });
  writeFileSync(env.GITHUB_EVENT_PATH as string, JSON.stringify({ pull_request: { number: 7, base: { sha: 'c'.repeat(40), repo: { full_name: 'o/r' } }, head: { sha: 'b'.repeat(40), repo: { full_name: 'o/r', fork: false } } } }));
  expect(await runAction(env, fakeGh().gh)).toBe(1);
  expect((console.error as ReturnType<typeof vi.fn>).mock.calls.flat().join('\n')).toContain('base commit');
  const noSha = envFor();
  writeFileSync(noSha.GITHUB_EVENT_PATH as string, JSON.stringify({ pull_request: { number: 7, base: { repo: { full_name: 'o/r' } }, head: { sha: 'b'.repeat(40), repo: { full_name: 'o/r', fork: false } } } }));
  expect(await runAction(noSha, fakeGh().gh)).toBe(1);
});

test('a nested .git directory or a bare-repo-shaped directory planted by the PR cannot influence the base', async () => {
  setHead();
  await runAction(envFor(), fakeGh().gh);
  const clean = replayJson();
  const dir = join(repo, 'policy');
  // a nested repository whose HEAD is a commit of its own, and a directory shaped like a bare repository
  const nested = join(dir, 'sub');
  mkdirSync(nested);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: nested });
  cpSync(join(ROOT, 'examples/policy-head'), join(nested, 'policy'), { recursive: true });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'add', '-A'], { cwd: nested });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'evil'], { cwd: nested });
  const evilSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: nested, encoding: 'utf8' }).trim();
  mkdirSync(join(dir, '.git'));
  cpSync(join(nested, '.git'), join(dir, '.git'), { recursive: true });
  const bare = join(dir, 'bare');
  cpSync(join(nested, '.git'), bare, { recursive: true });
  const env = envFor();
  writeFileSync(env.GITHUB_EVENT_PATH as string, JSON.stringify({ pull_request: { number: 7, base: { sha: evilSha, repo: { full_name: 'o/r' } }, head: { sha: 'b'.repeat(40), repo: { full_name: 'o/r', fork: false } } } }));
  expect(await runAction(env, fakeGh().gh)).toBe(1);
  expect((console.error as ReturnType<typeof vi.fn>).mock.calls.flat().join('\n')).toContain('base commit');
  // with the real base sha the result is the clean one
  expect(await runAction(envFor(), fakeGh().gh)).toBe(1);
  expect(replayJson().base.costMicroUsd).toBe(clean.base.costMicroUsd);
});

test('a symlinked policy directory, or a directory outside the workspace, is refused', async () => {
  setHead();
  symlinkSync(join(repo, 'policy'), join(repo, 'linked'));
  const env = envFor();
  env['INPUT_POLICY-DIR'] = join(repo, 'linked');
  expect(await runAction(env, fakeGh().gh)).toBe(1);
  expect((console.error as ReturnType<typeof vi.fn>).mock.calls.flat().join('\n')).toContain('symbolic link');
  mkdirSync(join(repo, 'real'));
  symlinkSync(join(repo, 'policy'), join(repo, 'real/inner'));
  const env2 = envFor();
  env2['INPUT_POLICY-DIR'] = join(repo, 'real/inner');
  expect(await runAction(env2, fakeGh().gh)).toBe(1);
  const outside = envFor();
  outside['INPUT_POLICY-DIR'] = join(tmp, 'elsewhere');
  mkdirSync(join(tmp, 'elsewhere'));
  expect(await runAction(outside, fakeGh().gh)).toBe(1);
  expect((console.error as ReturnType<typeof vi.fn>).mock.calls.flat().join('\n')).toContain('outside the workspace');
});

test('a traces file in the workspace reached through a symbolic link is refused (S-FS-1)', async () => {
  setHead();
  mkdirSync(join(tmp, 'elsewhere-traces'));
  cpSync(TRACES, join(tmp, 'elsewhere-traces', 'demo.ndjson.gz'));
  symlinkSync(join(tmp, 'elsewhere-traces'), join(repo, 'traces-link'));
  expect(await runAction(envFor({ traces: join(repo, 'traces-link', 'demo.ndjson.gz') }), fakeGh().gh)).toBe(1);
  expect((console.error as ReturnType<typeof vi.fn>).mock.calls.flat().join('\n')).toContain('symbolic link');
  // The same file copied into the workspace is read (outside a pull request: in one, a workspace path is read at the
  // base commit, C2).
  cpSync(TRACES, join(repo, 'demo.ndjson.gz'));
  expect(await runAction(envFor({ traces: join(repo, 'demo.ndjson.gz'), extra: { GITHUB_EVENT_NAME: 'push' } }), fakeGh().gh)).toBe(1);
  expect(replayJson().base.costMicroUsd).toBeGreaterThan(0);
});
