import { subscribe } from 'node:diagnostics_channel';
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

/**
 * An attempt failed after its request body was handed to the socket: the provider may have received it and may be
 * generating (and billing) the answer, so the attempt is not free and must not be retried on another provider (A6).
 */
export class SentRequestError extends Error {
  constructor(readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : 'upstream request failed after the body was sent');
  }
}

/**
 * Which undici requests wrote their body: undici publishes `undici:request:create` synchronously inside `request()`
 * (the dispatch path builds the request object in the same tick), and `undici:request:bodySent` /
 * `undici:request:bodyChunkSent` once bytes went to the socket. Dispatch handlers cannot see this in undici 7 (the new
 * handler API has no body-sent hook), so the diagnostics channels are the only signal.
 */
interface SendState {
  created: boolean;
  sent: boolean;
}
let creating: SendState | null = null;
const states = new WeakMap<object, SendState>();
subscribe('undici:request:create', (m) => {
  const r = (m as { request?: object }).request;
  if (creating !== null && r !== undefined) {
    creating.created = true;
    states.set(r, creating);
  }
});
const markSent = (m: unknown): void => {
  const r = (m as { request?: object }).request;
  const st = r === undefined ? undefined : states.get(r);
  if (st) st.sent = true;
};
subscribe('undici:request:bodyChunkSent', markSent);
subscribe('undici:request:bodySent', markSent);

/**
 * One upstream attempt. Resolves when the response headers arrive; the body streams afterwards. A failure before the
 * request body was written (connect errors, DNS, a refused connection) rejects with the plain error; any later failure
 * (reset, timeout before headers, client abort while the provider works) rejects with `SentRequestError`.
 */
export async function forward(p: ProviderSpec, r: ForwardRequest, signal: AbortSignal): Promise<UpstreamResponse> {
  const state: SendState = { created: false, sent: false };
  let pending: ReturnType<typeof request>;
  creating = state;
  try {
    pending = request(targetUrl(p, r.pathAndQuery), {
      method: r.method as Dispatcher.HttpMethod,
      headers: r.headers,
      body: r.method === 'GET' || r.method === 'HEAD' ? undefined : r.body,
      signal,
      dispatcher: agent,
    });
  } finally {
    creating = null;
  }
  try {
    const res = await pending;
    return { status: res.statusCode, headers: res.headers as IncomingHttpHeaders, body: res.body };
  } catch (err) {
    // Not seen being created (queued past this tick): whether bytes went out is unknown, so it counts as sent.
    throw state.sent || !state.created ? new SentRequestError(err) : err;
  }
}
