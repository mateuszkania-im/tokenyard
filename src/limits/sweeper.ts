// Sweeper (spec 7.2): every `intervalMs`, settle reservations past their deadline at their estimate and free their
// stream slots. The tick also drives the trace heartbeat (`onTick`, spec 9.1), off the hot path. A tick that finds
// the previous sweep still running skips; a failing lock or sweep goes to `onError` and the next tick tries again,
// so a persistent failure (Lua error, CROSSSLOT, store down) is visible instead of silently stopping the sweeps.
import type { CounterStore } from './store.js';

export function startSweeper(store: CounterStore, o: { intervalMs: number; onTick?: () => void; onError?: (e: unknown) => void; lock?: { acquire(): Promise<boolean> } }): () => void {
  let running = false;
  const tick = async (): Promise<void> => {
    o.onTick?.();
    if (running) return;
    running = true;
    try {
      if (o.lock && !(await o.lock.acquire())) return;
      await store.sweep(Date.now());
    } catch (e) {
      try {
        o.onError?.(e);
      } catch {
        // a throwing error handler must not stop the sweeper
      }
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), o.intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
