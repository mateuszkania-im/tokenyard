import { createGateway, type GatewayDeps } from '../../src/edge/server.js';
import type { CompiledPolicy } from '../../src/policy/types.js';
import type { CounterStore } from '../../src/limits/store.js';

export interface TestGateway {
  url: string;
  /** The ops listener (`opsListener: true`): /metrics, /healthz, /readyz only. */
  opsUrl?: string;
  close(): Promise<void>;
}

/** Start a gateway on an ephemeral port with deterministic ids; no traces unless `traces` is given (with a `traceSalt`). */
export async function startGateway(o: {
  policy: CompiledPolicy | (() => CompiledPolicy);
  bodyCapBytes?: number;
  basePath?: string | null;
  store?: CounterStore | null;
  experimentalSubscription?: boolean;
  onSettled?: GatewayDeps['onSettled'];
  traces?: GatewayDeps['traces'];
  traceSalt?: string;
  runtime?: GatewayDeps['runtime'];
  admitTimeoutMs?: number;
  metrics?: GatewayDeps['metrics'];
  spans?: GatewayDeps['spans'];
  /** Serve /metrics on a second listener only. */
  opsListener?: boolean;
  metricsToken?: string;
  /** Defaults to `Date.now` as it is now; pass `() => Date.now()` to follow fake timers installed later. */
  clock?: () => number;
  requestDeadlineMs?: number;
  keepAliveTimeoutMs?: number;
  /** Called with each request id the gateway hands out (one per request that reached the handler). */
  onId?: (id: string) => void;
  /** Request ids are `<idPrefix><n>` (default `req_`): a restarted gateway in one test needs another prefix. */
  idPrefix?: string;
}): Promise<TestGateway> {
  let n = 0;
  const gw = createGateway({
    policy: typeof o.policy === 'function' ? o.policy : () => o.policy as CompiledPolicy,
    store: o.store ?? null,
    traces: o.traces ?? null,
    traceSalt: o.traceSalt,
    clock: o.clock ?? Date.now,
    ...(o.requestDeadlineMs !== undefined ? { requestDeadlineMs: o.requestDeadlineMs } : {}),
    ...(o.keepAliveTimeoutMs !== undefined ? { keepAliveTimeoutMs: o.keepAliveTimeoutMs } : {}),
    newId: () => {
      const id = `${o.idPrefix ?? 'req_'}${String(++n).padStart(6, '0')}`;
      o.onId?.(id);
      return id;
    },
    basePath: o.basePath ?? null,
    bodyCapBytes: o.bodyCapBytes ?? 32 * 1024 * 1024,
    experimentalSubscription: o.experimentalSubscription ?? false,
    onSettled: o.onSettled,
    runtime: o.runtime,
    ...(o.admitTimeoutMs !== undefined ? { admitTimeoutMs: o.admitTimeoutMs } : {}),
    ...(o.metrics ? { metrics: o.metrics } : {}),
    ...(o.spans ? { spans: o.spans } : {}),
    ...(o.metricsToken ? { metricsToken: o.metricsToken } : {}),
  });
  const url = await gw.listen(0, '127.0.0.1');
  const opsUrl = o.opsListener ? await gw.listenOps(0, '127.0.0.1') : undefined;
  return { url, ...(opsUrl ? { opsUrl } : {}), close: () => gw.close() };
}
