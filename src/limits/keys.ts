// Counter store key names (spec 7.2). Pure. Every key starts with `ty:{tenant}:`, so all keys of one admit call share
// one Redis Cluster slot. Each part is percent-encoded (`encodeURIComponent` escapes `:`, `{` and `}`), so a name holding
// them can neither break the hash tag nor collide with another key.

const part = (s: string): string => encodeURIComponent(s);
const prefix = (tenant: string): string => `ty:{${part(tenant)}}`;

/** Budget level: `ty:{acme}:b:team-day:web:2026-11-02`; a session budget has no window start. */
export function budgetKey(tenant: string, budget: string, scopeValue: string, windowStart: string | null): string {
  const base = `${prefix(tenant)}:b:${part(budget)}:${part(scopeValue)}`;
  return windowStart === null ? base : `${base}:${part(windowStart)}`;
}

/** GCRA theoretical arrival time of one rate limit level. */
export function gcraKey(tenant: string, limit: string, scopeValue: string): string {
  return `${prefix(tenant)}:g:${part(limit)}:${part(scopeValue)}`;
}

/** Open stream count of one concurrent stream limit level. */
export function streamKey(tenant: string, limit: string, scopeValue: string): string {
  return `${prefix(tenant)}:st:${part(limit)}:${part(scopeValue)}`;
}

/** Session taint set (spec 6.6): value HMACs of secrets blocked in this session. */
export function taintKey(tenant: string, session: string): string {
  return `${prefix(tenant)}:taint:s:${part(session)}`;
}

/**
 * Taint set of a key, for requests without a session. Its own namespace (`k:` beside the sessions' `s:`), so a client
 * that sends a session id equal to a key id reaches neither that key's set nor clears it.
 */
export function keyTaintKey(tenant: string, keyId: string): string {
  return `${prefix(tenant)}:taint:k:${part(keyId)}`;
}

/** Reservation record of one admitted request; the request id is the reservation id. */
export function reservationKey(tenant: string, id: string): string {
  return `${prefix(tenant)}:res:${part(id)}`;
}

/** Sorted set of a tenant's open reservations by deadline (ms since epoch). */
export function deadlinesKey(tenant: string): string {
  return `${prefix(tenant)}:deadlines`;
}

/** Reserved tenant name of the sweep lock: one sweep covers every tenant, and the key still follows the `{tenant}` rule. */
export const SWEEP_LOCK_TENANT = '_sweeper';

/** Short `SET NX PX` lock so one instance at a time runs the sweeper. */
export function sweepLockKey(tenant: string): string {
  return `${prefix(tenant)}:sweep-lock`;
}

const TAG = /^ty:\{([^{}]*)\}:/;

/** The tenant of a counter key, or null when the key is not in the `ty:{tenant}:` layout. */
export function tenantOfKey(key: string): string | null {
  const m = TAG.exec(key);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1] as string);
  } catch {
    return null;
  }
}
