// B5 (security review B): the trace salt, the metrics bearer token, a Redis URL with its password and the export salt
// were accepted as command-line flags, which every local user reads with `ps` (and shells keep in history). They now come
// from the environment or from a --*-file <path>; the old flags refuse to start and name both forms.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';

const BIN = join(import.meta.dirname, '..', '..', 'bin', 'tokenyard.mjs');
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ty-b5-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const cleanEnv = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  for (const k of ['TOKENYARD_METRICS_TOKEN', 'TOKENYARD_TRACE_SALT', 'TOKENYARD_REDIS_URL', 'TOKENYARD_EXPORT_SALT']) delete env[k];
  return env;
};
const serve = (args: string[]) => spawnSync(process.execPath, [BIN, 'serve', '--dev-upstream', 'http://127.0.0.1:9', '--port', '0', '--metrics-port', '0', '--state-dir', join(dir, 'state'), ...args], { env: cleanEnv(), encoding: 'utf8', timeout: 15_000 });

test('B5 serve refuses --trace-salt, --metrics-token and a --redis-url with a password, naming the env and file forms', () => {
  const cases: Array<[string[], RegExp]> = [
    [['--trace-salt', 'CANARY-salt'], /TOKENYARD_TRACE_SALT.*--trace-salt-file/],
    [['--metrics-token', 'CANARY-token'], /TOKENYARD_METRICS_TOKEN.*--metrics-token-file/],
    [['--store', 'redis', '--redis-url', 'redis://:CANARY-pw@127.0.0.1:6379'], /TOKENYARD_REDIS_URL.*--redis-url-file/],
  ];
  for (const [args, message] of cases) {
    const r = serve(args);
    expect(r.status, args.join(' ')).toBe(1);
    expect(r.stderr, args.join(' ')).toMatch(message);
    expect(r.stderr).not.toContain('CANARY');
  }
});

test('B5 traces export refuses --salt, naming TOKENYARD_EXPORT_SALT and --salt-file', () => {
  const r = spawnSync(process.execPath, [BIN, 'traces', 'export', '--trace-dir', join(dir, 't'), '--out', join(dir, 'o.ndjson'), '--anonymize', '--salt', 'CANARY-salt'], { env: cleanEnv(), encoding: 'utf8' });
  expect(r.status).toBe(1);
  expect(r.stderr).toMatch(/TOKENYARD_EXPORT_SALT.*--salt-file/);
});

test.skipIf(process.platform === 'win32')('B5 secrets given through --*-file never appear in ps', async () => {
  const token = `CANARY-metrics-${randomBytes(8).toString('hex')}`;
  const salt = `CANARY-salt-${randomBytes(8).toString('hex')}`;
  writeFileSync(join(dir, 'token'), `${token}\n`, { mode: 0o600 });
  writeFileSync(join(dir, 'salt'), salt, { mode: 0o600 });
  const child = spawn(process.execPath, [BIN, 'serve', '--dev-upstream', 'http://127.0.0.1:9', '--port', '0', '--metrics-port', '0', '--state-dir', join(dir, 'state'), '--metrics-token-file', join(dir, 'token'), '--trace-salt-file', join(dir, 'salt'), '--trace-dir', join(dir, 'traces')], { env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('gateway did not start')), 15_000);
      child.stdout.on('data', (c: Buffer) => {
        if (c.toString().includes('http://')) {
          clearTimeout(t);
          resolve();
        }
      });
      let err = '';
      child.stderr.on('data', (c: Buffer) => (err += c.toString()));
      child.on('exit', (code) => reject(new Error(`exited ${code}: ${err}`)));
    });
    const args = execFileSync('ps', ['-o', 'args=', '-p', String(child.pid)], { encoding: 'utf8' });
    expect(args).not.toContain('CANARY');
  } finally {
    child.kill('SIGKILL');
  }
});
