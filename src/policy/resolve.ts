// Spec 6.5 and 5.6: turns a plan and the store's admission into forward or block. Pure.
import type { Admission, BlockReason, CompiledPolicy, Decision, Plan } from './types.js';

/** Claude Code gives up retrying at once when `retry-after` is above 60 seconds (spec 5.6). */
export const MAX_RETRY_AFTER_S = 60;
const STORE_DOWN_RETRY_S = 5;
const STREAMS_RETRY_S = 1;

type Block = NonNullable<Decision['block']>;

const usd = (micro: number): string => `$${(micro / 1_000_000).toFixed(2)}`;
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
      return block(403, 'permission_error', reason, `the model or a server tool has no price in table ${policy.priceTableVersion}, and failure.unpricedModel is block`);
    case 'server-tool-no-max-uses':
      return block(403, 'permission_error', reason, 'a server tool without max_uses has no cost bound under an enforced budget; set max_uses on the tool');
    case 'secret': {
      const rules = [...new Set(plan.taint?.add.map((a) => a.rule) ?? [])].join(', ') || 'a secret rule';
      return block(400, 'invalid_request_error', reason, `the last message contains a secret (rule ${rules}); it was not sent. Remove it, then ${ADVICE}`);
    }
    default:
      return block(403, 'permission_error', reason, `request refused (${reason})`);
  }
}

function failedBlock(plan: Plan, failed: NonNullable<Admission['failed']>): Block {
  switch (failed.kind) {
    case 'budget': {
      const level = plan.reservations.find((r) => r.budget === failed.name);
      const spent = failed.spentMicroUsd === undefined || level === undefined ? '' : ` (spent ${usd(failed.spentMicroUsd)} of ${usd(level.limitMicroUsd)})`;
      const resets = level?.resetsAt ? `; it resets at ${level.resetsAt}` : level ? '; it does not reset (session budget)' : '';
      // No retry-after: that is how Anthropic answers a reached spend cap (spec 5.6).
      return block(429, 'rate_limit_error', 'budget', `budget "${failed.name}" is exhausted${spent}${resets}`);
    }
    case 'rate': {
      const s = rateRetryAfterS(failed.retryAfterMs);
      return block(429, 'rate_limit_error', 'rate', `rate limit "${failed.name}" reached; retry in ${s} s`, s);
    }
    case 'streams':
      return block(429, 'rate_limit_error', 'streams', `concurrent stream limit "${failed.name}" reached`, STREAMS_RETRY_S);
    case 'taint':
      return block(400, 'invalid_request_error', 'taint', `this session's history holds a secret that rule ${failed.rule ?? failed.name} blocked earlier; ${ADVICE}`);
  }
}

export function resolve(policy: CompiledPolicy, plan: Plan, admission: Admission | null): Decision {
  const decision = (b: Block | null): Decision => ({ action: b === null ? 'forward' : 'block', block: b, plan, admission });
  if (plan.preBlock !== null) return decision(preBlock(policy, plan, plan.preBlock));
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
