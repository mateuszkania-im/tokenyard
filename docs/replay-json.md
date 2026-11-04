# Replay JSON, schema version 1

`tokenyard policy replay --json replay.json` writes the full result of a replay. The terminal report and the pull
request comment are views of the same object. The same traces and the same two policies always give a byte-identical
file: keys are written in the order below, arrays are sorted as described, and money is integer micro-USD.

```sh
tokenyard traces export --trace-dir traces --since 7d --out traces.ndjson.gz
tokenyard policy replay --base-ref main --head policy --traces traces.ndjson.gz --json replay.json
```

`--base-ref <ref>` reads the base as the `--head` directory's files committed at that git ref, always as git objects:
a directory in the working tree named like the ref is never consulted. A ref starting with `-` is refused, and any
other is resolved to a commit with `git rev-parse --verify` before its files are read; git runs with an environment
built from scratch and replace objects off. `--base-dir <dir>` reads the base from a policy directory. `--base` is
kept as an alias that takes either, and refuses a value that is both a directory and a git ref. Replay refuses a directory of
raw per-instance trace files and names `tokenyard traces export`: a partial set would undercount budgets. The command
exits 1 when a `ci.failOn` gate fails; each threshold is the stricter of the base and the head policy.

## Top level

| Key | Type | Meaning |
|---|---|---|
| `schemaVersion` | `1` | This document. |
| `window` | `{ sinceMs, untilMs }` | The replayed window, ms since epoch. `sinceMs` is `--since`, else the export's `since`. Records before it only seed budget windows (warm-up). |
| `tenant` | string or null | `--tenant`, or null for every tenant. |
| `requests` | number | Request records in the window. |
| `sessions` | number | Distinct session pseudonyms among them. |
| `fidelity` | object | See below. |
| `base`, `head` | Totals | See below. |
| `rerouted` | array | Requests both policies forward, on another route, provider or model under the head. |
| `blocked` | array | Blocks per policy, reason and name. |
| `cutSessions` | array | Sessions a policy cut mid-task. |
| `budgetHits` | array | Budget levels that blocked at least once. |
| `exactness` | array | The rows of the exactness table and whether each applied to this run. |
| `gates` | `{ failed: string[], failOn: { cutSessions, costIncreasePct }, headChangesFailOn: boolean }` | `failed`: the `ci.failOn` gates that failed, for example `ci.failOn.cutSessions: 0`, empty when the check passes. `failOn`: the thresholds the check used, for each one the stricter of the base and the head policy, so a pull request cannot loosen its own gate. `headChangesFailOn`: the head's `ci.failOn` differs from the base's. |

## `fidelity`

- `agreement`: fraction (0 to 1) of compared requests whose base replay reproduced the recorded decision: action,
  block reason, route and provider order. Compared are the requests recorded under the base policy's revision, except
  those that ended before a decision (`decision.preDecision` in the trace). When none was recorded under that revision,
  `agreement` is 0 and `disagreements` says so.
- `disagreements`: `{ reason, count }`, most frequent first, for example
  `recorded block (budget), replayed forward` (counter state missing at the start of the window, dropped traces, or
  retries the trace cannot see).
- `missingInstances`: `{ instance, hours, kind }` from the export manifest, sorted by instance, then kind. `hours` are
  UTC hours as `YYYY-MM-DDTHH`. Kinds: `no-file` (the instance ran in an hour for which the set holds no file of it),
  `seq-gap` (dropped records; the hours between the records around each gap), `heartbeats-stop` (no `shutdown` record
  and the last sign of life is more than 120 s before the window ends). A set without a manifest is not checked.

A low agreement or any missing instance means the diff should not be trusted.

## Totals (`base`, `head`)

| Key | Meaning |
|---|---|
| `costMicroUsd` | Cost of the requests the policy forwards. |
| `costBasis` | `billed`, `api-equivalent` (subscription keys) or `mixed`. |
| `estimated` | True when any forwarded request's cost is an estimate: another model or provider than recorded, a price table that cannot price the recorded tokens, or a request blocked when recorded (no usage exists; counted at zero). |
| `forwarded`, `blocked` | Request counts. Requests that ended outside the policy (before a decision, or a body the gateway could not rewrite or redact) and requests dropped after a cut are in neither. |

## Arrays

- `rerouted`: `{ fromRoute, toRoute, requestClass, count }`, most frequent first. When the route name stays and the
  provider or model changes, each side reads `route (provider, model)`.
- `blocked`: `{ policy, reason, name, count }`, base first, then most frequent. `reason` is the policy block reason
  (`no-route`, `model-not-allowed`, `server-tool-not-allowed`, `server-tool-no-max-uses`, `secret`, `taint`,
  `budget`, `rate`, `streams`, `store-down`, `unpriced`, `duplicate`); `name` is the budget, limit or rule, the model, or the
  server tool types, and empty when there is none.
- `cutSessions`: `{ policy, session, team, repo, requestClass, requestIndex, cause, droppedRequests,
  droppedCostMicroUsd }`, base first, then in time order. A session is cut when the policy blocks a request the gateway
  forwarded, after one of the session's earlier requests was forwarded under that policy. A block the recording also had
  is not a cut, because the recorded session went on after it. `requestIndex` is 1-based among the session's requests
  in the window; the later requests are dropped (assumption: the agent stops) and counted with their recorded cost.
- `budgetHits`: `{ policy, budget, scopeValue, firstHitTs, days }`, sorted by policy, budget and scope value. `days`
  counts distinct UTC days with a block on that level.
- `exactness`: `{ output, exactness, applied }` in the order of the table in [replay.md](replay.md). `exactness` is `exact`,
  `exact-given-assumptions`, `estimated`, `not-computed` or `never`.

## How the simulation runs

Each policy runs on its own in-memory counter store on a virtual clock. Records are admitted in the order the
gateway's store saw them: at `ts` plus the recorded `decision.admitOffsetMs` (the body is read and scanned before
admit, so a large body can admit after a small one that started later), then by instance, `decision.seqEpoch` and
`decision.admitSeq`, then
by `ts` and `id`. Each is decided, admitted and resolved as the gateway does it (the same `src/policy/admission.ts`), from the features and guardrail hits the trace recorded
(the input bound and its kind are used as recorded, never derived again), and settled at `ts + totalMs`. Within one
process epoch, against the admits of its own process (same instance and `decision.seqEpoch`, a random id of the
writing process), a settle is ordered by `outcome.settleSeq`, the admits the process had issued when it called settle:
`totalMs` is measured before settle, so a later admit can share its millisecond. The count starts again when a
process restarts while `--instance-id` may be reused, so across process epochs, across instances, and in traces
written without these fields the time alone decides. A record whose
admit found the store down is replayed with the store down. A count_tokens record passes the request-rate limits only
when it carries `decision.countTokensRateChecked` (written since count_tokens takes a rate token at the gateway);
an older one took none when served and replays outside the rate limits. Settlement charges what the gateway charged
(`outcome.chargedMicroUsd`) when the model, provider and price table are unchanged; the policy's reservation when the
request was settled at its estimate or by the sweeper; otherwise the replayed cost.

Cost under another model scales output tokens by the ratio of the mean output of the two models for the same request
class in the traces (kept equal when either was never observed), and prices the cache reads of the first switched
request of each session as 5m cache writes. Requests without a session id are not converted.
