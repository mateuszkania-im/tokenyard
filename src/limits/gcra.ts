// Generic cell rate algorithm (spec 7.5): one theoretical arrival time (TAT) per key, no background process.
// `burst` requests fit at once; each request of quantity q moves the TAT q emission intervals ahead.
// The Redis admit script mirrors this function line for line (src/limits/lua.ts).

export function gcra(tatMs: number | null, nowMs: number, emissionMs: number, burst: number, quantity: number): { allowed: boolean; tatMs: number; retryAfterMs: number } {
  const tat = tatMs === null || tatMs < nowMs ? nowMs : tatMs;
  const next = tat + emissionMs * quantity;
  const allowAt = next - emissionMs * burst;
  if (allowAt > nowMs) return { allowed: false, tatMs: tat, retryAfterMs: allowAt - nowMs };
  return { allowed: true, tatMs: next, retryAfterMs: 0 };
}
