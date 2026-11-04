# Quality evaluation: designed, not built

Replay answers who, where and how much. It never answers how good: the traces hold no outcome for routes that were not taken, and offline replay of a logged policy is unbiased only when the logging policy chose at random ([Li et al., WSDM 2011](https://arxiv.org/abs/1003.5956)). So when a policy change moves traffic from one model to another (the demo moves compaction and auxiliary requests to a cheaper model), the replay comment shows the estimated cost and says nothing about whether the cheaper model answers well enough.

This page describes the two tiers that would answer that question. Neither is built in v0.1, and nothing in the README claims otherwise (design spec, section 9.6).

## Tier 1: a golden set of coding tasks

A fixed set of coding tasks, each with a repository snapshot and a check, run through both routes (the base policy's model and the head policy's model) with the same client version.

- **Deterministic checks first.** The tests pass after the agent's change; the diff applies; the build and lint succeed. These need no judge and are the main signal.
- **Pairwise judgement second.** Where checks cannot decide (two passing solutions of different quality, or a summary), an LLM judge compares the two answers pairwise. Judges reach over 80% agreement with human raters but have position and verbosity bias ([Zheng et al., 2023](https://arxiv.org/abs/2306.05685)), so every pair is judged twice with the positions swapped and a disagreement between the two orders counts as a tie.
- **Where it runs.** As a second, optional job next to the replay job in the policy pull request, only when the head policy changes a model on some route. Its spend goes through a tokenyard budget like any other traffic.
- **What the comment would show.** Pass rate per route on both sides with the number of tasks, and the judge's win, tie and loss counts, next to the replay's cost delta. A small task set gives a wide interval; the comment would show the counts, not a single score.

## Tier 2: shadow traffic

A small share of live requests (1 to 5%) on a route whose model the head policy would change is also sent to the candidate model, after the client's own response is complete, and both answers are kept for comparison.

- **Noise first.** Before comparing two models, send a second sample of the known route on the same requests to measure how much the same model differs from itself, as Twitter's Diffy does for services ([Diffy](https://blog.twitter.com/2015/diffy-testing-services-without-writing-tests)). A difference between models smaller than that noise means nothing.
- **Charged through the same budgets.** Shadow calls go through the same admit call and budgets as the traffic they shadow, so they cannot bypass accounting; that bypass is a known failure in other routers ([tas-llm-router #184](https://github.com/Tributary-ai-services/tas-llm-router/issues/184)).
- **Content.** Shadowing needs the request content, which traces deliberately never hold. It would need an explicit, per-route opt-in with its own retention, and it would never apply to coding-agent traffic by default.

## Why not in v0.1

Both tiers need content (the tasks, or shadowed requests and their answers), a place to keep it, and money to run models; v0.1 keeps traces content-free and its live spend under a hard cap. The replay comment's "How exact is this" table states "Answer quality: Never" for that reason.
