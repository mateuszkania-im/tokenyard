// C2 (security review C): the Action read a traces path inside the checkout from the pull request's working tree, so a
// PR that loosened the policy could also rewrite the (binary, gzip) traces and make both sides of the diff, and the
// gate, show nothing. In a pull_request event a workspace traces path is now read at the base commit as a git object
// (regular file only, size-capped), and the comment prints the sha256 of the traces that were replayed. Local trace
// files also have a cap on decompressed bytes and on line length (a gzip bomb or a file without line breaks).
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { runAction } from '../../src/action/main.js';
import { openReplayTraces, REPLAY_TRACE_LIMITS } from '../../src/policy-loader/replay-input.js';
import { actionRepo, fakeGh, HEAD_POLICY, ROOT, TRACES, type ActionRepo } from './action-fixture.js';

let r: ActionRepo;
beforeEach(() => {
  r = actionRepo();
  writeFileSync(join(r.repo, 'policy/policy.yaml'), HEAD_POLICY);
});
afterEach(() => r.close());

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

test('C2 traces rewritten by the PR are not replayed: the base commit copy is, and its sha256 is in the comment', async () => {
  const f1 = fakeGh();
  expect(await runAction(r.env(), f1.gh)).toBe(1);
  const honest = r.replayJson();
  expect(honest.gates.failed.length).toBeGreaterThan(0);
  expect(f1.created[0]).toContain(sha256(readFileSync(TRACES)));
  // the PR keeps the manifest and the first 10 records only
  const lines = gunzipSync(readFileSync(TRACES)).toString('utf8').split('\n').filter(Boolean);
  writeFileSync(join(r.repo, 'traces/demo.ndjson.gz'), gzipSync(`${lines.slice(0, 11).join('\n')}\n`));
  const f2 = fakeGh();
  expect(await runAction(r.env(), f2.gh)).toBe(1);
  const forged = r.replayJson();
  expect({ requests: forged.requests, failed: forged.gates.failed }).toEqual({ requests: honest.requests, failed: honest.gates.failed });
  expect(f2.created[0]).toContain(sha256(readFileSync(TRACES)));
  expect(f2.created[0]).not.toContain(sha256(readFileSync(join(r.repo, 'traces/demo.ndjson.gz'))));
});

test('C2 a traces path the base commit does not have is refused, not read from the PR', async () => {
  mkdirSync(join(r.repo, 'new'));
  writeFileSync(join(r.repo, 'new/t.ndjson.gz'), readFileSync(TRACES));
  expect(await runAction(r.env({ traces: join(r.repo, 'new/t.ndjson.gz') }), fakeGh().gh)).toBe(1);
  expect(r.stderr.join('\n')).toMatch(/base commit/);
});

test('C2 a traces path that is a symbolic link in the base commit is refused', async () => {
  symlinkSync('/etc/hosts', join(r.repo, 'traces/link.ndjson'));
  r.git('add', '-A');
  r.git('commit', '-qm', 'link');
  // the PR removes it from the working tree: only the base commit has it
  rmSync(join(r.repo, 'traces/link.ndjson'));
  const env = r.env({ traces: join(r.repo, 'traces/link.ndjson') });
  // the event's base is the commit with the link
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH ?? '', 'utf8'));
  event.pull_request.base.sha = r.git('rev-parse', 'HEAD');
  writeFileSync(env.GITHUB_EVENT_PATH ?? '', JSON.stringify(event));
  expect(await runAction(env, fakeGh().gh)).toBe(1);
  expect(r.stderr.join('\n')).toMatch(/regular file/);
});

test('C2 local traces: a gzip bomb and a line without a break are refused while reading', async () => {
  const bomb = join(r.tmp, 'bomb.ndjson.gz');
  writeFileSync(bomb, gzipSync(Buffer.alloc(8 * 1024 * 1024, '\n')));
  const drain = async (paths: string[], limits?: { maxBytes?: number; maxLineBytes?: number }, root = r.tmp): Promise<number> => {
    let n = 0;
    for await (const _ of await openReplayTraces(paths, { root, ...(limits ? { limits } : {}) })) n++;
    return n;
  };
  await expect(drain([bomb], { maxBytes: 1024 * 1024 })).rejects.toThrow(/decompress|bytes/);
  const long = join(r.tmp, 'long.ndjson.gz');
  writeFileSync(long, gzipSync(Buffer.alloc(4 * 1024 * 1024, 'a')));
  await expect(drain([long])).rejects.toThrow(/line/);
  // the demo export is well inside both caps
  expect(await drain([TRACES], undefined, ROOT)).toBeGreaterThan(100);
});

// Fix round 1: 4 GiB of decompressed records would exhaust the heap before the cap fired; 1 GiB fails with a clean error.
test('C2 the default decompressed cap is 1 GiB and one line 1 MiB, applied without explicit limits', async () => {
  expect(REPLAY_TRACE_LIMITS).toEqual({ maxBytes: 1024 * 1024 * 1024, maxLineBytes: 1024 * 1024 });
  const long = join(r.tmp, 'long.ndjson');
  writeFileSync(long, Buffer.alloc(REPLAY_TRACE_LIMITS.maxLineBytes + 1, 'a'));
  const read = async (): Promise<void> => {
    for await (const _ of await openReplayTraces([long], { root: r.tmp })) void _;
  };
  await expect(read()).rejects.toThrow(/longer than 1048576 bytes/);
});
