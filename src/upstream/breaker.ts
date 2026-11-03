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
 * Most credential-scoped entries the breaker keeps (FR-M1). Each is one open spend-capped credential (about 100 bytes);
 * past the cap the oldest opened goes first, which at worst lets that credential reach the provider once more.
 */
export const MAX_CREDENTIAL_ENTRIES = 10_000;

/**
 * Circuit breaker per provider, process-local (spec 8). It opens when, inside the trailing window, at least
 * `minRequests` outcomes were recorded and the failure ratio reached `failureRatio`.
 */
export class Breaker {
  private readonly states = new Map<string, State>();
  /**
   * Credential-scoped entries (a spend-cap 429 on one credential, S12-1): open until the time stored, in the order they
   * were opened. No outcome is recorded for them, so an entry whose period ended is deleted instead of half opened.
   */
  private readonly credentials = new Map<string, number>();

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

  /** How many credential-scoped entries are held (tests). */
  credentialEntries(): number {
    return this.credentials.size;
  }

  allow(provider: string): boolean {
    const until = this.credentials.get(provider);
    if (until !== undefined) {
      if (this.clock() < until) return false;
      this.credentials.delete(provider);
      return true;
    }
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
    try {
      this.onOpen?.(scope);
    } catch {
      // a metrics hook must not break the breaker
    }
    if (scope === 'credential') return this.openCredential(provider, untilMs);
    const s = this.state(provider);
    s.openUntil = untilMs;
    s.halfOpen = false;
    Object.assign(s, emptyWindow());
  }

  /**
   * Re-inserted, so the map stays in opening order. Expired entries at the old end go first (one open period for all,
   * so that end holds the earliest ends), then the oldest while over the cap.
   */
  private openCredential(key: string, untilMs: number): void {
    this.credentials.delete(key);
    this.credentials.set(key, untilMs);
    const now = this.clock();
    for (const [k, until] of this.credentials) {
      if (until > now) break;
      this.credentials.delete(k);
    }
    for (const k of this.credentials.keys()) {
      if (this.credentials.size <= MAX_CREDENTIAL_ENTRIES) break;
      this.credentials.delete(k);
    }
  }
}

const emptyWindow = (): Pick<State, 'ats' | 'oks' | 'head' | 'failures' | 'sorted'> => ({ ats: [], oks: [], head: 0, failures: 0, sorted: true });
