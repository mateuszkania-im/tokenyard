import { Readable } from 'node:stream';
import type { CompiledPolicy, Plan, ProviderSpec } from '../policy/types.js';
import type { Breaker } from './breaker.js';
import { forward, type ForwardRequest, type UpstreamResponse } from './forward.js';
import type { RetryBudget } from './retry-budget.js';

export const MAX_ATTEMPTS = 3;
const RETRYABLE = new Set([500, 502, 503, 504, 529]);
const SPEND_CAP_PROBE_BYTES = 64 * 1024;

export interface ChainDeps {
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

/** Every attempt failed before any response, or no provider could be tried. */
export class ChainError extends Error {
  constructor(
    readonly attempts: number,
    readonly provider: string | null,
    readonly cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : 'no provider available');
  }
}

/** Identity of a prompt cache: the endpoint and the credential (an Anthropic workspace is one API key). */
export function workspaceOf(p: ProviderSpec): string {
  return `${new URL(p.baseUrl).origin}|${p.credential === 'passthrough' ? 'passthrough' : p.credential.env}`;
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
    if (!provider || !breaker.allow(provider.name)) continue;
    if (attempts > 0 && !retry.tryRetry(tenant)) break;

    attempts++;
    lastProvider = provider.name;
    let res: UpstreamResponse;
    try {
      res = await forward(provider, { ...req, headers: deps.headersFor?.(provider) ?? req.headers }, signal);
    } catch (err) {
      if (signal.aborted) {
        if (held) discard(held.response);
        throw new ChainError(attempts, provider.name, err);
      }
      breaker.record(provider.name, false);
      lastError = err;
      continue;
    }

    const checked = await checkSpendCap(res);
    res = checked.response;
    let retryable = RETRYABLE.has(res.status);
    if (checked.spendCap) {
      breaker.open(provider.name, clock() + openMs);
      retryable = true;
    } else if (res.status === 429 && fallbackOn429) {
      retryable = true;
    }
    if (!checked.spendCap) breaker.record(provider.name, !RETRYABLE.has(res.status));
    if (!retryable) {
      if (held) discard(held.response);
      return { attempt: attempts, provider: provider.name, response: res };
    }
    if (held) discard(held.response);
    held = { attempt: attempts, provider: provider.name, response: res };
    lastError = null;
  }

  if (held) return held;
  throw new ChainError(attempts, lastProvider, lastError);
}
