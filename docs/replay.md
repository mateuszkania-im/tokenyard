# What replay can and cannot tell you

`tokenyard policy replay` (see [usage](usage.md#8-replay-every-policy-change-in-ci) for the CI Action) runs the base policy and the head policy separately over one merged trace export, each with its own simulated counter store on a virtual clock, and diffs head against base. The decision function is pure and takes every input from the trace, which is what makes this possible. Replay answers who, where and how much; it never answers how good.

| Output | Exactness | Why |
|---|---|---|
| Route and provider per request, model allowlist blocks, guardrail blocks for rules that fired at record time | **Exact** | Pure function of recorded features |
| Budget hits, rate-limit blocks, session cuts | **Exact given the simulation's assumptions**: when cost is exact; a cut session stops; a rate-limited request is not retried | Counter state is rebuilt from the replay itself; Claude Code's retries after a 429 cannot be simulated |
| Cost delta when the model does not change (price table change, budget change) | **Exact** | Same tokens, different prices or admissions |
| Cost delta when the model changes | **Estimated** | Output tokens of a model that never ran are unknown: scaled by the per-model, per-request-class output ratio observed in the traces, or kept equal and flagged when no data exists |
| Cache effect of a model or provider switch within a session | **Estimated** | From the first switched request, all recorded cache reads of that session become 5m cache writes at the new model's price for one request, then the recorded hit pattern resumes. Caches are per workspace and per model ([Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)) |
| A new guardrail rule | **Not computed** | Traces hold no content; the comment says "new secret rules cannot be replayed" |
| Latency | **Not computed in v0.1** | Would need per-provider distributions; listed as future work |
| Answer quality | **Never** | Logs hold no outcome for routes not taken; offline replay is unbiased only when the logging policy chose at random ([Li et al., WSDM 2011](https://arxiv.org/abs/1003.5956)) |

**Fidelity.** Every comment starts with a fidelity line: for the records traced under the base revision, replaying the base must reproduce the recorded decision, and the agreement rate is printed with the reasons for any disagreement (missing counter state at the start of the window, dropped traces, retries the trace cannot see). The check also lists missing instances: an instance that was running during an hour for which the export has no file of it, sequence gaps (dropped records), and an instance whose heartbeats stop without a shutdown record. A low rate or a missing instance means the diff should not be trusted. Replay is deterministic: the same traces and policies give byte-identical JSON and Markdown.

**Admit order.** Replay admits requests in the order the gateway admitted them: each trace records when admit ran (`admitOffsetMs`) and the instance's admit sequence number (`admitSeq`), and when the request released what it held, how many admits the process had issued (`settleSeq`), with a random id of the process (`seqEpoch`), since the count restarts with the process while an instance id may be reused. Within one process of an instance that order is exact; across a restart it follows the recorded times. Across several instances sharing Redis it is only approximated, because the instances' clocks and the Redis server's commit order are not recorded together; a burst that hits a budget across instances can replay in a slightly different order than Redis applied it, which shows up as fidelity below 100%.

`policy replay` refuses a raw trace directory and asks for `traces export`, because a partial set would undercount budgets. Budget windows that started before `--since` are seeded from the recorded spend; session taint from before `--since` is not rebuilt.
