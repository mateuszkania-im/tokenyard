export interface BreakerOptions {
  minRequests: number;
  failureRatio: number;
  windowSeconds: number;
  openSeconds: number;
}

interface State {
  events: Array<{ at: number; ok: boolean }>;
  openUntil: number;
  /** The open period ended: the next outcome decides (success closes, failure opens again at once). */
  halfOpen: boolean;
}

/**
 * Circuit breaker per provider, process-local (spec 8). It opens when, inside the trailing window, at least
 * `minRequests` outcomes were recorded and the failure ratio reached `failureRatio`.
 */
export class Breaker {
  private readonly states = new Map<string, State>();

  constructor(
    private readonly o: BreakerOptions,
    private readonly clock: () => number,
    /** Called when the breaker opens, with the scope: the provider's health, or one credential (spend cap). */
    private readonly onOpen?: (scope: 'provider' | 'credential') => void,
  ) {}

  private state(provider: string): State {
    let s = this.states.get(provider);
    if (!s) this.states.set(provider, (s = { events: [], openUntil: 0, halfOpen: false }));
    return s;
  }

  allow(provider: string): boolean {
    const s = this.states.get(provider);
    if (!s || s.openUntil === 0) return true;
    if (this.clock() < s.openUntil) return false;
    s.openUntil = 0;
    s.halfOpen = true;
    s.events = [];
    return true;
  }

  record(provider: string, ok: boolean): void {
    const s = this.state(provider);
    const now = this.clock();
    if (s.openUntil > now) return; // an attempt that was already in flight when the breaker opened
    if (s.halfOpen) {
      s.halfOpen = false;
      if (!ok) this.open(provider, now + this.o.openSeconds * 1000);
      return;
    }
    const cutoff = now - this.o.windowSeconds * 1000;
    s.events = s.events.filter((e) => e.at > cutoff);
    s.events.push({ at: now, ok });
    const failures = s.events.filter((e) => !e.ok).length;
    if (s.events.length >= this.o.minRequests && failures / s.events.length >= this.o.failureRatio) {
      this.open(provider, now + this.o.openSeconds * 1000);
    }
  }

  /** Opens the breaker until `untilMs` (a spend-cap 429 does this for `openSeconds`). */
  open(provider: string, untilMs: number, scope: 'provider' | 'credential' = 'provider'): void {
    const s = this.state(provider);
    try {
      this.onOpen?.(scope);
    } catch {
      // a metrics hook must not break the breaker
    }
    s.openUntil = untilMs;
    s.halfOpen = false;
    s.events = [];
  }
}
