import { createServer, request, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

type Obj = Record<string, unknown>;

/**
 * A deliberately naive proxy, the kind the conformance suite exists to catch: it parses the JSON body,
 * flattens `system` to a plain string (dropping its cache_control breakpoints) and re-serialises it.
 * Everything else, including the response, is relayed unchanged.
 */
export async function startNaiveProxy(upstreamUrl: string): Promise<{ url: string; close(): Promise<void> }> {
  const up = new URL(upstreamUrl);
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      let body = Buffer.concat(chunks);
      try {
        const parsed = JSON.parse(body.toString('utf8')) as Obj;
        if (Array.isArray(parsed.system)) {
          parsed.system = (parsed.system as Obj[]).map((b) => String(b.text ?? '')).join('\n');
        }
        body = Buffer.from(JSON.stringify(parsed));
      } catch {
        // not JSON: forwarded as is
      }
      const headers: IncomingHttpHeaders = { ...req.headers, host: up.host, 'content-length': String(body.length) };
      const out = request(
        { host: up.hostname, port: up.port, method: req.method, path: req.url, headers },
        (r) => {
          res.writeHead(r.statusCode ?? 502, r.headers);
          r.pipe(res);
        },
      );
      out.on('error', () => res.destroy());
      res.on('close', () => out.destroy());
      out.end(body);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise((r) => {
        server.close(() => r());
        server.closeAllConnections();
      }),
  };
}
