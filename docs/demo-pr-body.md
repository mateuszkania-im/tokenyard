Title: Move compaction and auxiliary requests to Haiku

Label: `demo`

This PR is a standing demo of tokenyard's policy CI. It stays open and is never merged.

## What changes

`examples/pr-demo/policy/policy.yaml` (a copy of `examples/policy`, which the tests use as a fixture) gets two new routes, `claude-code-compaction` and `claude-code-auxiliary`. They send compaction and auxiliary requests of coding agents to `claude-haiku-5-5`. This rewrites the model on coding-agent traffic, so each route sets `allowBodyRewrite: true` and carries a `because:` line, as the policy schema requires.

## What to look at

The `policy replay` workflow runs the Action from the base commit, so a PR cannot change the code that judges it. It replays the committed synthetic week (`examples/traces/demo.ndjson.gz`, 3,649 requests from 8 developers in 3 teams) through the base and this branch and posts one sticky comment:

- Cost: -$1.04 (-2.0%), marked as estimated because the model changes.
- 206 requests rerouted (190 auxiliary, 16 compaction).
- No new blocks, no budget hits, 0 sessions cut mid-task, so the `ci.failOn` gates pass and the check is green.

Replay does not say whether Haiku answers compaction well enough: answer quality is never computed.
