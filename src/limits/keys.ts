// Counter store key names (spec 7.2). Pure. Every key starts with `ty:{tenant}:`, so all keys of one admit call share
// one Redis Cluster slot. Each part is percent-encoded, so a name holding `:`, `{` or `}` can neither break the hash
// tag nor collide with another key.

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

/** Session taint set (spec 6.6): value HMACs of secrets blocked in this session, or for this key when there is no session. */
export function taintKey(tenant: string, session: string): string {
  return `${prefix(tenant)}:taint:${part(session)}`;
}
