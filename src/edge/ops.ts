// Operations endpoints (spec 12.2): /healthz (process up), /readyz (policy loaded, store reachable or the failure mode
// allows traffic) and /metrics (Prometheus text). No content: counts, names from the policy, status. Without a metrics
// token, /metrics and /readyz answer only requests whose Host is a loopback address or localhost (DNS rebinding, B3).
import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CounterStore } from '../limits/store.js';
import type { CompiledPolicy } from '../policy/types.js';
import type { Metrics } from '../telemetry/metrics.js';

export type OpsKind = 'metrics' | 'healthz' | 'readyz';

export interface OpsDeps {
  policy(): CompiledPolicy;
  store: CounterStore | null;
  metrics?: Metrics;
  /** When set, /metrics needs `Authorization: Bearer <token>`. */
  metricsToken?: string;
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

/**
 * Loopback addresses: the ops listener may run without a token only here. An IPv4-mapped loopback address
 * (`::ffff:127.0.0.1`) is not recognised, so it needs a token; test/cli/serve-ops.test.ts relies on that to test the
 * token path on a listener reachable only through loopback. Recognising it here changes what that test covers.
 */
export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
}

/**
 * The host name of a Host header (`name`, `name:port`, `[v6]:port`), or null when there is none. Used to refuse DNS
 * rebinding: a page on another origin reaches a loopback listener only under its own host name.
 */
export function hostHeaderName(h: string | undefined): string | null {
  if (!h) return null;
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    return end < 0 ? null : h.slice(0, end + 1);
  }
  const colon = h.indexOf(':');
  return colon < 0 ? h : h.slice(0, colon);
}

const digest = (s: string): Buffer => createHash('sha256').update(s).digest();

function bearerOk(req: IncomingMessage, token: string): boolean {
  const m = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''));
  return timingSafeEqual(digest(m?.[1] ?? ''), digest(token)) && m !== null;
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
  // Without a token the listener is loopback only; a Host that names anything else is a rebound browser request (B3).
  const host = hostHeaderName(req.headers.host);
  if (d.metricsToken === undefined && (host === null || !isLoopbackHost(host))) return send(421, 'application/json', '{"error":"misdirected request: use a loopback Host or set a metrics token"}');
  if (kind === 'readyz') {
    const r = await readiness(d);
    return send(r.ok ? 200 : 503, 'application/json', JSON.stringify({ status: r.ok ? 'ready' : 'not ready', reason: r.reason }));
  }
  if (d.metricsToken !== undefined && !bearerOk(req, d.metricsToken)) {
    res.setHeader('www-authenticate', 'Bearer');
    return send(401, 'application/json', '{"error":"unauthorized"}');
  }
  if (!d.metrics) return send(404, 'application/json', '{"error":"metrics are not enabled"}');
  send(200, 'text/plain; version=0.0.4; charset=utf-8', d.metrics.render());
}
