import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, test } from 'vitest';
import { baseRecord } from '../helpers/trace.js';

const run = promisify(execFile);
let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

test('policy replay refuses a trace directory and names traces export', async () => {
  dir = await mkdtemp(join(tmpdir(), 'ty-cli-replay-'));
  await mkdir(join(dir, 'acme'), { recursive: true });
  await expect(run('node', ['bin/tokenyard.mjs', 'policy', 'replay', '--base', 'examples/policy', '--head', 'examples/policy', '--traces', dir])).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining('tokenyard traces export'),
  });
}, 30_000);

test('policy replay prints the report, writes JSON, and reads the base from a git ref', async () => {
  dir = await mkdtemp(join(tmpdir(), 'ty-cli-replay-'));
  const file = join(dir, 'traces.ndjson');
  const manifest = { v: 1, kind: 'manifest', since: '2026-11-02T10:00:00.000Z', until: '2026-11-02T11:00:00.000Z', instances: [] };
  await writeFile(file, [manifest, { ...baseRecord({ decision: { route: 'claude-code', action: 'forward', reason: null, chain: ['anthropic', 'anthropic-backup'], reservedMicroUsd: 0, boundAssumed: false, taintUnchecked: false, audit: [] } }), instance: 'i1', seq: 1 }].map((l) => JSON.stringify(l)).join('\n') + '\n');
  const fromDir = await run('node', ['bin/tokenyard.mjs', 'policy', 'replay', '--base', 'examples/policy', '--head', 'examples/policy', '--traces', file, '--json', join(dir, 'a.json'), '--base-revision', 'rev1']);
  expect(fromDir.stdout).toContain('tokenyard policy replay');
  expect(fromDir.stdout).toContain('Fidelity: base replay matches recorded decisions on 100.0% of requests.');
  await run('node', ['bin/tokenyard.mjs', 'policy', 'replay', '--base', 'HEAD', '--head', 'examples/policy', '--traces', file, '--json', join(dir, 'b.json'), '--base-revision', 'rev1']);
  const a = await readFile(join(dir, 'a.json'), 'utf8');
  expect(JSON.parse(a)).toMatchObject({ schemaVersion: 1, requests: 1, base: { forwarded: 1 } });
  expect(await readFile(join(dir, 'b.json'), 'utf8')).toBe(a);
}, 30_000);
