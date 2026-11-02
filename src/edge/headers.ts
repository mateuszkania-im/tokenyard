import type { IncomingHttpHeaders } from 'node:http';

type HeaderMap = Record<string, string | string[]>;

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'http2-settings',
]);

/** Hop-by-hop headers: the fixed list, `proxy-*`, and any header named in `Connection`. */
function hopByHop(h: IncomingHttpHeaders): (name: string) => boolean {
  const listed = new Set<string>();
  const conn = h.connection;
  for (const v of Array.isArray(conn) ? conn : conn ? [conn] : []) {
    for (const name of v.split(',')) listed.add(name.trim().toLowerCase());
  }
  return (name) => HOP_BY_HOP.has(name) || name.startsWith('proxy-') || listed.has(name);
}

/**
 * Headers towards upstream (spec 5.5): a denylist, so unknown headers and every `anthropic-beta`
 * value pass verbatim. Dropped: hop-by-hop, `host` (set to the upstream host), `content-length`
 * (recomputed by the client from the unchanged body), `expect` (answered by this server),
 * `accept-encoding` (set to `identity` so the tee parses plain text), `x-tokenyard-*`, and in
 * API mode both inbound credential headers, replaced by the provider credential. In passthrough mode
 * the credential headers stay (the OAuth value goes upstream unchanged) except one that carries a tokenyard key.
 */
export function upstreamHeaders(
  inbound: IncomingHttpHeaders,
  opts: {
    mode: 'api' | 'passthrough';
    credential: { header: 'x-api-key' | 'authorization'; value: string } | null;
    host: string;
    /** Passthrough mode: inbound credential headers that carry a tokenyard key, never forwarded. */
    clientKeyHeaders?: ReadonlyArray<'authorization' | 'x-api-key'>;
  },
): HeaderMap {
  const drop = hopByHop(inbound);
  const out: HeaderMap = {};
  for (const [name, value] of Object.entries(inbound)) {
    if (value === undefined) continue;
    if (drop(name) || name === 'host' || name === 'content-length' || name === 'expect' || name === 'accept-encoding') continue;
    if (name.startsWith('x-tokenyard-')) continue;
    if (opts.mode === 'api' && (name === 'authorization' || name === 'x-api-key')) continue;
    if (opts.clientKeyHeaders?.some((h) => h === name)) continue;
    out[name] = value;
  }
  if (opts.mode === 'api' && opts.credential) out[opts.credential.header] = opts.credential.value;
  out.host = opts.host;
  out['accept-encoding'] = 'identity';
  return out;
}

/**
 * Headers towards the client: everything from upstream except hop-by-hop ones (so `retry-after`,
 * `x-should-retry` and `anthropic-ratelimit-unified-*` pass unchanged), with upstream `x-tokenyard-*`
 * replaced by tokenyard's own `extra` headers.
 */
export function clientHeaders(up: IncomingHttpHeaders, extra: Record<string, string>): HeaderMap {
  const drop = hopByHop(up);
  const out: HeaderMap = {};
  for (const [name, value] of Object.entries(up)) {
    if (value === undefined || drop(name) || name.startsWith('x-tokenyard-')) continue;
    out[name] = value;
  }
  return { ...out, ...extra };
}
