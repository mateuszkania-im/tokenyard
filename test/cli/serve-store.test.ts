import { execFile, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';
import { budgetKey } from '../../src/limits/keys.js';
import { createMemoryStore } from '../../src/limits/memory-store.js';
import { warmUpFromTraces } from '../../src/limits/open-store.js';
import { windowOf } from '../../src/policy/decide.js';
import { startAnthropicMock } from '../../src/mock/anthropic.js';
import { authHeaders, msgBody } from '../helpers/conformance.js';
import { PROVIDER_KEY_ENV, testPolicy } from '../helpers/policy.js';
import { tempDir, writePolicyDir } from '../helpers/policy-dir.js';
import { baseRecord } from '../helpers/trace.js';

const run = promisify(execFile);

/** One instance file with a segment line and a request record of `cost` micro-USD for team platform, now. */
function writeTraces(dir: string, cost: number): void {
  const now = new Date();
  const iso = now.toISOString();
  const day = join(dir, 'acme', iso.slice(0, 10));
  mkdirSync(day, { recursive: true });
  const b = baseRecord({ ts: iso, tenant: 'acme', team: 'platform', keyId: 'key_test' });
  const rec = { ...b, instance: 'old00001', seq: 1, outcome: { ...b.outcome, costMicroUsd: cost } };
  const seg = { v: 1, kind: 'segment', instance: 'old00001', startedAt: iso, firstSeq: 1 };
  writeFileSync(join(day, `${iso.slice(11, 13)}.old00001.ndjson`), `${JSON.stringify(seg)}\n${JSON.stringify(rec)}\n`);
}

test('warm-up seeds the spend of the current windows from the trace dir; a missing dir seeds nothing', async () => {
  const dir = tempDir('ty-traces-');
  writeTraces(dir, 1_234);
  const policy = testPolicy({ upstream: 'http://127.0.0.1:1' });
  const store = createMemoryStore({ clock: Date.now });
  expect(await warmUpFromTraces(store, dir, policy, Date.now())).toBeGreaterThan(0);
  const key = budgetKey('acme', 'team-day', 'platform', windowOf('day', Date.now()).start);
  expect((await store.snapshot([key]))[key]).toEqual({ spent: 1_234, reserved: 0 });
  expect(await warmUpFromTraces(store, join(dir, 'missing'), policy, Date.now())).toBe(0);
});

test('serve --store memory warms up from --trace-dir: spend recorded before the restart still counts', async () => {
  const mock = await startAnthropicMock();
  const dir = tempDir();
  writePolicyDir(dir, mock.url, 'one');
  const traces = tempDir('ty-traces-');
  writeTraces(traces, 300_000_000); // team-day is $300: already spent
  const child = spawn('node', ['bin/tokenyard.mjs', 'serve', '--port', '0', '--policy', dir, '--state-dir', tempDir('ty-state-'), '--store', 'memory', '--trace-dir', traces, '--trace-salt', 's'], {
    env: { ...process.env, [PROVIDER_KEY_ENV]: 'k' },
  });
  try {
    const url = await new Promise<string>((resolve, reject) => {
      child.stdout.once('data', (d: Buffer) => resolve(d.toString().trim()));
      child.once('exit', () => reject(new Error('serve exited early')));
    });
    const res = await fetch(`${url}/v1/messages`, { method: 'POST', headers: authHeaders, body: new Uint8Array(msgBody({ model: 'claude-sonnet-5-5' })) });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBeNull();
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain('budget "team-day" is exhausted');
    expect(mock.received).toHaveLength(0);
  } finally {
    child.kill('SIGTERM');
    await mock.close();
  }
});

test('serve refuses an unknown --store and --store redis without a URL', async () => {
  const dir = tempDir();
  writePolicyDir(dir, 'http://127.0.0.1:1', 'one');
  const base = ['bin/tokenyard.mjs', 'serve', '--port', '0', '--policy', dir, '--state-dir', tempDir('ty-state-')];
  const env = { ...process.env };
  delete env.TOKENYARD_REDIS_URL;
  await expect(run('node', [...base, '--store', 'disk'], { env })).rejects.toMatchObject({ stderr: expect.stringContaining('--store must be memory or redis') });
  await expect(run('node', [...base, '--store', 'redis'], { env })).rejects.toMatchObject({ stderr: expect.stringContaining('--redis-url') });
});
