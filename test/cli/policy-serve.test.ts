import { execFile, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';
import { startAnthropicMock } from '../../src/mock/anthropic.js';
import { PROVIDER_KEY_ENV } from '../helpers/policy.js';
import { authHeaders, msgBody } from '../helpers/conformance.js';
import { tempDir, writePolicyDir } from '../helpers/policy-dir.js';

const run = promisify(execFile);

test('policy build writes a verifiable bundle; GITHUB_SHA becomes the revision', async () => {
  const dir = tempDir();
  writePolicyDir(dir, 'http://127.0.0.1:1', 'one');
  const out = join(tempDir(), 'dist', 'bundle.json');
  await run('node', ['bin/tokenyard.mjs', 'policy', 'build', dir, '--out', out], { env: { ...process.env, GITHUB_SHA: 'a'.repeat(40) } });
  const { parseBundle } = await import('../../src/policy/bundle.js');
  const b = parseBundle(readFileSync(out, 'utf8'));
  expect(b.manifest.revision).toBe('a'.repeat(40));
  const out2 = join(tempDir(), 'b.json');
  const env = { ...process.env };
  delete env.GITHUB_SHA;
  await run('node', ['bin/tokenyard.mjs', 'policy', 'build', dir, '--out', out2], { env });
  expect(parseBundle(readFileSync(out2, 'utf8')).manifest.revision).toBe(b.manifest.sha256.slice(0, 12));
});

test('serve --policy loads a directory and forwards; without a source it refuses', async () => {
  const mock = await startAnthropicMock();
  const dir = tempDir();
  writePolicyDir(dir, mock.url, 'one');
  const child = spawn('node', ['bin/tokenyard.mjs', 'serve', '--port', '0', '--policy', dir, '--state-dir', tempDir('ty-state-')], { env: { ...process.env, [PROVIDER_KEY_ENV]: 'k' } });
  try {
    const url = await new Promise<string>((resolve, reject) => {
      child.stdout.once('data', (d: Buffer) => resolve(d.toString().trim()));
      child.once('exit', () => reject(new Error('serve exited early')));
    });
    const res = await fetch(`${url}/v1/messages`, { method: 'POST', headers: authHeaders, body: msgBody({ model: 'claude-sonnet-5-5' }) });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-tokenyard-policy-revision')).toMatch(/^[0-9a-f]{12}$/);
  } finally {
    child.kill('SIGTERM');
    await mock.close();
  }
  await expect(run('node', ['bin/tokenyard.mjs', 'serve', '--port', '0'])).rejects.toMatchObject({ stderr: expect.stringContaining('--policy') });
});
