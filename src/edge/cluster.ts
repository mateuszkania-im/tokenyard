// `serve --workers <n>`: one primary process forks n workers with node:cluster; the workers share the API port and
// each runs a whole gateway (its own policy loader, trace writer, sweeper and ops listener) on the shared Redis store.
// The primary serves no traffic itself: it hands connections to the workers in turn (round robin on every platform),
// restarts a worker that crashes, and on SIGTERM or SIGINT asks every worker to drain (an IPC message, so the drain
// works the same on Windows, where processes get no POSIX signals from each other).
import cluster, { type Worker } from 'node:cluster';

/** Environment of a forked worker: its slot (1..n, kept by a replacement) and its instance id. */
export const WORKER_SLOT_ENV = 'TOKENYARD_WORKER_SLOT';
export const WORKER_INSTANCE_ENV = 'TOKENYARD_WORKER_INSTANCE';

/** Unexpected worker exits allowed within RESTART_WINDOW_MS; one more and the primary stops with exit 1. */
export const MAX_RESTARTS = 5;
const RESTART_WINDOW_MS = 60_000;
/**
 * How long past --shutdown-grace-ms the primary waits for the workers to exit after a drain: a worker waits up to 10 s
 * for its requests to settle after the grace (src/edge/server.ts) and then flushes its traces and closes the store.
 */
const EXIT_SLACK_MS = 20_000;

/** `--workers`: a whole number from 1 to `max` (the CPU count); an error message otherwise. */
export function parseWorkers(value: string, max: number): number | string {
  const n = /^[1-9]\d*$/.test(value) ? Number(value) : Number.NaN;
  if (Number.isSafeInteger(n) && n >= 1 && n <= max) return n;
  return `--workers must be a whole number from 1 to ${max} (the CPU count)`;
}

/** The instance id of the k-th worker forked (1-based, replacements included), so no two processes share one. */
export const workerInstanceId = (base: string, fork: number): string => `${base}-w${fork}`;

export interface WorkerReady {
  url: string;
  /** The worker's ops listener, or null without one. */
  ops: string | null;
}

type ToPrimary = { tokenyard: 'ready' } & WorkerReady;
type ToWorker = { tokenyard: 'drain' } | { tokenyard: 'now' };

/** In a worker forked by superviseWorkers: its slot and instance id; null in any other process. */
export function workerContext(): { slot: number; instance: string } | null {
  const slot = Number(process.env[WORKER_SLOT_ENV]);
  const instance = process.env[WORKER_INSTANCE_ENV];
  if (!cluster.isWorker || !Number.isInteger(slot) || slot < 1 || !instance) return null;
  return { slot, instance };
}

/** Worker side: tells the primary this worker listens (sent once, after every listener is up). */
export function notifyReady(r: WorkerReady): void {
  const m: ToPrimary = { tokenyard: 'ready', ...r };
  process.send?.(m);
}

/** Worker side: the primary's drain request (its first signal) and its stop-now request (a second signal). */
export function onPrimaryCommand(h: { drain(): void; now(): void }): void {
  process.on('message', (m: unknown) => {
    const t = (m as Partial<ToWorker> | null)?.tokenyard;
    if (t === 'drain') h.drain();
    else if (t === 'now') h.now();
  });
}

interface Slot {
  slot: number;
  worker: Worker;
  instance: string;
  ready: boolean;
}

/**
 * Primary side. Forks `n` workers and prints nothing on stdout itself: `onReady` runs once, when every first worker
 * listens. A worker that exits unexpectedly after it was ready is logged and replaced in its slot by a new process
 * with a new instance id (its open reservations are settled by the Redis sweeper, as for any instance that died);
 * a worker that exits before it was ready (bad policy, Redis unreachable, port taken) stops every worker and exits 1,
 * as does a crash loop (more than MAX_RESTARTS unexpected exits within a minute). The primary owns the listening
 * socket while any worker listens on it; with `--port 0`, if every worker died at once, a replacement would get a new
 * port (a fixed --port does not move). On the first SIGTERM or SIGINT every worker drains for up to `graceMs`; a
 * second signal closes their connections at once. A worker still starting gets the drain once it is ready, and any
 * worker left EXIT_SLACK_MS past the grace is killed. The primary exits 0 when every worker exited 0, 1 otherwise.
 */
export function superviseWorkers(o: { n: number; baseInstance: string; graceMs: number; log(s: string): void; onReady(ready: WorkerReady[]): void }): void {
  // Round robin everywhere: Windows defaults to letting the OS pick a worker, which spreads connections unevenly.
  cluster.schedulingPolicy = cluster.SCHED_RR;
  const slots = new Map<number, Slot>();
  const firstReady: Array<WorkerReady | undefined> = Array.from({ length: o.n });
  let announced = false;
  let forks = 0;
  let stopping = false;
  let failed = false;
  const crashes: number[] = [];

  const finish = (): void => {
    if (slots.size > 0) return;
    process.exit(failed ? 1 : 0);
  };
  const send = (w: Worker, m: ToWorker): void => {
    if (w.isConnected()) w.send(m);
  };
  const stopAll = (code: 0 | 1): void => {
    if (code === 1) failed = true;
    if (stopping) return;
    stopping = true;
    for (const s of slots.values()) send(s.worker, { tokenyard: 'drain' });
    setTimeout(() => {
      for (const s of slots.values()) s.worker.process.kill('SIGKILL');
      failed = true;
      o.log(`tokenyard: workers still running ${o.graceMs + EXIT_SLACK_MS} ms after the drain began; killed`);
    }, o.graceMs + EXIT_SLACK_MS).unref();
    finish();
  };

  const fork = (slot: number): void => {
    const instance = workerInstanceId(o.baseInstance, ++forks);
    const worker = cluster.fork({ [WORKER_SLOT_ENV]: String(slot), [WORKER_INSTANCE_ENV]: instance });
    const s: Slot = { slot, worker, instance, ready: false };
    slots.set(slot, s);
    worker.on('message', (m: unknown) => {
      const r = m as Partial<ToPrimary> | null;
      if (r?.tokenyard !== 'ready' || typeof r.url !== 'string') return;
      const replacement = s.ready === false && firstReady[slot - 1] !== undefined;
      s.ready = true;
      if (replacement) o.log(`tokenyard: worker ${slot} replaced (instance ${instance})`);
      firstReady[slot - 1] ??= { url: r.url, ops: r.ops ?? null };
      // A drain that began while this worker was starting: it never got the request, so it gets it now.
      if (stopping) send(worker, { tokenyard: 'drain' });
      if (!announced && firstReady.every((x) => x !== undefined)) {
        announced = true;
        const ids = [...slots.values()].sort((a, b) => a.slot - b.slot).map((x) => x.instance);
        o.log(`tokenyard: ${o.n} workers ready on ${r.url} (instances ${ids.join(', ')})`);
        o.onReady(firstReady as WorkerReady[]);
      }
    });
    worker.on('exit', (code, signal) => {
      if (slots.get(slot)?.worker === worker) slots.delete(slot);
      const how = signal ? `on signal ${signal}` : `with code ${code}`;
      const who = `worker ${slot} (pid ${worker.process.pid}, instance ${instance})`;
      if (stopping) {
        if (code !== 0) failed = true;
        return finish();
      }
      if (!s.ready) {
        o.log(`tokenyard: ${who} exited ${how} before it was ready; stopping`);
        return stopAll(1);
      }
      const now = Date.now();
      crashes.push(now);
      while (crashes.length > 0 && (crashes[0] as number) < now - RESTART_WINDOW_MS) crashes.shift();
      if (crashes.length > MAX_RESTARTS) {
        o.log(`tokenyard: ${who} exited ${how}; workers crashed ${crashes.length} times within 60 s, stopping`);
        return stopAll(1);
      }
      o.log(`tokenyard: ${who} exited ${how}, starting a replacement`);
      fork(slot);
    });
  };

  for (let i = 1; i <= o.n; i++) fork(i);

  let signalled = false;
  const onSignal = (): void => {
    if (signalled) {
      o.log('tokenyard: second signal, closing every connection now');
      for (const s of slots.values()) send(s.worker, { tokenyard: 'now' });
      return;
    }
    signalled = true;
    if (o.graceMs > 0) o.log(`tokenyard: draining ${slots.size} workers, up to ${o.graceMs} ms for requests in flight (signal again to stop at once)`);
    stopAll(0);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
}
