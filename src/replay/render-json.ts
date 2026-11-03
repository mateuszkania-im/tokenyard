// `--json` output (docs/replay-json.md, schema version 1). Keys are written in a fixed order, whatever order the result
// object was built in, so the same replay gives byte-identical files. Pure.
import type { ReplayResult, Totals } from './engine.js';

const totals = (t: Totals) => ({ costMicroUsd: t.costMicroUsd, costBasis: t.costBasis, estimated: t.estimated, forwarded: t.forwarded, blocked: t.blocked });

export function renderJson(r: ReplayResult): string {
  const ordered = {
    schemaVersion: r.schemaVersion,
    window: { sinceMs: r.window.sinceMs, untilMs: r.window.untilMs },
    tenant: r.tenant,
    requests: r.requests,
    sessions: r.sessions,
    fidelity: {
      agreement: r.fidelity.agreement,
      disagreements: r.fidelity.disagreements.map((d) => ({ reason: d.reason, count: d.count })),
      missingInstances: r.fidelity.missingInstances.map((m) => ({ instance: m.instance, hours: [...m.hours], kind: m.kind })),
    },
    base: totals(r.base),
    head: totals(r.head),
    rerouted: r.rerouted.map((x) => ({ fromRoute: x.fromRoute, toRoute: x.toRoute, requestClass: x.requestClass, count: x.count })),
    blocked: r.blocked.map((x) => ({ policy: x.policy, reason: x.reason, name: x.name, count: x.count })),
    cutSessions: r.cutSessions.map((c) => ({
      policy: c.policy,
      session: c.session,
      team: c.team,
      repo: c.repo,
      requestClass: c.requestClass,
      requestIndex: c.requestIndex,
      cause: c.cause,
      droppedRequests: c.droppedRequests,
      droppedCostMicroUsd: c.droppedCostMicroUsd,
    })),
    budgetHits: r.budgetHits.map((h) => ({ policy: h.policy, budget: h.budget, scopeValue: h.scopeValue, firstHitTs: h.firstHitTs, days: h.days })),
    exactness: r.exactness.map((e) => ({ output: e.output, exactness: e.exactness, applied: e.applied })),
    gates: { failed: [...r.gates.failed], failOn: { cutSessions: r.gates.failOn.cutSessions, costIncreasePct: r.gates.failOn.costIncreasePct }, headChangesFailOn: r.gates.headChangesFailOn },
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}
