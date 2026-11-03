// Loads a policy from a directory or a URL, compiles it, and swaps one reference (spec 6.7).
// A bad bundle never replaces a good one: the old snapshot keeps serving and loadErrors counts the failure.
import { EventEmitter } from 'node:events';
import { watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { buildBundle, bundleToSource, parseBundle, serializeBundle, type Bundle } from '../policy/bundle.js';
import { attachCandidate, compilePolicy } from '../policy/compile.js';
import type { CompiledPolicy } from '../policy/types.js';
import { fetchBundle } from './fetch-bundle.js';
import { loadPolicyDir } from './load-dir.js';
import { readLkg, writeLkg } from './lkg.js';

export interface PolicyLoaderOptions {
  dir?: string;
  url?: string;
  stateDir: string;
  pollMs?: number;
  debounceMs?: number;
  experimentalSubscription: boolean;
  /** A second policy directory run in audit mode: its decisions are traced, never enforced (spec 6.5). */
  candidateDir?: string;
}

export const DEFAULT_POLL_MS = 15_000;
export const DEFAULT_DEBOUNCE_MS = 250;
/** Reads of a changing policy directory at start before `start` gives up. */
const MAX_START_READS = 20;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

type Trigger = 'start' | 'watch' | 'poll';

export class PolicyLoader extends EventEmitter {
  private base: CompiledPolicy | null = null;
  private current: CompiledPolicy | null = null;
  private activeSha: string | null = null;
  private etag: string | null = null;
  private errors = 0;
  private lastError: string | null = null;
  private queue: Promise<void> = Promise.resolve();
  private watcher: FSWatcher | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private candidate: PolicyLoader | null = null;

  constructor(private readonly o: PolicyLoaderOptions) {
    super();
    if (o.dir && o.url) throw new Error('give a policy directory or a policy URL, not both');
  }

  /** Count of bundles that failed to load (this source and the candidate), for tokenyard_policy_load_errors_total. */
  get loadErrors(): number {
    return this.errors + (this.candidate?.loadErrors ?? 0);
  }

  /** The snapshot for one request. Callers read it once per request, so the request keeps its revision to the end. */
  active(): CompiledPolicy {
    if (!this.current) throw new Error('policy is not loaded');
    return this.current;
  }

  async start(): Promise<void> {
    const hasSource = this.o.dir !== undefined || this.o.url !== undefined;
    let failure: unknown = hasSource ? undefined : new Error('no policy source given');
    if (hasSource) {
      try {
        await this.reload('start', true);
      } catch (e) {
        failure = e;
      }
    }
    if (this.current === null) {
      let lkg: Bundle | null = null;
      let lkgError: unknown;
      try {
        lkg = await readLkg(this.o.stateDir);
      } catch (e) {
        lkgError = e;
      }
      if (!lkg) {
        throw new Error(`cannot start: ${msgOf(failure)}; no usable last-known-good in ${this.o.stateDir}${lkgError ? ` (${msgOf(lkgError)})` : ''}`);
      }
      try {
        this.swap(lkg);
      } catch (e) {
        throw new Error(`cannot start: ${msgOf(failure)}; the last-known-good does not compile (${msgOf(e)})`);
      }
      this.emit('loaded', this.base);
    }
    if (this.o.candidateDir) {
      const c = new PolicyLoader({ dir: this.o.candidateDir, stateDir: join(this.o.stateDir, 'candidate'), experimentalSubscription: this.o.experimentalSubscription, ...(this.o.pollMs !== undefined ? { pollMs: this.o.pollMs } : {}), ...(this.o.debounceMs !== undefined ? { debounceMs: this.o.debounceMs } : {}) });
      c.on('loaded', () => this.recompose());
      c.on('error', (e) => this.report(e));
      try {
        await c.start();
        this.candidate = c;
        this.recompose();
      } catch (e) {
        // The candidate is advisory: a broken one is reported and the gateway runs without audit mode.
        this.errors++;
        this.report(e);
        await c.stop();
      }
    }
    this.startWatching();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.watcher?.close();
    this.watcher = null;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    await this.queue;
    await this.candidate?.stop();
  }

  private startWatching(): void {
    const { dir, url } = this.o;
    if (dir) {
      try {
        this.watcher = watch(dir, () => {
          if (this.debounceTimer) clearTimeout(this.debounceTimer);
          this.debounceTimer = setTimeout(() => void this.reload('watch', false), this.o.debounceMs ?? DEFAULT_DEBOUNCE_MS);
          this.debounceTimer.unref();
        });
        this.watcher.on('error', () => undefined); // the poll below still notices changes
      } catch {
        this.watcher = null;
      }
    }
    if (dir || url) {
      this.pollTimer = setInterval(() => void this.reload('poll', false), this.o.pollMs ?? DEFAULT_POLL_MS);
      this.pollTimer.unref();
    }
  }

  /**
   * Serialised: loads never overlap. With `throwOnError` the failure is also thrown (start); it is always counted.
   * A directory is read file by file and may be caught mid-write: a prefix of policy.yaml can still validate (budgets
   * not written yet), or keys.yaml can be newer than policy.yaml. A changed directory therefore activates only when a
   * second read one settle interval (`debounceMs`) later finds the same bundle; otherwise another read follows (V3,
   * Task 11). At start that repeats up to MAX_START_READS times.
   */
  private reload(trigger: Trigger, throwOnError: boolean): Promise<void> {
    const run = this.queue.then(async () => {
      for (let n = 1; ; n++) {
        if (this.stopped) return;
        if ((await this.loadOnce(trigger, throwOnError)) === 'done') return;
        if (trigger !== 'start') return this.scheduleReload();
        if (n >= MAX_START_READS) {
          const e = new Error(`the policy directory kept changing over ${MAX_START_READS} reads`);
          this.errors++;
          this.report(e);
          throw e;
        }
        // Give a writer caught mid-write one settle interval before the next first read (M4).
        await sleep(this.o.debounceMs ?? DEFAULT_DEBOUNCE_MS);
      }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * One load: 'unstable' when two reads of a changed directory differed, or the second one failed after the first
   * passed (a file caught mid-write, M4); nothing is activated or counted.
   */
  private async loadOnce(trigger: Trigger, throwOnError: boolean): Promise<'done' | 'unstable'> {
    try {
      const got = await this.fetch();
      if (got === null || got.bundle.manifest.sha256 === this.activeSha) {
        if (got) this.etag = got.etag;
        this.lastError = null;
        return 'done';
      }
      if (this.o.dir) {
        await sleep(this.o.debounceMs ?? DEFAULT_DEBOUNCE_MS);
        if (this.stopped) return 'done';
        let again: Awaited<ReturnType<PolicyLoader['fetch']>>;
        try {
          again = await this.fetch();
        } catch {
          return 'unstable';
        }
        if (again?.bundle.manifest.sha256 !== got.bundle.manifest.sha256) return 'unstable';
      }
      const bundle = got.bundle;
      this.swap(bundle);
      this.etag = got.etag;
      this.lastError = null;
      this.emit('loaded', this.base);
      await writeLkg(this.o.stateDir, serializeBundle(bundle)).catch((e: unknown) => this.report(new Error(`could not write last-known-good: ${msgOf(e)}`)));
    } catch (e) {
      const message = msgOf(e);
      // A broken file that the poll finds again is one failure, not one per tick.
      if (!(trigger === 'poll' && message === this.lastError)) {
        this.errors++;
        this.lastError = message;
        this.report(e);
      }
      if (throwOnError) throw e;
    }
    return 'done';
  }

  /** Another read once the directory had time to settle (the watcher and the poll also trigger one). */
  private scheduleReload(): void {
    if (this.stopped) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => void this.reload('watch', false), this.o.debounceMs ?? DEFAULT_DEBOUNCE_MS);
    this.debounceTimer.unref();
  }

  private async fetch(): Promise<{ bundle: Bundle; etag: string | null } | null> {
    if (this.o.dir) return { bundle: buildBundle(await loadPolicyDir(this.o.dir), { createdAt: new Date().toISOString() }), etag: null };
    if (this.o.url) {
      const r = await fetchBundle(this.o.url, { etag: this.etag });
      if (r.status === 'not-modified') return null;
      return { bundle: parseBundle(r.text), etag: r.etag };
    }
    return null;
  }

  /** Compiles and swaps. Throws, leaving the old snapshot in place, when the bundle does not compile. */
  private swap(bundle: Bundle): void {
    const compiled = compilePolicy(bundleToSource(bundle), bundle.manifest.revision, { experimentalSubscription: this.o.experimentalSubscription });
    this.base = compiled;
    this.activeSha = bundle.manifest.sha256;
    this.recompose();
  }

  private recompose(): void {
    if (!this.base) return;
    this.current = attachCandidate(this.base, this.candidate?.base ?? null); // the one reference swap
  }

  private report(e: unknown): void {
    if (this.listenerCount('error') > 0) this.emit('error', e instanceof Error ? e : new Error(String(e)));
  }
}

const msgOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
