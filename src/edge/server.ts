import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { createHandler, type GatewayDeps } from './handler.js';
import { matchOps, serveOps } from './ops.js';

export type { GatewayDeps, RequestOutcome, TraceSink } from './handler.js';

/** Anthropic's documented request size limit for the Messages and token counting endpoints (32 MB). */
export const DEFAULT_BODY_CAP_BYTES = 32 * 1024 * 1024;

/** An idle close goes ahead when one turn of the event loop took at most this long (the loop is quiet). */
const QUIET_TURN_MS = 5;
/** While the loop is busy, the idle close is tried again this often... */
const BUSY_RETRY_MS = 20;
/** ...for at most this long past the idle timeout; then the socket is closed whatever the loop does. */
const MAX_IDLE_CLOSE_DELAY_MS = 2_000;

/**
 * Node closes an idle keep-alive socket when its timer fires. Timers run before the poll phase reads sockets, and a poll
 * phase busy with other callbacks (a large body scanned inside an I/O callback) reads nothing that arrived after it
 * fetched its events. So on a busy gateway a request the client already sent on the idle socket can still be unread
 * when the socket is destroyed, and the kernel answers it with a reset: ECONNRESET at the client on a reused
 * connection (V2 soak, V3). The close therefore waits for a quiet turn of the loop: one setImmediate (which runs after
 * the poll phase) that comes back within QUIET_TURN_MS; while the loop is busier than that it is tried again every
 * BUSY_RETRY_MS, for at most MAX_IDLE_CLOSE_DELAY_MS. Any byte read since the timer fired cancels it: Node's request
 * handling owns the socket again, and its headers and request timeouts bound it. A socket that stays idle is closed.
 * Loop time is read from the monotonic clock, so a wall clock stepped back cannot stretch the 2 s bound (M5).
 */
export function closeIdleWhenQuiet(socket: Socket, now: () => number = () => performance.now()): void {
  const read = socket.bytesRead;
  const since = now();
  const attempt = (): void => {
    const asked = now();
    setImmediate(() => {
      if (socket.destroyed || socket.bytesRead !== read) return;
      const t = now();
      if (t - asked <= QUIET_TURN_MS || t - since >= MAX_IDLE_CLOSE_DELAY_MS) socket.destroy();
      else setTimeout(attempt, BUSY_RETRY_MS).unref();
    });
  };
  attempt();
}

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
  /** A second listener with only /metrics, /healthz and /readyz (the only place /metrics is served). */
  listenOps(port: number, host?: string): Promise<string>;
  close(): Promise<void>;
} {
  const server = createServer(createHandler(deps));
  if (deps.keepAliveTimeoutMs !== undefined) server.keepAliveTimeout = deps.keepAliveTimeoutMs;
  // A server 'timeout' listener replaces Node's own destroy (server.timeout is 0, so only keep-alive idle timers fire).
  server.on('timeout', (socket: Socket) => closeIdleWhenQuiet(socket));
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
