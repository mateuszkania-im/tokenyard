// Operations endpoints (spec 12.2): /healthz (process up), /readyz (policy loaded, store reachable or the failure mode
// allows traffic) and /metrics (Prometheus text). No authentication and no content: counts, names from the policy, status.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CounterStore } from '../limits/store.js';
import type { CompiledPolicy } from '../policy/types.js';
import type { Metrics } from '../telemetry/metrics.js';

export type OpsKind = 'metrics' | 'healthz' | 'readyz';

export interface OpsDeps {
  policy(): CompiledPolicy;
  store: CounterStore | null;
  metrics?: Metrics;
  basePath: string | null;
  /** How long the store probe may take (default 1 s). */
  admitTimeoutMs?: number;
}

/** A counter key no request uses; reading it is the cheapest round trip to the store. */
const PROBE_KEY = 'ty:{tokenyard-health}:probe';

/** Which ops endpoint a request is for, or null. Query strings are ignored; the base path is stripped like for the API. */
export function matchOps(method: string, rawUrl: string, basePath: string | null): OpsKind | null {
  if (method !== 'GET' && method !== 'HEAD') return null;
  let path = rawUrl.split('?')[0] ?? '';
  const base = basePath?.replace(/\/+$/, '') ?? '';
  if (base !== '') {
    if (!path.startsWith(`${base}/`)) return null;
    path = path.slice(base.length);
  }
  return path === '/metrics' ? 'metrics' : path === '/healthz' ? 'healthz' : path === '/readyz' ? 'readyz' : null;
}

async function readiness(d: OpsDeps): Promise<{ ok: boolean; reason: string }> {
  let policy: CompiledPolicy;
  try {
    policy = d.policy();
  } catch {
    return { ok: false, reason: 'policy not loaded' };
  }
  if (d.store === null) return { ok: true, reason: 'ready' };
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      d.store.snapshot([PROBE_KEY]),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), d.admitTimeoutMs ?? 1_000);
      }),
    ]);
    return { ok: true, reason: 'ready' };
  } catch {
    const down = policy.failure.counterStoreDown;
    // The same rule resolve() applies per request: a closed mode refuses traffic while the store is down.
    if (down.budgets === 'closed' || down.rateLimits === 'closed') return { ok: false, reason: 'counter store unreachable and the policy fails closed' };
    return { ok: true, reason: 'counter store unreachable, the policy fails open' };
  } finally {
    clearTimeout(timer);
  }
}

export async function serveOps(d: OpsDeps, kind: OpsKind, req: IncomingMessage, res: ServerResponse): Promise<void> {
  req.resume();
  const send = (status: number, type: string, body: string): void => {
    res.writeHead(status, { 'content-type': type, 'content-length': String(Buffer.byteLength(body)), 'cache-control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : body);
  };
  if (kind === 'healthz') return send(200, 'application/json', '{"status":"ok"}');
  if (kind === 'readyz') {
    const r = await readiness(d);
    return send(r.ok ? 200 : 503, 'application/json', JSON.stringify({ status: r.ok ? 'ready' : 'not ready', reason: r.reason }));
  }
  if (!d.metrics) return send(404, 'application/json', '{"error":"metrics are not enabled"}');
  send(200, 'text/plain; version=0.0.4; charset=utf-8', d.metrics.render());
}
