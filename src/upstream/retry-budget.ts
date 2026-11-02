const WINDOW_MS = 60_000;

interface Tally {
  requests: number[];
  retries: number[];
}

/**
 * Per-tenant retry budget (spec 8): retries over the trailing minute stay at or below `ratio` of the requests
 * over the same minute, so a failing provider cannot turn into a fallback storm. One retry is always allowed
 * per window (otherwise a ratio of 10% would never permit a retry before ten requests); a ratio of 0 allows none.
 */
export class RetryBudget {
  private readonly tallies = new Map<string, Tally>();

  constructor(
    private readonly ratio: number,
    private readonly clock: () => number,
  ) {}

  private tally(tenant: string): Tally {
    const now = this.clock();
    let t = this.tallies.get(tenant);
    if (!t) this.tallies.set(tenant, (t = { requests: [], retries: [] }));
    const cutoff = now - WINDOW_MS;
    while (t.requests.length > 0 && (t.requests[0] as number) <= cutoff) t.requests.shift();
    while (t.retries.length > 0 && (t.retries[0] as number) <= cutoff) t.retries.shift();
    return t;
  }

  /** Counts one client request. */
  request(tenant: string): void {
    this.tally(tenant).requests.push(this.clock());
  }

  /** Spends one retry when the budget has room. */
  tryRetry(tenant: string): boolean {
    if (this.ratio <= 0) return false;
    const t = this.tally(tenant);
    if (t.retries.length >= Math.max(1, this.ratio * t.requests.length)) return false;
    t.retries.push(this.clock());
    return true;
  }
}
