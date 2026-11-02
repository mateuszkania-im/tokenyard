import { createGateway } from '../../src/edge/server.js';
import type { CompiledPolicy } from '../../src/policy/types.js';
import type { CounterStore } from '../../src/limits/store.js';

export interface TestGateway {
  url: string;
  close(): Promise<void>;
}

/** Start a gateway on an ephemeral port with deterministic ids and no traces. */
export async function startGateway(o: {
  policy: CompiledPolicy;
  bodyCapBytes?: number;
  basePath?: string | null;
  store?: CounterStore | null;
}): Promise<TestGateway> {
  let n = 0;
  const gw = createGateway({
    policy: () => o.policy,
    store: o.store ?? null,
    traces: null,
    clock: Date.now,
    newId: () => `req_${String(++n).padStart(6, '0')}`,
    basePath: o.basePath ?? null,
    bodyCapBytes: o.bodyCapBytes ?? 32 * 1024 * 1024,
  });
  const url = await gw.listen(0, '127.0.0.1');
  return { url, close: () => gw.close() };
}
