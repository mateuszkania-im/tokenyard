// Child process of s-v3-3-scan-memory.test.ts (run with --expose-gc): one gateway, the hostile 32 MiB bodies sent to
// it one by one, and per request the answer (status, x-should-retry, error type), the settled outcome (decision,
// reservation), the upstream calls, the peak RSS above the level just before it (sampled every 2 ms by a worker
// thread, which keeps sampling while the gateway's thread is busy), the heap left after a full GC and the longest
// event loop stall. Prints one JSON array.
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import { authHeaders, send } from '../helpers/conformance.js';
import { testPolicy } from '../helpers/policy.js';
import { closeAll, gw, raw, readJson, SERVICE_KEY, serviceKey } from './common.js';
import { hostileBody, MODEL, PLACES, SHAPES } from './scan-budget-bodies.js';

const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) throw new Error('run with --expose-gc');
const OK = JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: MODEL, content: [], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } });
let upstream = 0;
const up = await raw(async (req, res) => {
  await readJson(req);
  upstream++;
  res.writeHead(200, { 'content-type': 'application/json' }).end(OK);
});
const g = await gw(testPolicy({ upstream: up.url, models: [MODEL], extraKeys: [serviceKey] }));
const peak = new BigInt64Array(new SharedArrayBuffer(8));
const sampler = new Worker(
  "const { workerData } = require('node:worker_threads'); const a = new BigInt64Array(workerData); setInterval(() => { const r = BigInt(process.memoryUsage.rss()); if (r > a[0]) a[0] = r; }, 2);",
  { eval: true, workerData: peak.buffer },
);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const out: unknown[] = [];
for (const shape of SHAPES) {
  for (const place of PLACES) {
    const body = hostileBody(shape, place);
    for (const route of ['coding-agent', 'product']) {
      gc();
      await sleep(30);
      const heap0 = process.memoryUsage().heapUsed;
      const rss0 = process.memoryUsage.rss();
      peak[0] = BigInt(rss0);
      const lag = monitorEventLoopDelay({ resolution: 5 });
      lag.enable();
      await sleep(20);
      const before = upstream;
      const r = await send(g.url, { path: '/v1/messages', headers: route === 'product' ? { ...authHeaders, 'x-api-key': SERVICE_KEY } : authHeaders, body });
      for (let i = 0; i < 100 && g.outcomes.length < out.length + 1; i++) await sleep(10);
      lag.disable();
      gc();
      const outcome = g.outcomes.at(-1);
      out.push({
        shape, place, route, status: r.status, upstream: upstream - before, shouldRetry: r.headers['x-should-retry'], errorType: (JSON.parse(r.body.toString()) as { error?: { type?: string } }).error?.type,
        decision: outcome?.decision, reserved: outcome?.reservedMicroUsd ?? 0, outcomes: g.outcomes.length,
        peakRssMb: (Number(peak[0]) - rss0) / 1048576, heapLeftMb: (process.memoryUsage().heapUsed - heap0) / 1048576, lagMs: lag.max / 1e6,
      });
    }
  }
}
await sampler.terminate();
await closeAll();
process.stdout.write(`${JSON.stringify(out)}\n`);
