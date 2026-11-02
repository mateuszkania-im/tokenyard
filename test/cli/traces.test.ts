import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, test } from 'vitest';
import { startAnthropicMock } from '../../src/mock/anthropic.js';

const run = promisify(execFile);
let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

test('serve --trace-dir without a salt refuses to start', async () => {
  const env = { ...process.env, TOKENYARD_TRACE_SALT: '' };
  await expect(run('node', ['bin/tokenyard.mjs', 'serve', '--port', '0', '--dev-upstream', 'http://127.0.0.1:1', '--trace-dir', '/tmp/never'], { env })).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining('--trace-salt'),
  });
});

test('serve writes traces with a ULID request id, then export and report read them', async () => {
  dir = await mkdtemp(join(tmpdir(), 'ty-cli-trace-'));
  const mock = await startAnthropicMock();
  const child = spawn('node', ['bin/tokenyard.mjs', 'serve', '--port', '0', '--dev-upstream', mock.url, '--trace-dir', dir, '--instance-id', 'cli1', '--trace-salt', 's'], { env: { ...process.env, TOKENYARD_DEV_UPSTREAM_KEY: 'x' } });
  try {
    const url = await new Promise<string>((resolve, reject) => {
      child.stdout.once('data', (d: Buffer) => resolve(d.toString().trim()));
      child.once('exit', () => reject(new Error('serve exited early')));
    });
    const res = await fetch(`${url}/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': 'ty_live_dev', 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-test', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.headers.get('x-tokenyard-request-id')).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    await res.arrayBuffer();
    await new Promise((r) => setTimeout(r, 150));
    const exited = new Promise((r) => child.once('exit', r));
    child.kill('SIGTERM');
    await exited;
  } finally {
    child.kill('SIGKILL');
    await mock.close();
  }
  const tenant = (await readdir(dir))[0]!;
  const day = (await readdir(join(dir, tenant)))[0]!;
  const text = await readFile(join(dir, tenant, day, (await readdir(join(dir, tenant, day)))[0]!), 'utf8');
  expect(text).toContain('"kind":"shutdown"');
  const out = join(dir, 'export.ndjson');
  await run('node', ['bin/tokenyard.mjs', 'traces', 'export', '--trace-dir', dir, '--out', out, '--since', '1d']);
  expect((await readFile(out, 'utf8')).split('\n')[0]).toContain('"kind":"manifest"');
  const { stdout } = await run('node', ['bin/tokenyard.mjs', 'report', '--traces', out, '--by', 'tenant']);
  expect(stdout).toContain('total');
  expect(stdout).toContain('1');
});
