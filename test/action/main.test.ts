// Spec 9.5: the GitHub Action. Reads policy files as data, never runs PR code, never reads a trace token in a fork PR.
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { runAction } from '../../src/action/main.js';

const ROOT = join(import.meta.dirname, '..', '..');
const TRACES = join(ROOT, 'examples/traces/demo.ndjson.gz');
const HEAD_DIR = join(ROOT, 'examples/policy-head');
const BASE_DIR = join(ROOT, 'examples/policy');

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
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'ty-action-'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tmp, { recursive: true, force: true });
});

async function envFor(o: { fork?: boolean; headDir?: string; baseRef?: string; traces?: string; extra?: Record<string, string> } = {}): Promise<NodeJS.ProcessEnv> {
  const event = join(tmp, 'event.json');
  await writeFile(event, JSON.stringify({ pull_request: { number: 7, base: { sha: 'a'.repeat(40), repo: { full_name: 'o/r' } }, head: { sha: 'b'.repeat(40), repo: { full_name: o.fork ? 'someone/r' : 'o/r', fork: o.fork === true } } } }));
  return {
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_EVENT_PATH: event,
    GITHUB_STEP_SUMMARY: join(tmp, 'summary.md'),
    GITHUB_OUTPUT: join(tmp, 'output.txt'),
    GITHUB_SHA: 'b'.repeat(40),
    GITHUB_REPOSITORY: 'o/r',
    RUNNER_TEMP: tmp,
    'INPUT_POLICY-DIR': o.headDir ?? HEAD_DIR,
    'INPUT_BASE-REF': o.baseRef ?? BASE_DIR,
    INPUT_TRACES: o.traces ?? TRACES,
    INPUT_COMMENT: 'true',
    INPUT_TOKEN: 'ghs_secret_token_value',
    'INPUT_TRACES-TOKEN': 'trace_secret_value',
    ...o.extra,
  };
}

test('action updates the existing sticky comment instead of adding a second', async () => {
  const f = fakeGh([
    { id: 1, body: 'unrelated' },
    { id: 42, body: '<!-- tokenyard-replay -->\nold' },
  ]);
  await runAction(await envFor(), f.gh);
  expect(f.calls.create).toEqual([]);
  expect(f.calls.update).toHaveLength(1);
  expect(f.calls.update[0]?.[0]).toBe(42);
  expect(f.calls.update[0]?.[1].startsWith('<!-- tokenyard-replay -->')).toBe(true);
  const g = fakeGh([]);
  await runAction(await envFor(), g.gh);
  expect(g.calls.create).toHaveLength(1);
  expect(g.calls.update).toEqual([]);
  expect(await readFile(join(tmp, 'summary.md'), 'utf8')).toContain('tokenyard policy replay');
});

test('fork PR: job summary only, no comment, no trace token read', async () => {
  const f = fakeGh();
  const env = await envFor({ fork: true });
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
  expect(await readFile(join(tmp, 'summary.md'), 'utf8')).toContain('<!-- tokenyard-replay -->');
});

test('exit 1 when a ci.failOn gate fails; replay.json written for upload', async () => {
  const f = fakeGh();
  const code = await runAction(await envFor(), f.gh);
  expect(code).toBe(1);
  const json = JSON.parse(readFileSync(join(tmp, 'replay.json'), 'utf8')) as { schemaVersion: number; gates: { failed: string[] } };
  expect(json.schemaVersion).toBe(1);
  expect(json.gates.failed.length).toBeGreaterThan(0);
  expect(readFileSync(join(tmp, 'output.txt'), 'utf8')).toContain(`replay-json=${join(tmp, 'replay.json')}`);
  expect(f.calls.create[0]).toContain('Check: **failed**');
  // identical policies: nothing fails
  const ok = await runAction(await envFor({ headDir: BASE_DIR }), fakeGh().gh);
  expect(ok).toBe(0);
});

test('policy errors in the head fail the job before any replay and never log the token', async () => {
  const bad = join(tmp, 'bad');
  await (await import('node:fs/promises')).mkdir(bad);
  await writeFile(join(bad, 'policy.yaml'), 'routes: not-a-list\n');
  const f = fakeGh();
  const code = await runAction(await envFor({ headDir: bad }), f.gh);
  expect(code).toBe(1);
  const logged = JSON.stringify([...(console.log as ReturnType<typeof vi.fn>).mock.calls, ...(console.error as ReturnType<typeof vi.fn>).mock.calls]);
  expect(logged).not.toContain('ghs_secret_token_value');
  expect(logged).not.toContain('trace_secret_value');
});

test('a URL for traces is fetched with the traces token, but not in a fork PR', async () => {
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
    await runAction(await envFor({ traces: url }), fakeGh().gh);
    await runAction(await envFor({ traces: url, fork: true }), fakeGh().gh);
    expect(seen).toEqual(['Bearer trace_secret_value', undefined]);
  } finally {
    srv.close();
  }
});
