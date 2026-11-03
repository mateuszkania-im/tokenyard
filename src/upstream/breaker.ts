export interface BreakerOptions {
  minRequests: number;
  failureRatio: number;
  windowSeconds: number;
  openSeconds: number;
}

interface State {
  /** Outcome times and results in the trailing window; entries before `head` have left it. */
  ats: number[];
  oks: boolean[];
  head: number;
  /** Failures among the live entries (`head` onwards). */
  failures: number;
  /** The live entries are in time order (the clock never stepped back since the window was last rebuilt). */
  sorted: boolean;
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
    if (!s) this.states.set(provider, (s = { ...emptyWindow(), openUntil: 0, halfOpen: false }));
    return s;
  }

  /**
   * Drops outcomes at or before `cutoff`. In time order that is a prefix, dropped by moving `head` (constant time per
   * outcome, V1: the window holds every outcome of the last `windowSeconds`, tens of thousands under load); after
   * the clock stepped back the whole window is filtered, as before.
   */
  private expire(s: State, cutoff: number): void {
    if (s.sorted) {
      while (s.head < s.ats.length && (s.ats[s.head] as number) <= cutoff) {
        if (!s.oks[s.head]) s.failures--;
        s.head++;
      }
      if (s.head > 1024 && s.head * 2 > s.ats.length) {
        s.ats = s.ats.slice(s.head);
        s.oks = s.oks.slice(s.head);
        s.head = 0;
      }
      return;
    }
    const ats: number[] = [];
    const oks: boolean[] = [];
    let failures = 0;
    let sorted = true;
    for (let k = s.head; k < s.ats.length; k++) {
      const at = s.ats[k] as number;
      if (at <= cutoff) continue;
      if (ats.length > 0 && at < (ats[ats.length - 1] as number)) sorted = false;
      ats.push(at);
      oks.push(s.oks[k] as boolean);
      if (!s.oks[k]) failures++;
    }
    Object.assign(s, { ats, oks, head: 0, failures, sorted });
  }

  allow(provider: string): boolean {
    const s = this.states.get(provider);
    if (!s || s.openUntil === 0) return true;
    if (this.clock() < s.openUntil) return false;
    s.openUntil = 0;
    s.halfOpen = true;
    Object.assign(s, emptyWindow());
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
    this.expire(s, now - this.o.windowSeconds * 1000);
    if (s.ats.length > s.head && now < (s.ats[s.ats.length - 1] as number)) s.sorted = false;
    s.ats.push(now);
    s.oks.push(ok);
    if (!ok) s.failures++;
    const count = s.ats.length - s.head;
    if (count >= this.o.minRequests && s.failures / count >= this.o.failureRatio) {
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
    Object.assign(s, emptyWindow());
  }
}

const emptyWindow = (): Pick<State, 'ats' | 'oks' | 'head' | 'failures' | 'sorted'> => ({ ats: [], oks: [], head: 0, failures: 0, sorted: true });
