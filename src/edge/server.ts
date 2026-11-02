import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHandler, type GatewayDeps } from './handler.js';

export type { GatewayDeps, TraceSink } from './handler.js';

/** Anthropic's documented request size limit for the Messages and token counting endpoints (32 MB). */
export const DEFAULT_BODY_CAP_BYTES = 32 * 1024 * 1024;

export function createGateway(deps: GatewayDeps): { listen(port: number, host?: string): Promise<string>; close(): Promise<void> } {
  const server = createServer(createHandler(deps));
  return {
    listen(port, host = '127.0.0.1') {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          const a = server.address() as AddressInfo;
          const h = a.family === 'IPv6' ? `[${a.address}]` : a.address;
          resolve(`http://${h}:${a.port}`);
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
