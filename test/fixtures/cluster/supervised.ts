// A minimal process under the `serve --workers` supervisor (src/edge/cluster.ts), without a gateway or Redis, so the
// supervisor's port sharing, restarts, startup failures and drains run on every platform (test/edge/cluster.test.ts).
//   node --import tsx test/fixtures/cluster/supervised.ts <workers> [graceMs]
// Each worker answers every request with its pid and instance id. FIXTURE_FAIL_START=1 makes workers exit before
// they report ready; FIXTURE_HOLD_MS makes /slow answer after that long (a request in flight during a drain).
import cluster from 'node:cluster';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { notifyReady, onPrimaryCommand, superviseWorkers, workerContext } from '../../../src/edge/cluster.js';

if (cluster.isPrimary) {
  superviseWorkers({
    n: Number(process.argv[2] ?? '2'),
    baseInstance: 'fixture0',
    graceMs: Number(process.argv[3] ?? '5000'),
    log: (s) => console.error(s),
    onReady: (ready) => console.log(ready[0]?.url),
  });
} else {
  const ctx = workerContext();
  if (ctx === null) throw new Error('no worker context');
  if (process.env.FIXTURE_FAIL_START === '1') process.exit(3);
  const hold = Number(process.env.FIXTURE_HOLD_MS ?? '0');
  const server = createServer((req, res) => {
    const answer = (): void => void res.end(JSON.stringify({ pid: process.pid, instance: ctx.instance, slot: ctx.slot }));
    if (req.url === '/slow') setTimeout(answer, hold);
    else answer();
  });
  server.listen(0, '127.0.0.1', () => notifyReady({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, ops: null }));
  let draining = false;
  onPrimaryCommand({
    drain: () => {
      if (draining) return;
      draining = true;
      server.close(() => process.exit(0));
      server.closeIdleConnections();
    },
    now: () => process.exit(0),
  });
}
