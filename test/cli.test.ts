import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';
import pkg from '../package.json' with { type: 'json' };

test('tokenyard --version prints package version', async () => {
  const { stdout } = await promisify(execFile)('node', ['bin/tokenyard.mjs', '--version']);
  expect(stdout.trim()).toBe(pkg.version);
});

test('tokenyard mock prints its URL and serves count_tokens', async () => {
  const { spawn } = await import('node:child_process');
  const child = spawn('node', ['bin/tokenyard.mjs', 'mock', '--port', '0']);
  try {
    const url = await new Promise<string>((resolve, reject) => {
      child.stdout.once('data', (d: Buffer) => resolve(d.toString().trim()));
      child.once('error', reject);
      child.once('exit', () => reject(new Error('mock exited early')));
    });
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const res = await fetch(`${url}/v1/messages/count_tokens`, {
      method: 'POST',
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hello world' }] }),
    });
    expect((await res.json()).input_tokens).toBeGreaterThan(0);
  } finally {
    child.kill('SIGTERM');
  }
});

test('tokenyard serve --dev-upstream forwards to the upstream', async () => {
  const { spawn } = await import('node:child_process');
  const { startAnthropicMock } = await import('../src/mock/anthropic.js');
  const mock = await startAnthropicMock();
  const child = spawn('node', ['bin/tokenyard.mjs', 'serve', '--port', '0', '--dev-upstream', mock.url, '--no-metrics']);
  try {
    const url = await new Promise<string>((resolve, reject) => {
      child.stdout.once('data', (d: Buffer) => resolve(d.toString().trim()));
      child.once('error', reject);
      child.once('exit', () => reject(new Error('serve exited early')));
    });
    const res = await fetch(`${url}/v1/messages?beta=true`, {
      method: 'POST',
      headers: { authorization: 'Bearer ty_live_dev', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-haiku-5-5', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.status).toBe(200);
    expect(mock.received[0]?.pathAndQuery).toBe('/v1/messages?beta=true');
  } finally {
    child.kill('SIGTERM');
    await mock.close();
  }
});
