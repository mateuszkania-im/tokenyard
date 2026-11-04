import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import type { CompiledPolicy, Plan, ProviderSpec } from '../policy/types.js';
import type { Breaker } from './breaker.js';
import { forward, type ForwardRequest, SentRequestError, type UpstreamResponse } from './forward.js';
import type { RetryBudget } from './retry-budget.js';

export const MAX_ATTEMPTS = 3;
const RETRYABLE = new Set([500, 502, 503, 504, 529]);
const SPEND_CAP_PROBE_BYTES = 64 * 1024;

/** One upstream attempt, for spans: when it started, when headers arrived (or it failed), and what came back. */
export interface AttemptInfo {
  provider: string;
  startMs: number;
  endMs: number;
  /** Null when no response came (connect error, timeout). */
  status: number | null;
  errorType?: string;
}

export interface ChainDeps {
  /** Called once per attempt as it ends, with wall-clock times. */
  onAttempt?: (a: AttemptInfo) => void;
  breaker: Breaker;
  retry: RetryBudget;
  /** Retry budget scope. */
  tenant: string;
  clock: () => number;
  /** Request headers for one provider (credential and host differ per provider); defaults to `req.headers`. */
  headersFor?: (p: ProviderSpec) => Record<string, string | string[]>;
}

export interface ChainResult {
  /** Attempts made, counting the one that answered (1 = no fallback). */
  attempt: number;
  provider: string;
  response: UpstreamResponse;
}

/**
 * Every attempt failed before any response, or no provider could be tried. `bodySent`: the last attempt failed after
 * its request body was written upstream, so the provider may bill it (the chain stops there, A6).
 */
export class ChainError extends Error {
  constructor(
    readonly attempts: number,
    readonly provider: string | null,
    readonly cause: unknown,
    readonly bodySent = false,
  ) {
    super(cause instanceof Error ? cause.message : 'no provider available');
  }
}

/** Identity of a prompt cache: the endpoint and the credential (an Anthropic workspace is one API key). */
export function workspaceOf(p: ProviderSpec): string {
  return `${new URL(p.baseUrl).origin}|${p.credential === 'passthrough' ? 'passthrough' : p.credential.env}`;
}

// Per process, so a stored breaker key never lets anyone recover or compare credentials across restarts.
const CREDENTIAL_SALT = randomBytes(16);

/**
 * Breaker key for outcomes that belong to one credential (spend-cap 429): the provider plus the credential identity.
 * A configured key is its env name; a passthrough credential (OAuth token or key forwarded from the client) is a
 * salted SHA-256 of the forwarded header values, never kept in clear. One tenant's spend cap or bad token therefore
 * cannot open the breaker for other tenants on the same provider. Provider health (5xx, connect errors) uses the
 * plain provider name instead.
 */
export function credentialBreakerKey(p: ProviderSpec, headers: Record<string, string | string[]>): string {
  if (p.credential !== 'passthrough') return `${p.name}|${workspaceOf(p)}`;
  const h = createHash('sha256').update(CREDENTIAL_SALT);
  for (const name of ['authorization', 'x-api-key']) h.update(`${name}=${String(headers[name] ?? '')};`);
  return `${p.name}|passthrough:${h.digest('hex')}`;
}

/** The response is a spend-cap 429 (`enforced_spend_limit_reached`, no retry-after). Buffers the body, so it returns the response to forward. */
async function checkSpendCap(res: UpstreamResponse): Promise<{ spendCap: boolean; response: UpstreamResponse }> {
  if (res.status !== 429 || res.headers['retry-after'] !== undefined) return { spendCap: false, response: res };
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const c of res.body) {
      const b = c as Buffer;
      chunks.push(b);
      size += b.length;
      if (size > SPEND_CAP_PROBE_BYTES) break;
    }
  } catch {
    // truncated body: treated as not a spend cap, forwarded with what arrived
  }
  const buf = Buffer.concat(chunks);
  return { spendCap: buf.toString('utf8').includes('enforced_spend_limit_reached'), response: { ...res, body: Readable.from([buf]) } };
}

function discard(res: UpstreamResponse): void {
  res.body.on('error', () => undefined);
  res.body.destroy();
}

/**
 * Tries the plan's providers in order, only before any byte reaches the client (spec 8): at most 3 attempts, each
 * beyond the first paid from the tenant's retry budget, skipping providers whose breaker is open. Retryable:
 * connect errors and timeouts before headers, 500, 502, 503, 504, 529, a spend-cap 429 (which also opens that
 * provider's breaker), and any other 429 when the route sets `fallbackOn429`. Everything else, other 4xx included,
 * is returned for the caller to forward unchanged. When the chain or the budget runs out, the last upstream
 * response is returned as it came; a last attempt without a response throws `ChainError`.
 */
export async function runChain(plan: Plan, policy: CompiledPolicy, req: ForwardRequest, signal: AbortSignal, deps: ChainDeps): Promise<ChainResult> {
  const { breaker, retry, tenant, clock } = deps;
  const fallbackOn429 = policy.routes.find((r) => r.name === plan.route)?.fallbackOn429 === true;
  const openMs = policy.failure.breaker.openSeconds * 1000;
  const note = (a: AttemptInfo): void => {
    try {
      deps.onAttempt?.(a);
    } catch {
      // telemetry must not change what the chain does
    }
  };
  retry.request(tenant);

  let attempts = 0;
  let held: ChainResult | null = null; // the last retryable response, returned if nothing better comes
  let lastError: unknown = null;
  let lastProvider: string | null = null;

  for (const entry of plan.chain) {
    if (signal.aborted) {
      if (held) discard(held.response);
      throw new ChainError(attempts, lastProvider, signal.reason ?? new Error('aborted'));
    }
    if (attempts >= MAX_ATTEMPTS) break;
    const provider = policy.providers.get(entry.provider);
    if (!provider) continue;
    const headers = deps.headersFor?.(provider) ?? req.headers;
    const credKey = credentialBreakerKey(provider, headers);
    if (!breaker.allow(provider.name) || !breaker.allow(credKey)) continue;
    if (attempts > 0 && !retry.tryRetry(tenant)) break;

    attempts++;
    lastProvider = provider.name;
    let res: UpstreamResponse;
    const startMs = Date.now(); // span times are wall time, whatever the injected clock is
    try {
      res = await forward(provider, { ...req, headers }, signal);
    } catch (err) {
      const sent = err instanceof SentRequestError;
      note({ provider: provider.name, startMs, endMs: Date.now(), status: null, errorType: signal.aborted ? 'client_abort' : 'upstream_unreachable' });
      if (signal.aborted) {
        if (held) discard(held.response);
        throw new ChainError(attempts, provider.name, err, sent);
      }
      breaker.record(provider.name, false);
      // The provider had the whole request and may be billing it: another provider would bill it again under the
      // same reservation, so the chain ends here (only connect-phase failures fall back, A6).
      if (sent) {
        if (held) discard(held.response);
        throw new ChainError(attempts, provider.name, err, true);
      }
      lastError = err;
      continue;
    }

    note({ provider: provider.name, startMs, endMs: Date.now(), status: res.status });
    const checked = await checkSpendCap(res);
    res = checked.response;
    let retryable = RETRYABLE.has(res.status);
    if (checked.spendCap) {
      breaker.open(credKey, clock() + openMs, 'credential'); // this credential only, never the provider for everyone
      retryable = true;
    } else if (res.status === 429 && fallbackOn429) {
      retryable = true;
    }
    // Only provider-health signals (5xx, 529) count against the provider; 401, 403 and 429 belong to a credential.
    if (!checked.spendCap) breaker.record(provider.name, !RETRYABLE.has(res.status));
    if (!retryable) {
      if (held) discard(held.response);
      return { attempt: attempts, provider: provider.name, response: res };
    }
    if (held) discard(held.response);
    held = { attempt: attempts, provider: provider.name, response: res };
    lastError = null;
  }

  if (held) return { ...held, attempt: attempts }; // attempts made, which can exceed the held response's own attempt
  throw new ChainError(attempts, lastProvider, lastError);
}
