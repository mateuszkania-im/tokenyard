// Preloaded into each gateway process by `npm run soak` (node --expose-gc --import ./bench/soak-probe.mjs bin/tokenyard.mjs
// serve ...), so the soak measures the shipped bundle without a debug endpoint in it. Answers GET /sample on
// 127.0.0.1:$SOAK_PROBE_PORT with event loop delay since the previous sample (beyond the monitor's 10 ms tick), then memory right after a full GC, and
// active handles by type. It changes nothing the gateway does: no exception or rejection handler is added, only the
// uncaughtExceptionMonitor (which observes and lets the process crash as before).
import { createServer } from 'node:http';
import { monitorEventLoopDelay } from 'node:perf_hooks';

const port = Number(process.env.SOAK_PROBE_PORT);
if (Number.isInteger(port) && port > 0) {
  // The histogram records the time between the monitor's timer ticks, so the 10 ms tick is taken off each value.
  const RESOLUTION_MS = 10;
  const eld = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
  eld.enable();
  let uncaught = 0;
  /** CPU the probe's own forced GCs used, left out of the reported CPU time. */
  let gcUs = 0;
  const cpuUs = () => {
    const c = process.cpuUsage();
    return c.user + c.system;
  };
  process.on('uncaughtExceptionMonitor', () => uncaught++);
  const ms = (ns) => Math.max(0, Math.round((ns / 1e6 - RESOLUTION_MS) * 100) / 100);
  const mb = (b) => Math.round((b / 1024 / 1024) * 100) / 100;
  const server = createServer((req, res) => {
    req.resume();
    if (req.url !== '/sample') return void res.writeHead(404).end();
    const loop = { p50Ms: ms(eld.percentile(50)), p99Ms: ms(eld.percentile(99)), maxMs: ms(eld.max) };
    // The forced GC runs before the reset, so its pause is not counted in the next sample's event loop delay.
    const beforeGc = cpuUs();
    globalThis.gc?.();
    gcUs += cpuUs() - beforeGc;
    eld.reset();
    const m = process.memoryUsage();
    const handles = {};
    for (const h of process.getActiveResourcesInfo()) handles[h] = (handles[h] ?? 0) + 1;
    const body = JSON.stringify({ pid: process.pid, loop, rssMb: mb(m.rss), heapUsedMb: mb(m.heapUsed), heapTotalMb: mb(m.heapTotal), externalMb: mb(m.external), arrayBuffersMb: mb(m.arrayBuffers), handles, uncaught, cpuUs: cpuUs() - gcUs });
    res.writeHead(200, { 'content-type': 'application/json', connection: 'close' }).end(body);
  });
  server.listen(port, '127.0.0.1');
  server.unref();
}
