// The `serve --workers` supervisor's decisions in-process, with fake workers (src/edge/cluster.ts): which worker gets
// which instance id, when the URL is announced, replacement after a crash, startup failure, crash loop, the drain and
// a second signal, and the exit code. The real node:cluster path runs in test/edge/cluster.test.ts.
import { EventEmitter } from 'node:events';
import { afterEach, expect, test, vi } from 'vitest';
import { MAX_RESTARTS, onPrimaryCommand, superviseWorkers, WORKER_INSTANCE_ENV, WORKER_SLOT_ENV, workerContext, type SupervisedWorker, type WorkerReady } from '../../src/edge/cluster.js';

class FakeWorker extends EventEmitter {
  sent: unknown[] = [];
  connected = true;
  killed: string[] = [];
  constructor(
    readonly env: Record<string, string>,
    readonly process = { pid: 1000 + Math.floor(Math.random() * 1000), kill: (s?: NodeJS.Signals) => void this.killed.push(s ?? 'SIGTERM') },
  ) {
    super();
  }
  send(m: unknown): boolean {
    this.sent.push(m);
    return true;
  }
  isConnected(): boolean {
    return this.connected;
  }
  ready(url = 'http://127.0.0.1:4100', ops: string | null = null): void {
    this.emit('message', { tokenyard: 'ready', url, ops });
  }
  exit(code: number | null, signal: string | null = null): void {
    this.connected = false;
    this.emit('exit', code, signal);
  }
}

function start(n: number, graceMs = 1000) {
  const workers: FakeWorker[] = [];
  const logs: string[] = [];
  const ready: WorkerReady[][] = [];
  const exits: number[] = [];
  let signal: () => void = () => undefined;
  superviseWorkers({
    n,
    baseInstance: 'base0001',
    graceMs,
    log: (s) => logs.push(s),
    onReady: (r) => ready.push(r),
    fork: (env) => {
      const w = new FakeWorker(env);
      workers.push(w);
      return w as unknown as SupervisedWorker;
    },
    onSignal: (h) => (signal = h),
    exit: (c) => exits.push(c),
  });
  return { workers, logs, ready, exits, signal: () => signal() };
}

afterEach(() => vi.useRealTimers());

test('every slot gets a fork with its slot and a new instance id; the URL is announced once, after every worker is ready', () => {
  const s = start(3);
  expect(s.workers.map((w) => [w.env[WORKER_SLOT_ENV], w.env[WORKER_INSTANCE_ENV]])).toEqual([
    ['1', 'base0001-w1'],
    ['2', 'base0001-w2'],
    ['3', 'base0001-w3'],
  ]);
  s.workers[0]?.ready('http://127.0.0.1:4100', 'http://127.0.0.1:9464');
  s.workers[1]?.emit('message', { tokenyard: 'other' }); // not a ready message: ignored
  s.workers[1]?.ready('http://127.0.0.1:4100', 'http://127.0.0.1:9465');
  expect(s.ready).toEqual([]);
  s.workers[2]?.ready('http://127.0.0.1:4100', 'http://127.0.0.1:9466');
  expect(s.ready).toHaveLength(1);
  expect(s.ready[0]?.map((r) => r.ops)).toEqual(['http://127.0.0.1:9464', 'http://127.0.0.1:9465', 'http://127.0.0.1:9466']);
  expect(s.logs).toContain('tokenyard: 3 workers ready on http://127.0.0.1:4100 (instances base0001-w1, base0001-w2, base0001-w3)');
});

test('a ready worker that exits is replaced in its slot with the next instance id, and the URL is not announced again', () => {
  const s = start(2);
  for (const w of s.workers) w.ready();
  s.workers[0]?.exit(null, 'SIGKILL');
  expect(s.workers).toHaveLength(3);
  expect(s.workers[2]?.env).toMatchObject({ [WORKER_SLOT_ENV]: '1', [WORKER_INSTANCE_ENV]: 'base0001-w3' });
  expect(s.logs.at(-1)).toMatch(/^tokenyard: worker 1 \(pid \d+, instance base0001-w1\) exited on signal SIGKILL, starting a replacement$/);
  s.workers[2]?.ready();
  expect(s.logs.at(-1)).toBe('tokenyard: worker 1 replaced (instance base0001-w3)');
  expect(s.ready).toHaveLength(1);
  expect(s.exits).toEqual([]);
});

test(`more than ${MAX_RESTARTS} crashes within a minute stop every worker and exit 1; crashes older than a minute do not count`, () => {
  vi.useFakeTimers({ now: 0 });
  const s = start(2);
  for (const w of s.workers) w.ready();
  const crash = (): void => {
    const live = s.workers.filter((w) => w.connected && w.env[WORKER_SLOT_ENV] === '1').at(-1) as FakeWorker;
    live.exit(1);
    s.workers.at(-1)?.ready();
  };
  crash();
  vi.setSystemTime(61_000); // the first crash leaves the window
  for (let i = 0; i < MAX_RESTARTS; i++) crash();
  expect(s.exits).toEqual([]);
  crash();
  expect(s.logs.at(-1)).toContain(`workers crashed ${MAX_RESTARTS + 1} times within 60 s, stopping`);
  const left = s.workers.filter((w) => w.connected);
  for (const w of left) expect(w.sent).toContainEqual({ tokenyard: 'drain' });
  for (const w of left) w.exit(0);
  expect(s.exits).toEqual([1]);
});

test('a worker that exits before it is ready stops the others; one still starting gets the drain when it is ready', () => {
  const s = start(3);
  s.workers[0]?.ready();
  s.workers[1]?.exit(1);
  expect(s.logs.at(-1)).toMatch(/worker 2 \(pid \d+, instance base0001-w2\) exited with code 1 before it was ready; stopping/);
  expect(s.workers).toHaveLength(3); // no replacement
  expect(s.workers[0]?.sent).toEqual([{ tokenyard: 'drain' }]);
  expect(s.workers[2]?.sent).toEqual([]); // still starting: no command handler yet
  s.workers[2]?.ready();
  expect(s.workers[2]?.sent).toEqual([{ tokenyard: 'drain' }]);
  expect(s.ready).toEqual([]); // never announced
  s.workers[0]?.exit(0);
  expect(s.exits).toEqual([]);
  s.workers[2]?.exit(0);
  expect(s.exits).toEqual([1]);
});

test('the first signal drains every worker and exits 0 once all exited 0; a second signal stops them at once', () => {
  const s = start(2, 5000);
  for (const w of s.workers) w.ready();
  s.signal();
  expect(s.logs.at(-1)).toBe('tokenyard: draining 2 workers, up to 5000 ms for requests in flight (signal again to stop at once)');
  for (const w of s.workers) expect(w.sent).toEqual([{ tokenyard: 'drain' }]);
  s.signal();
  expect(s.logs.at(-1)).toBe('tokenyard: second signal, closing every connection now');
  for (const w of s.workers) expect(w.sent.at(-1)).toEqual({ tokenyard: 'now' });
  s.workers[0]?.exit(0);
  expect(s.workers).toHaveLength(2); // no replacement while stopping
  s.workers[1]?.exit(0);
  expect(s.exits).toEqual([0]);
});

test('a worker that exits non-zero during the drain makes the exit 1; workers left past the grace and slack are killed', () => {
  vi.useFakeTimers();
  const s = start(2, 100);
  for (const w of s.workers) w.ready();
  s.signal();
  s.workers[0]?.exit(2);
  vi.advanceTimersByTime(100 + 20_000);
  expect(s.workers[1]?.killed).toEqual(['SIGKILL']);
  expect(s.logs.at(-1)).toContain('killed');
  s.workers[1]?.exit(null, 'SIGKILL');
  expect(s.exits).toEqual([1]);
});

test('workerContext is null outside a cluster worker; onPrimaryCommand maps drain and now', () => {
  expect(workerContext()).toBeNull();
  const drain = vi.fn();
  const now = vi.fn();
  onPrimaryCommand({ drain, now });
  process.emit('message', { tokenyard: 'drain' }, undefined);
  process.emit('message', { tokenyard: 'now' }, undefined);
  expect(drain).toHaveBeenCalledTimes(1);
  expect(now).toHaveBeenCalledTimes(1);
});
