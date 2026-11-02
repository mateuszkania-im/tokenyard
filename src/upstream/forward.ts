import type { IncomingHttpHeaders } from 'node:http';
import type { Readable } from 'node:stream';
import { Agent, request, type Dispatcher } from 'undici';
import type { ProviderSpec } from '../policy/types.js';

export interface ForwardRequest {
  method: string;
  pathAndQuery: string;
  headers: Record<string, string | string[]>;
  /** The original request bytes. Typed Buffer on purpose: the forwarder never sees a parsed object. */
  body: Buffer;
}

export interface UpstreamResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Readable;
}

// One keep-alive pool per origin (undici Agent). Timeouts match Claude Code's default 10 minute
// request timeout; the client's abort signal ends a request earlier.
const agent = new Agent({ headersTimeout: 600_000, bodyTimeout: 600_000 });

function targetUrl(p: ProviderSpec, pathAndQuery: string): string {
  const base = new URL(p.baseUrl);
  return base.origin + base.pathname.replace(/\/+$/, '') + pathAndQuery;
}

/** One upstream attempt. Resolves when the response headers arrive; the body streams afterwards. */
export async function forward(p: ProviderSpec, r: ForwardRequest, signal: AbortSignal): Promise<UpstreamResponse> {
  const res = await request(targetUrl(p, r.pathAndQuery), {
    method: r.method as Dispatcher.HttpMethod,
    headers: r.headers,
    body: r.method === 'GET' || r.method === 'HEAD' ? undefined : r.body,
    signal,
    dispatcher: agent,
  });
  return { status: res.statusCode, headers: res.headers as IncomingHttpHeaders, body: res.body };
}
