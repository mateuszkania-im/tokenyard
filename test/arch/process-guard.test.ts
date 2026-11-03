// The test process guard (test/setup): node children get the listen guard preloaded, a wildcard listener is recorded,
// and the final check reports recorded leaks, wildcard listeners and children still alive.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { leftovers } from '../setup/global-guard.js';

const dirs: string[] = [];
const tempDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'ty-guard-test-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const listenAndExit = (host: string, dir: string): void => {
  const r = spawnSync(process.execPath, ['-e', `const s=require('node:net').createServer().listen(0,${JSON.stringify(host)},()=>s.close())`], { env: { ...process.env, TOKENYARD_TEST_GUARD_DIR: dir } });
  expect(r.status).toBe(0);
};

test('a node child listening on every interface is recorded; a loopback listener is not', () => {
  const dir = tempDir();
  listenAndExit('127.0.0.1', dir);
  expect(readdirSync(dir)).toEqual([]);
  listenAndExit('0.0.0.0', dir);
  expect(readdirSync(dir).filter((f) => f.startsWith('wildcard-'))).toHaveLength(1);
  expect(leftovers(dir)).toEqual([expect.stringMatching(/^child listener bound to every interface: 0\.0\.0\.0:\d+ /)]);
});

test('the final check reports leaks and children still alive, and kills them', async () => {
  const dir = tempDir();
  writeFileSync(join(dir, 'leaks.txt'), 'test/x.test.ts: pid 1: node serve\n');
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  await new Promise((r) => child.once('spawn', r));
  writeFileSync(join(dir, 'spawned-1.txt'), `${child.pid}\t${process.execPath} -e setInterval(() => {}, 1000)\n`);
  const exited = new Promise((r) => child.once('exit', r));
  expect(leftovers(dir)).toEqual(['test/x.test.ts: pid 1: node serve', `child still alive at the end of the run: pid ${child.pid}: ${process.execPath} -e setInterval(() => {}, 1000)`]);
  await exited;
  expect(leftovers(join(dir))).toEqual(['test/x.test.ts: pid 1: node serve']);
});
