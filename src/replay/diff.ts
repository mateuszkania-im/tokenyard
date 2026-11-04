// Spec 9.3 and 9.4: how exact each replay output is, and what the head policy changes against the base. Pure.

/**
 * The exactness table of spec 9.3, verbatim. docs/replay.md carries the same text (a test compares them), and every
 * replay result lists its rows with whether they applied to that run.
 */
export const EXACTNESS_TABLE = `| Output | Exactness | Why |
|---|---|---|
| Route and provider per request, model allowlist blocks, guardrail blocks for rules that fired at record time | **Exact** | Pure function of recorded features |
| Budget hits, rate-limit blocks, session cuts | **Exact given the simulation's assumptions**: when cost is exact; a cut session stops; a rate-limited request is not retried | Counter state is rebuilt from the replay itself; Claude Code's retries after a 429 cannot be simulated |
| Cost delta when the model does not change (price table change, budget change) | **Exact** | Same tokens, different prices or admissions |
| Cost delta when the model changes | **Estimated** | Output tokens of a model that never ran are unknown: scaled by the per-model, per-request-class output ratio observed in the traces, or kept equal and flagged when no data exists |
| Cache effect of a model or provider switch within a session | **Estimated** | From the first switched request, all recorded cache reads of that session become 5m cache writes at the new model's price for one request, then the recorded hit pattern resumes. Caches are per workspace and per model ([Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)) |
| A new guardrail rule | **Not computed** | Traces hold no content; the comment says "new secret rules cannot be replayed" |
| Latency | **Not computed in v0.1** | Would need per-provider distributions; listed as future work |
| Answer quality | **Never** | Logs hold no outcome for routes not taken; offline replay is unbiased only when the logging policy chose at random ([Li et al., WSDM 2011](https://arxiv.org/abs/1003.5956)) |`;

export type Exactness = 'exact' | 'exact-given-assumptions' | 'estimated' | 'not-computed' | 'never';

/** The rows of EXACTNESS_TABLE: the output column as written, and the exactness it states. */
export const EXACTNESS_ROWS: ReadonlyArray<{ output: string; exactness: Exactness }> = EXACTNESS_TABLE.split('\n')
  .slice(2)
  .map((line) => {
    const [output = '', stated = ''] = line.slice(2).split(' | ');
    const exactness: Exactness = stated.startsWith('**Exact given')
      ? 'exact-given-assumptions'
      : stated.startsWith('**Exact**')
        ? 'exact'
        : stated.startsWith('**Estimated')
          ? 'estimated'
          : stated.startsWith('**Not computed')
            ? 'not-computed'
            : 'never';
    return { output, exactness };
  });

/** Which rows of the table a run touched, in table order. */
export interface Applied {
  routes: boolean;
  counters: boolean;
  costSameModel: boolean;
  costModelChange: boolean;
  cacheSwitch: boolean;
  guardrailChange: boolean;
  /** Some request was sent to another provider or model: latency and answer quality would differ, and are not computed. */
  switched: boolean;
}

export function exactnessRows(a: Applied): Array<{ output: string; exactness: Exactness; applied: boolean }> {
  const flags = [a.routes, a.counters, a.costSameModel, a.costModelChange, a.cacheSwitch, a.guardrailChange, a.switched, a.switched];
  return EXACTNESS_ROWS.map((row, i) => ({ output: row.output, exactness: row.exactness, applied: flags[i] ?? false }));
}

/** Total order on strings that does not depend on the locale. */
export const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Counts grouped by a key built from `parts`; the first item of each group is kept for its fields. */
export function countBy<T>(items: readonly T[], parts: (x: T) => readonly string[]): Array<{ item: T; count: number }> {
  const groups = new Map<string, { item: T; count: number }>();
  for (const x of items) {
    const k = parts(x).join('\u0000');
    const g = groups.get(k);
    if (g) g.count++;
    else groups.set(k, { item: x, count: 1 });
  }
  return [...groups.values()];
}

export interface FailOn {
  cutSessions: number;
  costIncreasePct: number;
}

/**
 * The thresholds the gate uses (C3): for each one the stricter of the base and the head policy, so the pull request
 * under test cannot loosen its own gate. `changed` says whether the head's ci.failOn differs from the base's.
 */
export function gateThresholds(base: FailOn, head: FailOn): { failOn: FailOn; changed: boolean } {
  return {
    failOn: { cutSessions: Math.min(base.cutSessions, head.cutSessions), costIncreasePct: Math.min(base.costIncreasePct, head.costIncreasePct) },
    changed: base.cutSessions !== head.cutSessions || base.costIncreasePct !== head.costIncreasePct,
  };
}

/**
 * CI gates (spec 9.5): more cut sessions than `ci.failOn.cutSessions`, or a cost increase above
 * `ci.failOn.costIncreasePct` percent (any increase from a zero base counts).
 */
export function failedGates(failOn: FailOn, o: { headCuts: number; baseCost: number; headCost: number }): string[] {
  const failed: string[] = [];
  if (o.headCuts > failOn.cutSessions) failed.push(`ci.failOn.cutSessions: ${failOn.cutSessions}`);
  const increase = o.baseCost === 0 ? (o.headCost > 0 ? Number.POSITIVE_INFINITY : 0) : ((o.headCost - o.baseCost) / o.baseCost) * 100;
  if (increase > failOn.costIncreasePct) failed.push(`ci.failOn.costIncreasePct: ${failOn.costIncreasePct}`);
  return failed;
}
