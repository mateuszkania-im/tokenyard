// The test process guard (test/setup): node children get the listen guard preloaded, a wildcard listener is recorded,
// and the final check reports recorded leaks, wildcard listeners and children still alive.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, inject, test } from 'vitest';
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

// The report line for a recorded child still alive: on Windows the check reports without killing (see below).
const aliveLine = (pid: number | undefined, cmd: string): string =>
  process.platform === 'win32' ? `child still alive at the end of the run (not killed on Windows): pid ${pid}: ${cmd}` : `child still alive at the end of the run: pid ${pid}: ${cmd}`;

// On POSIX the check kills the child itself (the exit awaited below proves it); on Windows it never kills, so the
// test does, after the report, and the second check proves an exited child is no longer reported.
test('the final check reports leaks and children still alive, and kills them (POSIX)', async () => {
  const dir = tempDir();
  writeFileSync(join(dir, 'leaks.txt'), 'test/x.test.ts: pid 1: node serve\n');
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  await new Promise((r) => child.once('spawn', r));
  writeFileSync(join(dir, 'spawned-1.txt'), `${child.pid}\t${process.execPath} -e setInterval(() => {}, 1000)\n`);
  const exited = new Promise((r) => child.once('exit', r));
  expect(leftovers(dir)).toEqual(['test/x.test.ts: pid 1: node serve', aliveLine(child.pid, `${process.execPath} -e setInterval(() => {}, 1000)`)]);
  if (process.platform === 'win32') child.kill('SIGKILL');
  await exited;
  expect(leftovers(join(dir))).toEqual(['test/x.test.ts: pid 1: node serve']);
});

// A pid the worker saw exit can be reused by an unrelated process before the final check (V5 review): neither reported
// nor killed. A pid recorded twice and seen exiting once is still checked (the second child).
test('a recorded child that exited is not checked again, so a process that reused its pid is left alone', async () => {
  const dir = tempDir();
  const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  await new Promise((r) => other.once('spawn', r));
  try {
    const cmd = `${process.execPath} -e setInterval(() => {}, 1000)`;
    writeFileSync(join(dir, 'spawned-1.txt'), `${other.pid}\t${cmd}\n`);
    writeFileSync(join(dir, 'exited-1.txt'), `${other.pid}\n`);
    expect(leftovers(dir)).toEqual([]);
    expect(other.exitCode).toBe(null);
    expect(other.signalCode).toBe(null);
    writeFileSync(join(dir, 'spawned-1.txt'), `${other.pid}\t${cmd}\n${other.pid}\t${cmd}\n`);
    expect(leftovers(dir, { kill: false })).toEqual([aliveLine(other.pid, cmd)]);
  } finally {
    other.kill('SIGKILL');
  }
});

// On Windows `kill(pid, 0)` proves only that some process has the pid: the image name has to match the recorded
// command, and the check reports without killing (an image match is not proof the process is ours).
test('on win32 an unexited pid is reported only when its image matches the recorded command, and never killed', async () => {
  const dir = tempDir();
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  await new Promise((r) => child.once('spawn', r));
  try {
    const cmd = 'C:\\Program Files\\nodejs\\node.exe -e setInterval(() => {}, 1000)';
    writeFileSync(join(dir, 'spawned-1.txt'), `${child.pid}\t${cmd}\n`);
    expect(leftovers(dir, { platform: 'win32', imageOf: () => 'svchost.exe' })).toEqual([]);
    expect(leftovers(dir, { platform: 'win32', imageOf: () => 'node.exe' })).toEqual([`child still alive at the end of the run (not killed on Windows): pid ${child.pid}: ${cmd}`]);
    expect(leftovers(dir, { platform: 'win32', imageOf: () => null })).toEqual([]);
    await new Promise((r) => setTimeout(r, 100));
    expect(child.exitCode).toBe(null);
    expect(child.signalCode).toBe(null);
  } finally {
    child.kill('SIGKILL');
  }
});

test('the worker records each tracked child that exits, by pid', async () => {
  const child = spawn(process.execPath, ['-e', '']);
  await new Promise((r) => child.once('exit', r));
  await new Promise((r) => setImmediate(r));
  const file = join(inject('processGuardDir'), `exited-${process.pid}.txt`);
  expect(existsSync(file)).toBe(true);
  expect(readFileSync(file, 'utf8').split('\n')).toContain(String(child.pid));
});
