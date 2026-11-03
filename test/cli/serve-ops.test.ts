import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { promisify } from 'node:util';
import { afterEach, expect, test } from 'vitest';

const run = promisify(execFile);
const kids: ChildProcess[] = [];
afterEach(() => {
  for (const k of kids.splice(0)) k.kill('SIGTERM');
});

const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });

function serve(extra: string[], env: NodeJS.ProcessEnv = {}): Promise<string> {
  const child = spawn('node', ['bin/tokenyard.mjs', 'serve', '--port', '0', '--dev-upstream', 'http://127.0.0.1:9', ...extra], { env: { ...process.env, TOKENYARD_DEV_UPSTREAM_KEY: 'x', ...env } });
  kids.push(child);
  return new Promise((resolve, reject) => {
    child.stdout.once('data', (d: Buffer) => resolve(d.toString().trim()));
    child.once('exit', () => reject(new Error('serve exited early')));
  });
}

test('serve refuses a non-loopback ops host without a metrics token', async () => {
  const port = String(await freePort());
  await expect(run('node', ['bin/tokenyard.mjs', 'serve', '--port', '0', '--dev-upstream', 'http://127.0.0.1:9', '--metrics-host', '0.0.0.0', '--metrics-port', port])).rejects.toMatchObject({
    stderr: expect.stringContaining('TOKENYARD_METRICS_TOKEN or --metrics-token-file'),
  });
});

test('serve: /metrics is 404 on the API port and served on the loopback ops port', async () => {
  const port = await freePort();
  const api = await serve(['--metrics-port', String(port)]);
  expect((await fetch(`${api}/metrics`)).status).toBe(404);
  const m = await fetch(`http://127.0.0.1:${port}/metrics`);
  expect(m.status).toBe(200);
  expect(await m.text()).toContain('tokenyard_policy_revision_info');
});

test('serve with a non-loopback ops host and a token: 401 without it, 200 with it', async () => {
  const port = await freePort();
  await serve(['--metrics-host', '0.0.0.0', '--metrics-port', String(port)], { TOKENYARD_METRICS_TOKEN: 'tok' });
  expect((await fetch(`http://127.0.0.1:${port}/metrics`)).status).toBe(401);
  expect((await fetch(`http://127.0.0.1:${port}/metrics`, { headers: { authorization: 'Bearer tok' } })).status).toBe(200);
});

test('--no-metrics and --metrics-port 0 start no ops listener', async () => {
  const api = await serve(['--no-metrics']);
  expect((await fetch(`${api}/healthz`)).status).toBe(200);
  const api2 = await serve(['--metrics-port', '0']);
  expect((await fetch(`${api2}/metrics`)).status).toBe(404);
});
