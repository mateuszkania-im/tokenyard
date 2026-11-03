import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHandler, type GatewayDeps } from './handler.js';
import { matchOps, serveOps } from './ops.js';

export type { GatewayDeps, RequestOutcome, TraceSink } from './handler.js';

/** Anthropic's documented request size limit for the Messages and token counting endpoints (32 MB). */
export const DEFAULT_BODY_CAP_BYTES = 32 * 1024 * 1024;

function listenOn(server: Server, port: number, host: string): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      const a = server.address() as AddressInfo;
      const h = a.family === 'IPv6' ? `[${a.address}]` : a.address;
      resolve(`http://${h}:${a.port}`);
    });
  });
}

export function createGateway(deps: GatewayDeps): {
  listen(port: number, host?: string): Promise<string>;
  /** A second listener with only /metrics, /healthz and /readyz (pair it with `metricsOnOtherPort: true`). */
  listenOps(port: number, host?: string): Promise<string>;
  close(): Promise<void>;
} {
  const server = createServer(createHandler(deps));
  let ops: Server | null = null;
  return {
    listen: (port, host = '127.0.0.1') => listenOn(server, port, host),
    listenOps(port, host = '127.0.0.1') {
      ops = createServer((req, res) => {
        const kind = matchOps(req.method ?? 'GET', req.url ?? '/', deps.basePath);
        if (kind === null) {
          req.resume();
          res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}');
          return;
        }
        serveOps(deps, kind, req, res).catch(() => res.destroy());
      });
      return listenOn(ops, port, host);
    },
    close() {
      const closing = (s: Server): Promise<void> =>
        new Promise((resolve) => {
          s.close(() => resolve());
          s.closeAllConnections();
        });
      return Promise.all([closing(server), ops ? closing(ops) : Promise.resolve()]).then(() => undefined);
    },
  };
}
