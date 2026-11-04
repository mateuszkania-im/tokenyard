import type { Surface } from '../policy/types.js';

export type RouteMatch = { surface: Surface | 'models' | 'hello'; pathAndQuery: string };

/** Canonical upstream paths, keyed by the path after the base path and an optional `/v1` mount prefix. */
/**
 * `inference` is stated per route, never derived: it marks the paths that run a model and so go through admission
 * (spec 7.4 coverage). count_tokens is forwarded without a reservation (spec 5.3); models is answered by tokenyard.
 */
const ROUTES: ReadonlyArray<{ methods: readonly string[]; path: string; surface: RouteMatch['surface']; canonical: string; inference: boolean }> = [
  { methods: ['POST'], path: '/messages', surface: 'anthropic-messages', canonical: '/v1/messages', inference: true },
  { methods: ['POST'], path: '/messages/count_tokens', surface: 'anthropic-count-tokens', canonical: '/v1/messages/count_tokens', inference: false },
  { methods: ['GET'], path: '/models', surface: 'models', canonical: '/v1/models', inference: false },
  // Codex appends /responses to its base_url, which carries /v1 (spec 3 step 6, 5.4). OpenAI provider base URLs carry
  // /v1 as well (https://api.openai.com/v1), so the upstream path is /responses after it.
  { methods: ['POST'], path: '/responses', surface: 'openai-responses', canonical: '/responses', inference: true },
];

/**
 * Every method and client path (with the `/v1` prefix; served without it too) the gateway answers, with its
 * `inference` flag and surface (a test sends a request down each one).
 */
export const ROUTE_TABLE: ReadonlyArray<{ method: string; path: string; inference: boolean; surface: RouteMatch['surface'] }> = [
  ...ROUTES.flatMap((r) => r.methods.map((method) => ({ method, path: `/v1${r.path}`, inference: r.inference, surface: r.surface }))),
  { method: 'HEAD', path: '/api/hello', inference: false, surface: 'hello' },
  { method: 'GET', path: '/api/hello', inference: false, surface: 'hello' },
];

/**
 * Match on the path, never the full URL; the query is kept verbatim (`/v1/messages?beta=true`).
 * The optional base path is stripped first. Paths are accepted with or without the `/v1` prefix,
 * so a base URL that already ends in `/v1` works too; upstream always gets the canonical `/v1/...` path.
 */
export function matchRoute(method: string, rawUrl: string, basePath: string | null): RouteMatch | null {
  const q = rawUrl.indexOf('?');
  let path = q === -1 ? rawUrl : rawUrl.slice(0, q);
  const query = q === -1 ? '' : rawUrl.slice(q);
  const base = basePath?.replace(/\/+$/, '') ?? '';
  if (base !== '') {
    if (path !== base && !path.startsWith(`${base}/`)) return null;
    path = path.slice(base.length);
  }
  if ((method === 'HEAD' || method === 'GET') && path === '/api/hello') return { surface: 'hello', pathAndQuery: path + query };
  const bare = path.startsWith('/v1/') ? path.slice(3) : path;
  const r = ROUTES.find((x) => x.path === bare && x.methods.includes(method));
  return r ? { surface: r.surface, pathAndQuery: r.canonical + query } : null;
}
