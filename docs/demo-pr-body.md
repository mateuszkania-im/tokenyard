Title: Move compaction and auxiliary requests to Haiku, tighten the web team budget

Label: `demo`

## What changes

`examples/pr-demo/policy/policy.yaml` (a copy of `examples/policy`, which the tests use as a fixture), two changes:

1. Two new routes, `claude-code-compaction` and `claude-code-auxiliary`, send compaction and auxiliary requests of
   coding agents to `claude-haiku-5-5`. This rewrites the model on coding-agent traffic, so each route sets
   `allowBodyRewrite: true` and carries a `because:` line, as the policy schema requires.
2. The `team-day` budget drops from 300 USD to 6 USD, sized for the synthetic demo traffic, where only the web team
   spends that much.

## What to look at

The policy replay comment appears only once the Action exists on the base branch (the workflow runs the Action from the
base commit, so a PR cannot change the code that judges it). Once it does, it replays the committed synthetic week (`examples/traces/demo.ndjson.gz`, 3,649 requests) against
the base and this branch and posts one sticky comment. With the current traces it reports (local run, seed 1):

- Cost: -$2.87 (-5.6%), marked as estimated because the model changes.
- 200 requests rerouted (184 auxiliary, 16 compaction).
- 5 sessions of the web team cut mid-task by the tighter `team-day` budget, 117 later requests that would not have run.
- The `ci.failOn.cutSessions: 0` gate fails on purpose: the check is red until the budget is loosened or the cut is
  accepted by changing the gate. That is the point of the demo.

Replay does not say whether Haiku answers compaction well enough: answer quality is never computed.

## Notes for the maintainer

Open this PR against `main` only after the repository is pushed and the Action is enabled. Do not merge it; keep it
open and labelled `demo` so the README GIF and screenshots can be recorded from it.
