// `serve --workers <n>` (src/edge/cluster.ts): option parsing, instance ids, and the supervisor itself, run with a
// minimal worker (test/fixtures/cluster/supervised.ts) so port sharing, restarts and startup failures are covered on
// every platform, Redis or not. The gateway under the supervisor is covered in test/cli/serve-workers.test.ts.
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { request } from 'node:http';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { MAX_RESTARTS, parseWorkers, workerInstanceId } from '../../src/edge/cluster.js';

// SIGTERM to the primary is a POSIX signal; on Windows child.kill('SIGTERM') is TerminateProcess and no handler runs
// (test/cli/serve-shutdown.test.ts). Killing a worker with SIGKILL works on both.
const signals = process.platform !== 'win32';
const FIXTURE = join(import.meta.dirname, '..', 'fixtures', 'cluster', 'supervised.ts');
const kids: ChildProcessWithoutNullStreams[] = [];
afterEach(() => {
  for (const k of kids.splice(0)) k.kill('SIGKILL');
});

test('parseWorkers takes a whole number from 1 to the CPU count and refuses anything else', () => {
  expect(parseWorkers('1', 8)).toBe(1);
  expect(parseWorkers('8', 8)).toBe(8);
  for (const bad of ['0', '-1', '1.5', 'abc', '', ' 2', '2e0', '0x2', '9']) {
    const r = parseWorkers(bad, 8);
    expect(typeof r, bad).toBe('string');
    expect(r).toContain('--workers must be a whole number from 1 to 8');
  }
});

test('every fork gets its own instance id, also a replacement in the same slot', () => {
  const ids = [1, 2, 3, 4].map((k) => workerInstanceId('a1b2c3d4', k));
  expect(new Set(ids).size).toBe(4);
  expect(ids[0]).toBe('a1b2c3d4-w1');
  // the trace file name pattern <HH>.<instance>.ndjson must still parse back to the instance
  expect(/^(\d{2})\.(.+)\.ndjson(\.gz)?$/.exec(`10.${ids[2]}.ndjson`)?.[2]).toBe(ids[2]);
});

interface Supervised {
  child: ChildProcessWithoutNullStreams;
  url: Promise<string>;
  stderr: () => string;
  exited: Promise<number | null>;
}

function supervise(args: string[], env: NodeJS.ProcessEnv = {}): Supervised {
  const child = spawn(process.execPath, ['--import', 'tsx', FIXTURE, ...args], { env: { ...process.env, ...env } });
  kids.push(child);
  let err = '';
  child.stderr.on('data', (d: Buffer) => (err += d.toString()));
  const exited = new Promise<number | null>((r) => child.once('exit', (code) => r(code)));
  const url = new Promise<string>((resolve, reject) => {
    child.stdout.once('data', (d: Buffer) => resolve(d.toString().trim()));
    void exited.then((c) => reject(new Error(`supervisor exited early (${c}): ${err}`)));
  });
  url.catch(() => undefined);
  return { child, url, stderr: () => err, exited };
}

/** One request on its own connection (no keep-alive), so the primary hands each one to a worker in turn. */
function who(url: string, path = '/'): Promise<{ pid: number; instance: string; slot: number }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = request({ host: u.hostname, port: u.port, path, agent: false, headers: { connection: 'close' } }, (res) => {
      let t = '';
      res.on('data', (c: Buffer) => (t += c.toString()));
      res.on('end', () => resolve(JSON.parse(t) as { pid: number; instance: string; slot: number }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('two workers share one port; connections are spread over both, each with its own instance id', async () => {
  const s = supervise(['2']);
  const url = await s.url;
  const seen = await Promise.all(Array.from({ length: 20 }, () => who(url)));
  expect(new Set(seen.map((x) => x.pid)).size).toBe(2);
  expect(new Set(seen.map((x) => x.instance))).toEqual(new Set(['fixture0-w1', 'fixture0-w2']));
  expect(s.stderr()).toContain('tokenyard: 2 workers ready');
}, 30_000);

test('a worker that crashes is logged and replaced in its slot with a new instance id; the port keeps answering', async () => {
  const s = supervise(['2']);
  const url = await s.url;
  const before = await Promise.all(Array.from({ length: 10 }, () => who(url)));
  const victim = before.find((x) => x.slot === 1);
  expect(victim).toBeDefined();
  process.kill(victim!.pid, 'SIGKILL');
  await expect.poll(() => s.stderr(), { timeout: 15_000 }).toMatch(/worker 1 \(pid \d+, instance fixture0-w1\) exited .*starting a replacement/);
  await expect.poll(() => s.stderr(), { timeout: 15_000 }).toContain('tokenyard: worker 1 replaced (instance fixture0-w3)');
  const after = await Promise.all(Array.from({ length: 10 }, () => who(url)));
  expect(after.some((x) => x.pid === victim!.pid)).toBe(false);
  expect(new Set(after.map((x) => x.instance))).toEqual(new Set(['fixture0-w2', 'fixture0-w3']));
}, 30_000);

test(`after ${MAX_RESTARTS} crashes within a minute the supervisor gives up and exits 1`, async () => {
  const s = supervise(['2']);
  const url = await s.url;
  // Slot 1 is killed again and again while slot 2 keeps the shared port open.
  for (let i = 0; i <= MAX_RESTARTS; i++) {
    let w = await who(url);
    while (w.slot !== 1) w = await who(url);
    process.kill(w.pid, 'SIGKILL');
    if (i < MAX_RESTARTS) await expect.poll(() => s.stderr().split(' replaced (').length - 1, { timeout: 15_000 }).toBe(i + 1);
  }
  expect(await s.exited).toBe(1);
  expect(s.stderr()).toContain(`crashed ${MAX_RESTARTS + 1} times within 60 s, stopping`);
}, 60_000);

test('a worker that exits before it is ready stops the supervisor with exit 1 (no restart loop)', async () => {
  const s = supervise(['2'], { FIXTURE_FAIL_START: '1' });
  expect(await s.exited).toBe(1);
  expect(s.stderr()).toMatch(/worker \d \(pid \d+, instance fixture0-w\d\) exited with code 3 before it was ready/);
  expect(s.stderr()).not.toContain('starting a replacement');
}, 30_000);

test.runIf(signals)('SIGTERM to the primary drains every worker, lets a request in flight finish, and exits 0', async () => {
  const s = supervise(['2', '10000'], { FIXTURE_HOLD_MS: '800' });
  const url = await s.url;
  const slow = who(url, '/slow');
  await new Promise((r) => setTimeout(r, 200));
  s.child.kill('SIGTERM');
  await expect.poll(() => s.stderr()).toContain('tokenyard: draining 2 workers, up to 10000 ms');
  expect((await slow).pid).toBeGreaterThan(0);
  expect(await s.exited).toBe(0);
  expect(s.stderr()).not.toContain('starting a replacement');
}, 30_000);
