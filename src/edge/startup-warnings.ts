// What `tokenyard serve` warns about on stderr at start (final review FR-I2, FR-M7). Pure: the caller passes the
// environment and prints. A warning names a variable, never its value.
import type { CompiledPolicy } from '../policy/types.js';

export function startupWarnings(policy: CompiledPolicy, o: { store: 'memory' | 'redis'; traceDir: boolean; env: NodeJS.ProcessEnv }): string[] {
  const out: string[] = [];
  // The memory store keeps spend in the process; only the trace dir's warm-up brings it back after a restart (FR-I2).
  if (o.store === 'memory' && !o.traceDir && policy.budgets.some((b) => b.enforce || b.enforceSubscription)) {
    out.push('tokenyard: warning: budgets are enforced on the memory store without --trace-dir, so every restart starts their spend from zero; give --trace-dir (warm-up) or use --store redis');
  }
  // An unset credential is not an error (the provider answers 401, which reaches the client), but it is a misconfiguration (FR-M7).
  for (const p of policy.providers.values()) {
    if (p.credential === 'passthrough' || o.env[p.credential.env]) continue;
    out.push(`tokenyard: warning: provider "${p.name}" reads its key from ${p.credential.env}, which is not set; its requests will get the provider's 401`);
  }
  return out;
}
