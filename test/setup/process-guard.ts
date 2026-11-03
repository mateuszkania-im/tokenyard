// Vitest setup file (every test file): child processes and wildcard listeners started by tests are tracked.
// - spawn, fork, execFile and exec are wrapped; a child still running when its test file ends is a leak: it is killed
//   (SIGKILL) and the file fails. A child a test already signalled gets 5 s to exit first.
// - node children get test/setup/child-listen-guard.mjs preloaded (NODE_OPTIONS), which records any listener bound
//   to 0.0.0.0 or ::; in-process servers are checked the same way here. The global teardown (global-guard.ts) fails
//   the run on any record, and on any recorded child that is still alive.
import type { ChildProcess } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { Server } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, inject } from 'vitest';

declare module 'vitest' {
  export interface ProvidedContext {
    processGuardDir: string;
  }
}

interface Tracked {
  child: ChildProcess;
  cmd: string;
}
interface GuardState {
  dir: string;
  children: Tracked[];
  wildcard: string[];
}

const KEY = Symbol.for('tokenyard.test.processGuard');
const PRELOAD = pathToFileURL(join(import.meta.dirname, 'child-listen-guard.mjs')).href;
const G = globalThis as typeof globalThis & { [KEY]?: GuardState };

const isNode = (cmd: unknown): boolean => typeof cmd === 'string' && (cmd === process.execPath || /(^|[\\/])node(\.exe)?$/i.test(cmd));
const isWildcard = (address: string): boolean => address === '0.0.0.0' || address === '::';
const alive = (c: ChildProcess): boolean => c.pid !== undefined && c.exitCode === null && c.signalCode === null;

/** Index of the options object in (command, [args], [options], [callback]) argument lists, or -1. */
function optionsIndex(a: unknown[]): number {
  const i = Array.isArray(a[1]) ? 2 : 1;
  const o = a[i];
  return o !== null && typeof o === 'object' && !Array.isArray(o) ? i : -1;
}

/** The arguments with the listen guard preloaded into a node child's environment (shell commands are left alone). */
function withGuardEnv(a: unknown[], dir: string, node: boolean): unknown[] {
  if (!node) return a;
  const out = [...a];
  let i = optionsIndex(out);
  if (i === -1) {
    i = Array.isArray(out[1]) ? 2 : 1;
    // a callback (execFile) stays last
    if (typeof out[i] === 'function') out.splice(i, 0, {});
    else out[i] = {};
  }
  const opts = { ...(out[i] as { env?: NodeJS.ProcessEnv; shell?: unknown }) };
  if (opts.shell) return a;
  const env = { ...(opts.env ?? process.env) };
  env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ''} --import=${PRELOAD}`.trim();
  // a test of the guard itself points its child at its own directory
  env.TOKENYARD_TEST_GUARD_DIR ??= dir;
  out[i] = { ...opts, env };
  return out;
}

function install(dir: string): GuardState {
  const st: GuardState = { dir, children: [], wildcard: [] };
  G[KEY] = st;
  const cp = createRequire(import.meta.url)('node:child_process') as typeof import('node:child_process');
  const record = (child: ChildProcess, cmd: string): void => {
    const s = G[KEY] as GuardState;
    s.children.push({ child, cmd });
    if (child.pid !== undefined) appendFileSync(join(s.dir, `spawned-${process.pid}.txt`), `${child.pid}\t${cmd}\n`);
  };
  const describe = (a: unknown[]): string => [a[0], ...(Array.isArray(a[1]) ? a[1] : [])].map(String).join(' ').slice(0, 300);
  type Fn = (...a: unknown[]) => unknown;
  const wrapAsync = (name: 'spawn' | 'execFile' | 'fork' | 'exec'): void => {
    const orig = cp[name] as unknown as Fn & { [promisify.custom]?: Fn };
    const node = (a: unknown[]): boolean => name === 'fork' || (name !== 'exec' && isNode(a[0]));
    const wrapped = function (this: unknown, ...a: unknown[]): unknown {
      const child = orig.apply(this, withGuardEnv(a, (G[KEY] as GuardState).dir, node(a))) as ChildProcess;
      record(child, describe(a));
      return child;
    } as Fn & { [promisify.custom]?: Fn };
    const custom = orig[promisify.custom];
    if (custom) {
      wrapped[promisify.custom] = (...a: unknown[]): unknown => {
        const p = custom(...withGuardEnv(a, (G[KEY] as GuardState).dir, node(a))) as Promise<unknown> & { child: ChildProcess };
        record(p.child, describe(a));
        return p;
      };
    }
    (cp as unknown as Record<string, unknown>)[name] = wrapped;
  };
  const wrapSync = (name: 'spawnSync' | 'execFileSync'): void => {
    const orig = cp[name] as unknown as Fn;
    (cp as unknown as Record<string, unknown>)[name] = function (this: unknown, ...a: unknown[]): unknown {
      return orig.apply(this, withGuardEnv(a, (G[KEY] as GuardState).dir, isNode(a[0])));
    };
  };
  for (const n of ['spawn', 'execFile', 'fork', 'exec'] as const) wrapAsync(n);
  for (const n of ['spawnSync', 'execFileSync'] as const) wrapSync(n);
  syncBuiltinESMExports();

  const listen = Server.prototype.listen;
  Server.prototype.listen = function guardedListen(this: Server, ...args: unknown[]) {
    this.once('listening', () => {
      const a = this.address();
      if (a && typeof a === 'object' && isWildcard(a.address)) (G[KEY] as GuardState).wildcard.push(`${a.address}:${a.port}`);
    });
    return (listen as (...x: unknown[]) => Server).apply(this, args);
  } as typeof listen;
  return st;
}

const state = G[KEY] ?? install(inject('processGuardDir'));

const exited = (c: ChildProcess, ms: number): Promise<boolean> =>
  new Promise((resolve) => {
    if (!alive(c)) return resolve(true);
    const t = setTimeout(() => resolve(!alive(c)), ms);
    c.once('exit', () => {
      clearTimeout(t);
      resolve(true);
    });
  });

afterAll(async () => {
  const leaks: string[] = [];
  for (const { child, cmd } of state.children.splice(0)) {
    if (!alive(child)) continue;
    if (child.killed && (await exited(child, 5_000))) continue;
    leaks.push(`pid ${child.pid}: ${cmd}`);
    child.kill('SIGKILL');
  }
  const wildcard = state.wildcard.splice(0);
  const file = (globalThis as { __vitest_worker__?: { filepath?: string } }).__vitest_worker__?.filepath ?? 'unknown file';
  if (leaks.length > 0) appendFileSync(join(state.dir, 'leaks.txt'), leaks.map((l) => `${file}: ${l}\n`).join(''));
  if (wildcard.length > 0) appendFileSync(join(state.dir, 'leaks.txt'), wildcard.map((w) => `${file}: in-process listener on ${w}\n`).join(''));
  const problems = [...leaks.map((l) => `child still running after the file (killed): ${l}`), ...wildcard.map((w) => `listener bound to every interface: ${w}`)];
  if (problems.length > 0) throw new Error(`process guard: ${problems.join('; ')}`);
});
