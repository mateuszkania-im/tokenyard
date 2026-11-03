// Spec 6.5 and 5.6: turns a plan and the store's admission into forward or block. Pure.
import type { Admission, BlockReason, CompiledPolicy, Decision, Plan } from './types.js';

/** Claude Code gives up retrying at once when `retry-after` is above 60 seconds (spec 5.6). */
export const MAX_RETRY_AFTER_S = 60;
const STORE_DOWN_RETRY_S = 5;
const STREAMS_RETRY_S = 1;

type Block = NonNullable<Decision['block']>;

/** Dollars with cents; an amount under one cent shows its micro-dollars, so a small limit never reads as $0.00. */
export const usd = (micro: number): string => {
  const d = micro / 1_000_000;
  return micro > 0 && micro < 10_000 ? `$${d.toFixed(6).replace(/0+$/, '')}` : `$${d.toFixed(2)}`;
};
const ADVICE = 'run /clear to drop it from the conversation, rotate the secret, and add a deny rule for the file it came from';

/** Whole seconds from 1 to 60; anything not finite waits the longest allowed. */
export function rateRetryAfterS(ms: number | undefined): number {
  if (ms === undefined || !Number.isFinite(ms)) return MAX_RETRY_AFTER_S;
  return Math.min(MAX_RETRY_AFTER_S, Math.max(1, Math.ceil(ms / 1000)));
}

function block(status: Block['status'], type: string, reason: BlockReason, message: string, retryAfterS: number | null = null): Block {
  return { status, type, reason, message, retryAfterS };
}

function preBlock(policy: CompiledPolicy, plan: Plan, reason: BlockReason): Block {
  const route = plan.route === null ? '' : ` on route "${plan.route}"`;
  switch (reason) {
    case 'no-route':
      return block(403, 'permission_error', reason, `no route in policy ${policy.revision} allows this request`);
    case 'model-not-allowed':
      return block(403, 'permission_error', reason, `this model is not allowed${route}`);
    case 'unpriced':
      return block(403, 'permission_error', reason, `the model, its service tier or a server tool has no price in table ${policy.priceTableVersion}${policy.failure.unpricedModel === 'block' ? ', and failure.unpricedModel is block' : ''}`);
    case 'server-tool-no-max-uses':
      return block(403, 'permission_error', reason, 'a server tool without max_uses has no cost bound under an enforced budget; set max_uses on the tool');
    case 'server-tool-not-allowed': {
      const types = [...new Set(plan.warnings.flatMap((w) => (w.kind === 'server-tool-not-allowed' ? [w.type] : [])))].join(', ');
      return block(403, 'permission_error', reason, `server tool ${types || 'type'} is not allowed${route}; list it under the route's serverTools`);
    }
    case 'secret': {
      const add = plan.taint?.add ?? [];
      const rules = [...new Set(add.map((a) => a.rule))].join(', ') || 'a secret rule';
      const at = add.find((a) => a.message !== undefined)?.message;
      const where = at === undefined ? 'the last message' : `the last message (message ${at})`;
      return block(400, 'invalid_request_error', reason, `${where} contains a secret (rule ${rules}); it was not sent. Remove it, then ${ADVICE}`);
    }
    default:
      return block(403, 'permission_error', reason, `request refused (${reason})`);
  }
}

function failedBlock(plan: Plan, failed: NonNullable<Admission['failed']>): Block {
  switch (failed.kind) {
    case 'budget': {
      const level = plan.reservations.find((r) => r.budget === failed.name);
      const spent = failed.spentMicroUsd === undefined || level === undefined ? '' : ` (spent ${usd(failed.spentMicroUsd)} of ${usd(level.limitMicroUsd)}; this request's reservation is ${usd(level.estMicroUsd)})`;
      const idle = plan.sessionIdleTtlMs === undefined ? null : Math.round(plan.sessionIdleTtlMs / 3_600_000);
      const resets = level?.resetsAt ? `; it resets at ${level.resetsAt}` : level ? `; a session budget resets only after the session is idle for ${idle ?? 24} h` : '';
      // No retry-after: that is how Anthropic answers a reached spend cap (spec 5.6).
      return block(429, 'rate_limit_error', 'budget', `budget "${failed.name}" is exhausted${spent}${resets}`);
    }
    case 'rate': {
      const s = rateRetryAfterS(failed.retryAfterMs);
      return block(429, 'rate_limit_error', 'rate', `rate limit "${failed.name}" reached; retry in ${s} s`, s);
    }
    case 'streams':
      return block(429, 'rate_limit_error', 'streams', `concurrent stream limit "${failed.name}" reached`, STREAMS_RETRY_S);
    case 'taint': {
      const at = failed.valueHmac === undefined ? undefined : plan.taint?.messages?.[failed.valueHmac];
      const where = at === undefined ? '' : ` (message ${at})`;
      return block(400, 'invalid_request_error', 'taint', `this session's history${where} holds a secret that rule ${failed.rule ?? failed.name} blocked earlier; ${ADVICE}`);
    }
    case 'sessions': {
      const limit = plan.newSession?.burst;
      return block(429, 'rate_limit_error', 'session-churn', `this key started more than ${limit ?? 'its limit of'} new sessions per hour (sessions.newPerKeyPerHour); continue in a session it already uses, or ask the policy owner to raise the limit`);
    }
    case 'duplicate':
      // A second admit under an id that already holds a reservation: never forwarded on the first one's reservation.
      return block(409, 'invalid_request_error', 'duplicate', `request id ${plan.id} already holds a reservation; it was not sent again`);
  }
}

/**
 * An enforced level whose limit is below this request's own reservation: no amount of waiting admits it, so it is
 * refused before the store is asked and nothing is reserved (spec 7.4 premise: each reservation fits on its own).
 */
export function oversizedReservation(plan: Plan): Plan['reservations'][number] | null {
  return plan.reservations.find((r) => r.enforce && r.estMicroUsd > r.limitMicroUsd) ?? null;
}

export function resolve(policy: CompiledPolicy, plan: Plan, admission: Admission | null): Decision {
  const decision = (b: Block | null): Decision => ({ action: b === null ? 'forward' : 'block', block: b, plan, admission });
  if (plan.preBlock !== null) return decision(preBlock(policy, plan, plan.preBlock));
  const big = oversizedReservation(plan);
  if (big !== null) {
    // No retry-after: retrying cannot help (spec 5.6 budget answer).
    const msg = `this request's reservation of ${usd(big.estMicroUsd)} is larger than budget "${big.budget}" allows in total (${usd(big.limitMicroUsd)}); lower max_tokens or the context sent, or raise the budget`;
    return decision(block(429, 'rate_limit_error', 'budget', msg));
  }
  if (admission === null) return decision(null);
  if (admission.storeDown) {
    const down = policy.failure.counterStoreDown;
    const budgets = down.budgets === 'closed' && plan.reservations.some((r) => r.enforce);
    const rates = down.rateLimits === 'closed' && plan.rateChecks.length + plan.streamSlots.length > 0;
    return decision(budgets || rates ? block(503, 'api_error', 'store-down', 'the counter store is unreachable and this policy fails closed', STORE_DOWN_RETRY_S) : null);
  }
  if (admission.failed !== null) return decision(failedBlock(plan, admission.failed));
  // Refused without a reason: fail closed.
  return decision(admission.admitted ? null : block(503, 'api_error', 'store-down', 'admission was refused without a reason', STORE_DOWN_RETRY_S));
}
