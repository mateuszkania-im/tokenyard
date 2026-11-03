// Spec 5.3 steps 7 and 8: when the gateway calls the counter store, and whether a plan counts as admitted. The gateway
// handler and replay both run this sequence, so a replayed decision is made the same way as the recorded one. Pure.
import { resolve } from './resolve.js';
import type { Admission, CompiledPolicy, Decision, Plan } from './types.js';

/** Whether admit has anything to check or write for this plan: a level, a rate check, a stream slot or taint. */
export function holdsCounters(plan: Plan): boolean {
  const t = plan.taint;
  return plan.reservations.length + plan.rateChecks.length + plan.streamSlots.length > 0 || (t !== null && t.check.length + t.add.length > 0);
}

/**
 * Before admit: the decision without counters (`pre`), whether a last-turn secret must still write the session taint,
 * and whether admit is called at all. Blocks that need no counters (pre-blocks, a reservation larger than its limit on
 * its own) are answered without a store call; a plan that holds nothing never reaches the store.
 */
export function planAdmission(policy: CompiledPolicy, plan: Plan): { pre: Decision; taintWrite: boolean; callsAdmit: boolean } {
  const pre = resolve(policy, plan, null);
  const taintWrite = plan.preBlock === 'secret' && (plan.taint?.add.length ?? 0) > 0;
  return { pre, taintWrite, callsAdmit: taintWrite || (pre.block === null && holdsCounters(plan)) };
}

/** Whether admit took a reservation (and slots) that settle must release. */
export function isAdmitted(plan: Plan, admission: Admission | null): boolean {
  return admission?.admitted === true && admission.storeDown !== true && plan.preBlock === null;
}

/**
 * What a request whose cost cannot be read (no final usage, an unpriced answer) is charged: its reservation, or the
 * worst-case estimate when that is higher (A2-2: the session-aware estimator reserves one sampling iteration and no
 * server tool fees, so a client that drops a stream before its final usage would choose its own discount).
 */
export function atEstimateCharge(plan: Plan | null, est: number): number {
  return (plan?.reservations.length ?? 0) > 0 ? Math.max(est, plan?.worstCaseMicroUsd ?? 0) : est;
}
