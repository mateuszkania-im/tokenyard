// Spec 7.1: the replay counter store, the memory store driven by a virtual clock (the trace timestamps). Pure.
import { createMemoryStore } from '../limits/memory-store.js';
import type { CounterStore } from '../limits/store.js';

/** Reservations never time out here: replay settles each request at its recorded end, so no sweep is needed. */
const NO_DEADLINE_MS = Number.MAX_SAFE_INTEGER / 2;

export function createSimStore(clock: () => number): CounterStore {
  return createMemoryStore({ clock, deadlineMs: NO_DEADLINE_MS });
}
