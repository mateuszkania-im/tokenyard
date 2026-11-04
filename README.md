# tokenyard

[![ci](https://github.com/mateuszkania-im/tokenyard/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/mateuszkania-im/tokenyard/actions/workflows/ci.yml)

Policy CI for coding-agent traffic.

tokenyard is an open-source LLM gateway in TypeScript for Claude Code, Codex and product AI features. In the request path it only does mechanism: it forwards the agent's bytes unchanged, enforces budgets, rate limits, model allowlists and secret guardrails, attributes every request to a tenant, team, developer key, repo, session, subagent and request class, and writes a decision trace. Outside the request path, the policy is a YAML file in git, and every pull request that changes it gets a comment computed by replaying recorded traffic through the proposed policy: which requests would route elsewhere, which would be blocked, which budgets would be hit, the cost delta, and how many agent sessions would have been cut off mid-task.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/demo-comment-dark.png">
  <img alt="The policy replay comment for the demo policy change: cost -5.6% (estimated), 200 requests rerouted, 5 sessions cut mid-task by a tighter team budget, check failed on purpose" src="docs/demo-comment-light.png" width="720">
</picture>

The image is the comment for the bundled demo change (`tokenyard demo`: `examples/policy` against `examples/policy-head`), which also tightens a team budget, so its check fails: five sessions would be cut mid-task and the policy says `ci.failOn.cutSessions: 0`.

See it live: [pull request #2](https://github.com/mateuszkania-im/tokenyard/pull/2) is a standing demo, never merged. It only moves compaction and auxiliary requests to Haiku; the `policy replay` workflow replays the committed synthetic week (`examples/traces/demo.ndjson.gz`, 3,649 requests from 8 developers in 3 teams) through both policies and comments: cost -2.0% (estimated), 206 requests rerouted, no sessions cut, check green. The traffic is synthetic; real sessions, anonymized, are in [Real sessions](#real-sessions).

## Quick start

No API key is needed: both paths run against deterministic mock providers.

```sh
# One process, no Docker, Node 20.19 or later: 7 days of synthetic traffic from 8 developers in 3 teams
# through the gateway, then a replay of the demo policy change. bin/tokenyard.mjs is the committed bundle.
git clone https://github.com/mateuszkania-im/tokenyard && cd tokenyard
node bin/tokenyard.mjs demo

# Docker Compose 2.20 or later: mock providers, the gateway, the traffic generator, then the replay report.
docker compose up --build --abort-on-container-exit --exit-code-from traffic
docker compose --profile redis up --build --abort-on-container-exit --exit-code-from traffic   # two gateways sharing budgets through Redis
docker compose --profile otel up --build --abort-on-container-exit --exit-code-from traffic    # OTel collector and Jaeger on http://localhost:16686
```

Running it for real:

```sh
tokenyard policy check policy                                  # schema and semantic rules; exits 1 on errors
tokenyard keys create --tenant acme --team web --name alice --file policy/keys.yaml   # prints the key once, stores its SHA-256
export TOKENYARD_TRACE_SALT=...                                # secrets come from the environment or a --*-file, never a flag
tokenyard serve --policy policy --trace-dir traces
tokenyard serve --policy policy --store redis --redis-url-file /run/secrets/redis-url --trace-dir traces
tokenyard serve --policy policy --store redis --redis-url-file /run/secrets/redis-url --trace-dir traces --workers 3   # 3 processes, one port
tokenyard traces export --since 7d --trace-dir traces --out traces.ndjson.gz
tokenyard policy replay --base-ref main --head policy --traces traces.ndjson.gz
tokenyard report --traces traces.ndjson.gz --by team,repo --html report.html
```

The provider keys are read from the environment variables the policy names (`credential: { env: ANTHROPIC_API_KEY }`); developers never see them.

## Point Claude Code and Codex at it

Claude Code, two lines per developer:

```sh
export ANTHROPIC_BASE_URL=https://tokenyard.internal.example
export ANTHROPIC_AUTH_TOKEN=ty_live_xxxxxxxx
```

tokenyard reads the key from `x-tokenyard-key`, `Authorization: Bearer` or `x-api-key`, so `ANTHROPIC_API_KEY` works too. Fleet-wide, through Claude Code managed settings, with the gateway pinned as the only allowed destination (`allowedProviders` needs Claude Code v2.1.285 or later, per the [LLM gateway guide](https://code.claude.com/docs/en/llm-gateway)):

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://tokenyard.internal.example",
    "CLAUDE_CODE_GATEWAY_HINT_HEADERS": "1"
  },
  "apiKeyHelper": "tokenyard-key",
  "allowedProviders": ["customEndpoint"]
}
```

`CLAUDE_CODE_GATEWAY_HINT_HEADERS=1` makes Claude Code send its request class, agent type and prompt id, which the trace and the report split cost by. `tokenyard-key` is an example name for your own script that prints the key (for example from the OS keychain); tokenyard does not ship it. For repo, branch and ticket attribution, start Claude Code with `eval "$(tokenyard env)" && claude`; the headers are fixed at launch, so a branch switch mid-session is not reflected.

Codex, in `~/.codex/config.toml` (run `/logout` first if Codex has its own OpenAI login, which it would otherwise prefer):

```toml
model_provider = "tokenyard"

[model_providers.tokenyard]
name = "tokenyard"
base_url = "https://tokenyard.internal.example/v1"
env_key = "TOKENYARD_KEY"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
env_http_headers = { "x-tokenyard-repo" = "TOKENYARD_REPO" }
```

A product service uses a service key (`kind: service`) and the base URL in the official SDK; its traffic class comes from the key, never from a header.

## What replay can and cannot tell you

`tokenyard policy replay` runs the base policy and the head policy separately over one merged trace export, each with its own simulated counter store on a virtual clock, and diffs head against base. The decision function is pure and takes every input from the trace, which is what makes this possible. Replay answers who, where and how much; it never answers how good.

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

## The policy file

`examples/policy/policy.yaml`, the policy the demo runs (with `prices.yaml`, every price carrying its source URL and retrieval date, and `keys.yaml`, hashes only):

```yaml
apiVersion: tokenyard/v1
kind: Policy
metadata:
  name: acme-coding-agents
  owners: ["@acme/platform"]          # informational

pricing: ./prices.yaml                # versioned price table; part of the bundle
keys: ./keys.yaml                     # key hash, tenant, team, name, kind (developer|service), billing (api)

providers:
  anthropic:
    format: anthropic
    baseUrl: https://api.anthropic.com
    credential: { env: ANTHROPIC_API_KEY }
  anthropic-backup:                   # second workspace; a fallback here starts a cold cache
    format: anthropic
    baseUrl: https://api.anthropic.com
    credential: { env: ANTHROPIC_API_KEY_BACKUP }
  openai:
    format: openai
    baseUrl: https://api.openai.com/v1
    credential: { env: OPENAI_API_KEY }

tenants:
  acme: { teams: [platform, web, data] }

routes:                               # first match wins
  - name: claude-code
    match: { surface: anthropic-messages, traffic: coding-agent, billing: api }
    chain: [anthropic, anthropic-backup]
    allowModels: ["claude-opus-5-5*", "claude-sonnet-5-5*", "claude-haiku-*"]
    # Server tools are denied unless listed. Claude Code uses web search, and tool search when it defers MCP tools;
    # both are priced in prices.yaml (tool search: no fee, a 10-iteration loop).
    serverTools: [web_search, tool_search_tool_regex, tool_search_tool_bm25]
  - name: codex
    match: { surface: openai-responses, traffic: coding-agent }
    chain: [openai]
    allowModels: ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano", "gpt-5.3-codex"]   # unpriced models are refused
  - name: support-summaries
    match: { traffic: product, feature: support-summary }
    chain: [anthropic]
    rewriteModel: claude-haiku-5-5    # product traffic only
    criticality: sheddable
  - name: product-default             # feature comes from a client header, so a header-free route must allow the model too
    match: { traffic: product }
    chain: [anthropic]
    rewriteModel: claude-haiku-5-5
    criticality: sheddable

budgets:
  - { name: org-month,  scope: tenant,  window: month, usd: 6000, onExceed: block }
  - { name: team-day,   scope: team,    window: day,   usd: 300,  onExceed: block }
  - { name: dev-day,    scope: key,     window: day,   usd: 40,   onExceed: block, mode: audit }
  - { name: session,    scope: session,                usd: 25,   onExceed: block, mode: audit }

reservation:
  estimator: worst-case               # worst-case | session-aware
  onOverrun: allow-and-debit
  serverToolsWithoutMaxUses: block    # block | assume (assume prices assumedMaxUses and voids the bound, 7.4)

rateLimits:
  - { name: dev-rpm, scope: key, rpm: 120, burst: 30 }
  - { name: dev-streams, scope: key, concurrentStreams: 8 }   # checked inside admit, released at settle

guardrails:
  secrets:
    rules: default                    # curated prefix rules, section 6.6
    codingAgent: block                # block | warn
    product: redact                   # block | warn | redact
    entropyOnly: warn                 # entropy-only hits never block
    taintTtlHours: 24                 # how long a session stays tainted after a block
  pii:
    product: redact                   # email, PESEL, IBAN, card numbers with Luhn

failure:
  counterStoreDown: { rateLimits: open, budgets: closed }
  unpricedModel: allow-and-flag       # block | allow-and-flag
  breaker: { minRequests: 20, failureRatio: 0.5, windowSeconds: 30, openSeconds: 30 }
  retryBudgetRatio: 0.1

ci:
  failOn:
    cutSessions: 0                    # fail the check if any recorded session would be cut mid-task
    costIncreasePct: 10
```

Budgets start in `mode: audit` (checked and traced, never enforced), and a later pull request switches them to `enforce` with the replay showing what enforcement would have done. `tokenyard policy schema > policy.schema.json` gives editor completion. The gateway validates the policy again at load, swaps it atomically, keeps the last good revision when a new one fails, and reports the active revision in every trace and in `tokenyard_policy_revision_info`. Rewriting the model on coding-agent traffic needs `allowBodyRewrite: true` with a `because:` line on the route; Claude Code is never routed to a non-Claude model. `guardrails.pii.quotedOnly: true` limits PESEL and card number redaction on product routes to values inside JSON strings. `sessions: { idleTtlHours: 24, newPerKeyPerHour: 1000, newPerServiceKeyPerHour: 10000 }` (the defaults) bounds what client-chosen session ids can create: session budget levels and session markers expire after that many idle hours, and one developer key (or service key) may start at most that many new sessions an hour (any number at once up to it, refilled evenly), checked in the same atomic admit call; a key in keys.yaml may carry its own `maxNewSessionsPerHour` (a whole number up to 1,000,000) instead; over it a request gets a 429 `session-churn` with `x-should-retry: false`, and a session the key already uses keeps working.

## Measured

Every number below is produced by `npm run bench` into `bench/results.json` and copied into this block by a script; CI fails when the block and the results differ. [docs/benchmarks.md](docs/benchmarks.md) has the commands to reproduce each one and what each measures. Every request goes to the local mock provider, so the absolute times say how the gateway behaves on this machine and nothing about a real provider.

<!-- BENCH:START -->
Measured by `npm run bench` on Apple M2 Pro (12 cores, 16 GB, arm64), darwin 27.0.0, Node v22.14.0; tsx 4.23.15, redis 7.4.12; commit `d45f301`, run 2026-11-04T19:50:13.490Z. Every request goes to the mock provider on loopback; no real provider is called.

#### SLO targets (spec 12.1)

| SLI | Target | Measured | Result |
|---|---|---|---|
| Added TTFB p50 / p99, non-streaming, 10 streams, memory store | under 5 ms / under 25 ms | 0.5 ms / 1.59 ms (n = 2,200); client-side TTFB outside the provider, p50 / p99: direct 1.04 / 3.76 ms, through the gateway 2.44 / 7.65 ms | met |
| Added TTFB p50 / p99, non-streaming, 100 streams, memory store | under 5 ms / under 25 ms | 0.09 ms / 0.51 ms (n = 5,000); client-side TTFB outside the provider, p50 / p99: direct 0.15 / 2.42 ms, through the gateway 0.38 / 3.1 ms | met |
| Added TTFB p50 / p99, non-streaming, 500 streams, memory store | under 5 ms / under 25 ms | 0.05 ms / 0.12 ms (n = 25,000); client-side TTFB outside the provider, p50 / p99: direct 0.19 / 7.33 ms, through the gateway 0.63 / 14.99 ms | met |
| Added TTFB p50 / p99, streaming 500 tokens, 10 streams, memory store | under 5 ms / under 25 ms | 0.53 ms / 1.77 ms (n = 2,200); client-side TTFB outside the provider, p50 / p99: direct 0.33 / 3.57 ms, through the gateway 1.78 / 7.96 ms | met |
| Added TTFB p50 / p99, streaming 500 tokens, 100 streams, memory store | under 5 ms / under 25 ms | 0.14 ms / 0.51 ms (n = 2,252); client-side TTFB outside the provider, p50 / p99: direct 0.18 / 7.78 ms, through the gateway 0.43 / 6.55 ms | met |
| Added TTFB p50 / p99, streaming 500 tokens, 500 streams, memory store | under 5 ms / under 25 ms | 0.06 ms / 0.39 ms (n = 6,261); client-side TTFB outside the provider, p50 / p99: direct 0.8 / 6.95 ms, through the gateway 39.7 / 234.32 ms | missed |
| Added TTFB p50 / p99, streaming 150 KB body, 10 streams, memory store | under 5 ms / under 25 ms | 2.83 ms / 8.5 ms (n = 2,200); client-side TTFB outside the provider, p50 / p99: direct 0.66 / 13.98 ms, through the gateway 4.64 / 17.49 ms | met |
| Added TTFB p50 / p99, streaming 150 KB body, 100 streams, memory store | under 5 ms / under 25 ms | 1.15 ms / 2.81 ms (n = 2,251); client-side TTFB outside the provider, p50 / p99: direct 0.27 / 3.46 ms, through the gateway 1.96 / 33.1 ms | missed |
| Added TTFB p50 / p99, streaming 150 KB body, 500 streams, memory store | under 5 ms / under 25 ms | 1.05 ms / 4.32 ms (n = 6,233); client-side TTFB outside the provider, p50 / p99: direct 1800.58 / 4995.05 ms, through the gateway 4750.37 / 8608.58 ms | missed |
| Added TTFB p50 / p99, non-streaming, 10 streams, redis store | under 5 ms / under 25 ms | 1.81 ms / 6.9 ms (n = 2,200); client-side TTFB outside the provider, p50 / p99: direct 1.04 / 3.76 ms, through the gateway 3.6 / 10.84 ms | met |
| Added TTFB p50 / p99, non-streaming, 100 streams, redis store | under 5 ms / under 25 ms | 0.9 ms / 4 ms (n = 5,000); client-side TTFB outside the provider, p50 / p99: direct 0.15 / 2.42 ms, through the gateway 1.3 / 6.5 ms | met |
| Added TTFB p50 / p99, non-streaming, 500 streams, redis store | under 5 ms / under 25 ms | 0.73 ms / 12.81 ms (n = 25,000); client-side TTFB outside the provider, p50 / p99: direct 0.19 / 7.33 ms, through the gateway 1.38 / 38.77 ms | missed |
| Added TTFB p50 / p99, streaming 500 tokens, 10 streams, redis store | under 5 ms / under 25 ms | 2.3 ms / 8.02 ms (n = 2,200); client-side TTFB outside the provider, p50 / p99: direct 0.33 / 3.57 ms, through the gateway 3.42 / 12.55 ms | met |
| Added TTFB p50 / p99, streaming 500 tokens, 100 streams, redis store | under 5 ms / under 25 ms | 1.13 ms / 5.04 ms (n = 2,250); client-side TTFB outside the provider, p50 / p99: direct 0.18 / 7.78 ms, through the gateway 1.41 / 8.32 ms | met |
| Added TTFB p50 / p99, streaming 500 tokens, 500 streams, redis store | under 5 ms / under 25 ms | 7.39 ms / 55.12 ms (n = 6,240); client-side TTFB outside the provider, p50 / p99: direct 0.8 / 6.95 ms, through the gateway 21.2 / 255.67 ms | missed |
| Added TTFB p50 / p99, streaming 150 KB body, 10 streams, redis store | under 5 ms / under 25 ms | 5 ms / 15.19 ms (n = 2,200); client-side TTFB outside the provider, p50 / p99: direct 0.66 / 13.98 ms, through the gateway 7.04 / 20.25 ms | missed |
| Added TTFB p50 / p99, streaming 150 KB body, 100 streams, redis store | under 5 ms / under 25 ms | 2.74 ms / 19.25 ms (n = 2,261); client-side TTFB outside the provider, p50 / p99: direct 0.27 / 3.46 ms, through the gateway 4.1 / 52.91 ms | missed |
| Added TTFB p50 / p99, streaming 150 KB body, 500 streams, redis store | under 5 ms / under 25 ms | 213.2 ms / 635.63 ms (n = 6,244); client-side TTFB outside the provider, p50 / p99: direct 1800.58 / 4995.05 ms, through the gateway 6035.26 / 12016.48 ms | missed |
| Added TTFB p50 / p99, non-streaming, 500 streams, redis store, 3 gateway processes (serve --workers 3) | under 5 ms / under 25 ms | 0.76 ms / 12.28 ms (n = 25,000); client-side TTFB outside the provider, p50 / p99: direct -0.06 / 2.99 ms, through the gateway 1.14 / 34.33 ms | missed |
| Added TTFB p50 / p99, streaming 500 tokens, 500 streams, redis store, 3 gateway processes (serve --workers 3) | under 5 ms / under 25 ms | 5.56 ms / 76.48 ms (n = 6,249); client-side TTFB outside the provider, p50 / p99: direct -0.31 / 1.5 ms, through the gateway 26.18 / 128.23 ms | missed |
| Added TTFB p50 / p99, streaming 150 KB body, 500 streams, redis store, 3 gateway processes (serve --workers 3) | under 5 ms / under 25 ms | 5.83 ms / 38.87 ms (n = 6,254); client-side TTFB outside the provider, p50 / p99: direct 0.11 / 8.4 ms, through the gateway 18.09 / 98.03 ms | missed |
| Gateway-attributable error rate | under 0.1% per month | not measured (a production SLI); overhead runs: 8 errors beside 133490 answered requests through the gateway | not measured |
| Policy propagation, merge to all instances, p99 | under 60 s | not measured | not measured |
| Admitted spend above an enforced budget (worst-case estimator) | zero | $0 over 2 run(s) of 1,000 requests sent at once (memory, redis) | met |
| Conformance suite on the pinned Claude Code and Codex versions | 100% | not measured by the benchmark (docs/conformance.md) | not measured |
| Cache hit ratio through tokenyard versus direct, same session on the mock | equal | 95.65% versus 95.65% | met |
| Replay of 1,000,000 trace records | under 60 s on a CI runner | 54.4 s on the machine above (not a CI runner) | met |

#### Gateway overhead

An open-loop load generator in the benchmark process sends each scenario to the mock provider directly and through the gateway (each in its own process, loopback). The mock answers after a fixed 100 ms time to first token and streams 500 tokens at 2000 tokens/s. Each stream is one keep-alive connection, opened before the run, with its own schedule of evenly spaced send times (5 requests/s non-streaming, 1.25 requests/s streaming) starting at a seeded random phase, so connections do not fire together; a request still running at the next scheduled time delays the next one, and client-side latency always counts from the scheduled time (coordinated omission included). Added TTFB is the gateway's own per-request measure from its traces (`addedTtfbMs`: from the start of request handling to forwarding upstream, with a sub-millisecond clock in the benchmark), so it is paired per request; it does not include time a request waits before the gateway starts handling it, nor the response path. The client-side columns are absolute percentiles of each path, never subtracted from each other; "outside the provider" is each request's TTFB minus the mock's own wait for that request (the `x-mock-wait-ms` header), paired per request, so the mock's timer jitter drops out. An added TTFB SLO row is met only when both the gateway-measured value and the client-side TTFB outside the provider through the gateway (an upper bound on what the gateway adds, which includes queueing before handling) are under target. Each scenario runs at 1, 10, 16, 64, 100, 256, 500 streams; 10, 100, 500 back the SLO rows (about 2,200 scheduled requests each), the other levels about 300. Throughput is answered (2xx) requests and output tokens per second of each run, from its first scheduled send to its last answer (direct: the mock's fixed output per answer; through the gateway: the output tokens its traces settled); at a fixed open-loop rate it follows the offered load until a path saturates, then falls below it. n is the number of samples behind each percentile. CPU is the gateway process's user plus system time over the run's wall time (100% is one core); RSS growth is its peak during the run above its size just before it; per 100 streams is the slope between 100 and 500 streams, flagged as an understatement when the gateway could not keep up at 500 (a full core, fewer than 90% of the offered requests answered per second, or a drain more than 20% past the window). The gateway runs examples/policy with every budget level enforced at a limit the load never reaches, no rate limits, guardrails on, traces written and metrics kept.

Errors count non-2xx answers and socket errors; scheduled requests the run could not send within its drain time are listed as dropped in bench/results.json.

Memory store:

| Scenario | Streams | Added TTFB p50 / p95 / p99 (ms), gateway-measured | TTFB outside the provider p50 / p99 (ms), direct | Same, through the gateway | Total time p50 / p99 (ms), direct | Same, through the gateway | Throughput, direct / gateway | Gateway CPU | Gateway RSS growth | Errors (direct / gateway) |
|---|---:|---|---|---|---|---|---|---:|---:|---:|
| Non-streaming, small body | 10 | 0.50 / 0.99 / 1.59 (n = 2,200) | 1.04 / 3.76 | 2.44 / 7.65 | 101.82 / 105.42 | 103.63 / 109.70 | 49.9 / 49.9 req/s, 24,946 / 24,967 tokens/s | 20.6% | 64.8 MB | 0 / 0 |
| Non-streaming, small body | 100 | 0.09 / 0.23 / 0.51 (n = 5,000) | 0.15 / 2.42 | 0.38 / 3.10 | 100.39 / 103.58 | 100.62 / 103.55 | 495.2 / 495.7 req/s, 247,581 / 247,839 tokens/s | 46.8% | 12.9 MB | 0 / 0 |
| Non-streaming, small body | 500 | 0.05 / 0.08 / 0.12 (n = 25,000) | 0.19 / 7.33 | 0.63 / 14.99 | 100.40 / 109.96 | 100.71 / 115.69 | 2,475.4 / 2,475.3 req/s, 1,237,685 / 1,237,672 tokens/s | 100.3% | 153.4 MB | 0 / 0 |
| Streaming, 500 tokens | 10 | 0.53 / 1.17 / 1.77 (n = 2,200) | 0.33 / 3.57 | 1.78 / 7.96 | 335.56 / 366.41 | 338.06 / 370.12 | 12.5 / 12.5 req/s, 6,241 / 6,242 tokens/s | 15.2% | 72.9 MB | 0 / 0 |
| Streaming, 500 tokens | 100 | 0.14 / 0.26 / 0.51 (n = 2,252) | 0.18 / 7.78 | 0.43 / 6.55 | 375.71 / 455.28 | 339.88 / 354.38 | 122.6 / 122.8 req/s, 61,309 / 61,416 tokens/s | 52.2% | 71.5 MB | 0 / 0 |
| Streaming, 500 tokens | 500 | 0.06 / 0.20 / 0.39 (n = 6,261) | 0.80 / 6.95 | 39.70 / 234.32 | 505.74 / 654.88 | 700.21 / 969.34 | 601.5 / 603.1 req/s, 300,734 / 301,572 tokens/s | 103.5% | 173.7 MB | 0 / 0 |
| Streaming, 150 KB body | 10 | 2.83 / 5.38 / 8.50 (n = 2,200) | 0.66 / 13.98 | 4.64 / 17.49 | 346.99 / 491.05 | 345.10 / 387.31 | 12.5 / 12.5 req/s, 6,243 / 6,245 tokens/s | 20.1% | 105.3 MB | 0 / 0 |
| Streaming, 150 KB body | 100 | 1.15 / 1.51 / 2.81 (n = 2,251) | 0.27 / 3.46 | 1.96 / 33.10 | 350.26 / 400.42 | 331.08 / 395.54 | 122.7 / 122.8 req/s, 61,369 / 61,419 tokens/s | 74.2% | 124.7 MB | 0 / 0 |
| Streaming, 150 KB body | 500 | 1.05 / 2.45 / 4.32 (n = 6,233) | 1,800.58 / 4,995.05 | 4,750.37 / 8,608.58 | 2,893.74 / 5,800.98 | 5,654.79 / 9,246.83 | 402.9 / 332.2 req/s, 201,450 / 166,108 tokens/s | 100.1% | 405.3 MB | 0 / 0 |

Redis store:

| Scenario | Streams | Added TTFB p50 / p95 / p99 (ms), gateway-measured | TTFB outside the provider p50 / p99 (ms), direct | Same, through the gateway | Total time p50 / p99 (ms), direct | Same, through the gateway | Throughput, direct / gateway | Gateway CPU | Gateway RSS growth | Errors (direct / gateway) |
|---|---:|---|---|---|---|---|---|---:|---:|---:|
| Non-streaming, small body | 10 | 1.81 / 4.11 / 6.90 (n = 2,200) | 1.04 / 3.76 | 3.60 / 10.84 | 101.82 / 105.42 | 104.53 / 112.07 | 49.9 / 49.9 req/s, 24,946 / 24,963 tokens/s | 20.6% | 73.8 MB | 0 / 0 |
| Non-streaming, small body | 100 | 0.90 / 2.37 / 4.00 (n = 5,000) | 0.15 / 2.42 | 1.30 / 6.50 | 100.39 / 103.58 | 101.50 / 107.33 | 495.2 / 495.4 req/s, 247,581 / 247,683 tokens/s | 50.5% | 11.0 MB | 0 / 0 |
| Non-streaming, small body | 500 | 0.73 / 3.46 / 12.81 (n = 25,000) | 0.19 / 7.33 | 1.38 / 38.77 | 100.40 / 109.96 | 101.43 / 139.61 | 2,475.4 / 2,475.0 req/s, 1,237,685 / 1,237,492 tokens/s | 112.4% | 177.3 MB | 0 / 0 |
| Streaming, 500 tokens | 10 | 2.30 / 4.42 / 8.02 (n = 2,200) | 0.33 / 3.57 | 3.42 / 12.55 | 335.56 / 366.41 | 338.88 / 381.14 | 12.5 / 12.5 req/s, 6,241 / 6,239 tokens/s | 14.9% | 78.9 MB | 0 / 0 |
| Streaming, 500 tokens | 100 | 1.13 / 2.78 / 5.04 (n = 2,250) | 0.18 / 7.78 | 1.41 / 8.32 | 375.71 / 455.28 | 338.49 / 363.15 | 122.6 / 122.8 req/s, 61,309 / 61,399 tokens/s | 51.5% | 82.4 MB | 0 / 0 |
| Streaming, 500 tokens | 500 | 7.39 / 23.90 / 55.12 (n = 6,240) | 0.80 / 6.95 | 21.20 / 255.67 | 505.74 / 654.88 | 447.54 / 821.61 | 601.5 / 602.3 req/s, 300,734 / 301,134 tokens/s | 106.6% | 201.5 MB | 0 / 0 |
| Streaming, 150 KB body | 10 | 5.00 / 9.49 / 15.19 (n = 2,200) | 0.66 / 13.98 | 7.04 / 20.25 | 346.99 / 491.05 | 347.70 / 380.57 | 12.5 / 12.5 req/s, 6,243 / 6,249 tokens/s | 22.7% | 105.8 MB | 0 / 0 |
| Streaming, 150 KB body | 100 | 2.74 / 6.87 / 19.25 (n = 2,261) | 0.27 / 3.46 | 4.10 / 52.91 | 350.26 / 400.42 | 337.64 / 466.88 | 122.7 / 123.4 req/s, 61,369 / 61,711 tokens/s | 83.0% | 128.0 MB | 0 / 0 |
| Streaming, 150 KB body | 500 | 213.20 / 558.79 / 635.63 (n = 6,244) | 1,800.58 / 4,995.05 | 6,035.26 / 12,016.48 | 2,893.74 / 5,800.98 | 7,158.16 / 12,580.14 | 402.9 / 280.3 req/s, 201,450 / 140,173 tokens/s | 90.1% | 485.7 MB | 0 / 8 |

Gateway cost per 100 more streams (slope between two levels):

| Store | Scenario | Streams | CPU per 100 streams | RSS growth per 100 streams |
|---|---|---|---:|---:|
| memory | Non-streaming, small body | 100 to 500 | 13.4% (gateway saturated at 500 streams, so this understates it) | 35.1 MB |
| redis | Non-streaming, small body | 100 to 500 | 15.5% (gateway saturated at 500 streams, so this understates it) | 41.6 MB |
| memory | Streaming, 500 tokens | 100 to 500 | 12.8% (gateway saturated at 500 streams, so this understates it) | 25.5 MB |
| redis | Streaming, 500 tokens | 100 to 500 | 13.8% (gateway saturated at 500 streams, so this understates it) | 29.8 MB |
| memory | Streaming, 150 KB body | 100 to 500 | 6.5% (gateway saturated at 500 streams, so this understates it) | 70.2 MB |
| redis | Streaming, 150 KB body | 100 to 500 | 1.8% (gateway saturated at 500 streams, so this understates it) | 89.4 MB |

<details><summary>Every concurrency level, with client-side TTFB from the scheduled send time</summary>

| Store | Scenario | Streams | Rate per stream (req/s) | Seconds | Answered (direct / gateway) | Answered req/s (direct / gateway) | Output tokens/s (direct / gateway) | Added TTFB p50 / p95 / p99 (ms) | TTFB outside the provider p50 / p99 (ms), direct / gateway | TTFB p50 / p95 / p99 (ms), direct | Same, through the gateway | Gateway CPU | Gateway RSS | Added TTFB target (both measures) |
|---|---|---:|---:|---:|---:|---:|---:|---|---|---|---|---:|---:|---|
| memory | Non-streaming, small body | 1 (low n) | 5.00 | 20 | 100 / 100 | 5.0 / 5.0 | 2,512 / 2,512 | 1.17 / 1.72 / 2.28 | 2.10 / 5.06 / 5.63 / 10.97 | 103.31 / 106.03 / 107.15 | 106.81 / 110.77 / 112.37 | 4.1% | 96.5 MB | missed |
| redis | Non-streaming, small body | 1 (low n) | 5.00 | 20 | 100 / 100 | 5.0 / 5.0 | 2,512 / 2,512 | 3.08 / 4.96 / 5.90 | 2.10 / 5.06 / 6.73 / 13.54 | 103.31 / 106.03 / 107.15 | 108.00 / 112.47 / 115.66 | 4.3% | 99.3 MB | missed |
| memory | Non-streaming, small body | 10 | 5.00 | 44 | 2,200 / 2,200 | 49.9 / 49.9 | 24,946 / 24,967 | 0.50 / 0.99 / 1.59 | 1.04 / 3.76 / 2.44 / 7.65 | 101.73 / 103.70 / 105.23 | 103.37 / 106.49 / 108.99 | 20.6% | 109.1 MB | met |
| redis | Non-streaming, small body | 10 | 5.00 | 44 | 2,200 / 2,200 | 49.9 / 49.9 | 24,946 / 24,963 | 1.81 / 4.11 / 6.90 | 1.04 / 3.76 / 3.60 / 10.84 | 101.73 / 103.70 / 105.23 | 104.27 / 108.83 / 111.70 | 20.6% | 118.5 MB | met |
| memory | Non-streaming, small body | 16 | 5.00 | 5 | 400 / 400 | 78.5 / 79.1 | 39,257 / 39,558 | 0.33 / 0.80 / 1.07 | 0.79 / 2.82 / 1.83 / 7.72 | 101.46 / 103.42 / 103.98 | 102.41 / 105.53 / 108.44 | 22.1% | 100.6 MB | met |
| redis | Non-streaming, small body | 16 | 5.00 | 5 | 400 / 400 | 78.5 / 78.6 | 39,257 / 39,296 | 1.67 / 3.68 / 5.00 | 0.79 / 2.82 / 3.26 / 9.29 | 101.46 / 103.42 / 103.98 | 103.99 / 107.71 / 110.42 | 26.8% | 118.7 MB | met |
| memory | Non-streaming, small body | 64 | 5.00 | 5 | 1,600 / 1,600 | 313.7 / 314.3 | 156,853 / 157,154 | 0.14 / 0.28 / 0.51 | 0.33 / 6.92 / 0.62 / 3.81 | 100.69 / 102.65 / 108.36 | 100.89 / 102.75 / 104.16 | 47.9% | 123.0 MB | met |
| redis | Non-streaming, small body | 64 | 5.00 | 5 | 1,600 / 1,600 | 313.7 / 314.0 | 156,853 / 156,987 | 0.99 / 2.60 / 5.26 | 0.33 / 6.92 / 1.52 / 7.15 | 100.69 / 102.65 / 108.36 | 101.85 / 104.66 / 108.40 | 46.5% | 131.0 MB | met |
| memory | Non-streaming, small body | 100 | 5.00 | 10 | 5,000 / 5,000 | 495.2 / 495.7 | 247,581 / 247,839 | 0.09 / 0.23 / 0.51 | 0.15 / 2.42 / 0.38 / 3.10 | 100.35 / 101.86 / 103.41 | 100.54 / 102.21 / 103.33 | 46.8% | 127.9 MB | met |
| redis | Non-streaming, small body | 100 | 5.00 | 10 | 5,000 / 5,000 | 495.2 / 495.4 | 247,581 / 247,683 | 0.90 / 2.37 / 4.00 | 0.15 / 2.42 / 1.30 / 6.50 | 100.35 / 101.86 / 103.41 | 101.42 / 103.99 / 107.27 | 50.5% | 134.8 MB | met |
| memory | Non-streaming, small body | 256 | 5.00 | 5 | 6,400 / 6,400 | 1,255.0 / 1,255.5 | 627,516 / 627,745 | 0.06 / 0.12 / 0.23 | 0.17 / 3.98 / 0.40 / 16.52 | 100.37 / 102.26 / 105.75 | 100.46 / 105.33 / 116.58 | 83.0% | 199.8 MB | met |
| redis | Non-streaming, small body | 256 | 5.00 | 5 | 6,400 / 6,400 | 1,255.0 / 1,254.9 | 627,516 / 627,428 | 0.67 / 1.64 / 2.56 | 0.17 / 3.98 / 0.86 / 4.93 | 100.37 / 102.26 / 105.75 | 100.89 / 102.79 / 105.15 | 90.0% | 240.0 MB | met |
| memory | Non-streaming, small body | 500 | 5.00 | 10 | 25,000 / 25,000 | 2,475.4 / 2,475.3 | 1,237,685 / 1,237,672 | 0.05 / 0.08 / 0.12 | 0.19 / 7.33 / 0.63 / 14.99 | 100.38 / 102.74 / 109.95 | 100.66 / 103.34 / 115.62 | 100.3% | 228.3 MB | met |
| redis | Non-streaming, small body | 500 | 5.00 | 10 | 25,000 / 25,000 | 2,475.4 / 2,475.0 | 1,237,685 / 1,237,492 | 0.73 / 3.46 / 12.81 | 0.19 / 7.33 / 1.38 / 38.77 | 100.38 / 102.74 / 109.95 | 101.38 / 108.62 / 139.58 | 112.4% | 278.6 MB | missed |
| memory | Streaming, 500 tokens | 1 (low n) | 1.25 | 20 | 25 / 25 | 1.3 / 1.3 | 640 / 640 | 1.10 / 1.41 / 2.25 | 2.04 / 3.83 / 5.75 / 41.22 | 103.46 / 104.72 / 104.75 | 106.54 / 123.24 / 142.32 | 3.9% | 69.3 MB | missed |
| redis | Streaming, 500 tokens | 1 (low n) | 1.25 | 20 | 25 / 25 | 1.3 / 1.3 | 640 / 639 | 3.45 / 7.67 / 12.00 | 2.04 / 3.83 / 10.14 / 79.63 | 103.46 / 104.72 / 104.75 | 111.75 / 128.36 / 179.92 | 5.1% | 72.9 MB | missed |
| memory | Streaming, 500 tokens | 10 | 1.25 | 176 | 2,200 / 2,200 | 12.5 / 12.5 | 6,241 / 6,242 | 0.53 / 1.17 / 1.77 | 0.33 / 3.57 / 1.78 / 7.96 | 100.71 / 102.38 / 105.01 | 102.07 / 105.08 / 110.39 | 15.2% | 114.2 MB | met |
| redis | Streaming, 500 tokens | 10 | 1.25 | 176 | 2,200 / 2,200 | 12.5 / 12.5 | 6,241 / 6,239 | 2.30 / 4.42 / 8.02 | 0.33 / 3.57 / 3.42 / 12.55 | 100.71 / 102.38 / 105.01 | 103.75 / 107.32 / 113.68 | 14.9% | 110.4 MB | met |
| memory | Streaming, 500 tokens | 16 | 1.25 | 15 | 300 / 301 | 19.7 / 19.6 | 9,861 / 9,821 | 0.33 / 0.95 / 1.28 | 0.30 / 3.19 / 1.08 / 5.31 | 100.67 / 102.61 / 105.41 | 101.32 / 103.84 / 106.43 | 17.4% | 82.3 MB | met |
| redis | Streaming, 500 tokens | 16 | 1.25 | 15 | 300 / 296 | 19.7 / 19.5 | 9,861 / 9,770 | 2.36 / 4.53 / 7.39 | 0.30 / 3.19 / 3.69 / 11.14 | 100.67 / 102.61 / 105.41 | 103.98 / 108.95 / 112.23 | 24.8% | 95.1 MB | met |
| memory | Streaming, 500 tokens | 64 | 1.25 | 5 | 398 / 394 | 74.7 / 74.3 | 37,353 / 37,134 | 0.19 / 0.45 / 0.82 | 0.10 / 18.61 / 0.57 / 4.79 | 100.50 / 103.85 / 120.65 | 100.89 / 103.38 / 105.28 | 41.9% | 98.7 MB | met |
| redis | Streaming, 500 tokens | 64 | 1.25 | 5 | 398 / 398 | 74.7 / 75.6 | 37,353 / 37,823 | 1.39 / 3.04 / 9.37 | 0.10 / 18.61 / 1.92 / 14.20 | 100.50 / 103.85 / 120.65 | 102.24 / 106.46 / 114.98 | 43.7% | 107.5 MB | met |
| memory | Streaming, 500 tokens | 100 | 1.25 | 18 | 2,251 / 2,252 | 122.6 / 122.8 | 61,309 / 61,416 | 0.14 / 0.26 / 0.51 | 0.18 / 7.78 / 0.43 / 6.55 | 101.01 / 104.03 / 118.69 | 100.77 / 102.53 / 106.91 | 52.2% | 92.9 MB | met |
| redis | Streaming, 500 tokens | 100 | 1.25 | 18 | 2,251 / 2,250 | 122.6 / 122.8 | 61,309 / 61,399 | 1.13 / 2.78 / 5.04 | 0.18 / 7.78 / 1.41 / 8.32 | 101.01 / 104.03 / 118.69 | 101.72 / 104.43 / 108.42 | 51.5% | 102.3 MB | met |
| memory | Streaming, 500 tokens | 256 | 1.25 | 5 | 1,598 / 1,602 | 297.7 / 300.4 | 148,854 / 150,188 | 0.08 / 0.17 / 0.31 | 0.07 / 3.81 / 0.86 / 23.38 | 101.11 / 103.29 / 106.56 | 101.39 / 107.56 / 124.76 | 84.8% | 104.7 MB | met |
| redis | Streaming, 500 tokens | 256 | 1.25 | 5 | 1,598 / 1,599 | 297.7 / 300.0 | 148,854 / 149,980 | 1.58 / 6.20 / 49.40 | 0.07 / 3.81 / 2.32 / 123.35 | 101.11 / 103.29 / 106.56 | 102.81 / 163.27 / 224.82 | 82.0% | 117.0 MB | missed |
| memory | Streaming, 500 tokens | 500 | 1.25 | 10 | 6,245 / 6,261 | 601.5 / 603.1 | 300,734 / 301,572 | 0.06 / 0.20 / 0.39 | 0.80 / 6.95 / 39.70 / 234.32 | 103.70 / 109.38 / 115.34 | 144.78 / 284.70 / 338.95 | 103.5% | 216.8 MB | missed |
| redis | Streaming, 500 tokens | 500 | 1.25 | 10 | 6,245 / 6,240 | 601.5 / 602.3 | 300,734 / 301,134 | 7.39 / 23.90 / 55.12 | 0.80 / 6.95 / 21.20 / 255.67 | 103.70 / 109.38 / 115.34 | 122.78 / 194.21 / 357.73 | 106.6% | 250.8 MB | missed |
| memory | Streaming, 150 KB body | 1 (low n) | 1.25 | 20 | 25 / 25 | 1.3 / 1.3 | 640 / 640 | 3.12 / 6.19 / 11.86 | 2.41 / 4.05 / 6.64 / 22.19 | 105.63 / 108.12 / 109.95 | 109.35 / 113.41 / 125.01 | 3.9% | 73.5 MB | missed |
| redis | Streaming, 150 KB body | 1 (low n) | 1.25 | 20 | 25 / 25 | 1.3 / 1.3 | 640 / 640 | 5.60 / 7.94 / 9.29 | 2.41 / 4.05 / 8.67 / 14.15 | 105.63 / 108.12 / 109.95 | 110.61 / 116.47 / 116.62 | 3.2% | 71.7 MB | missed |
| memory | Streaming, 150 KB body | 10 | 1.25 | 176 | 2,200 / 2,200 | 12.5 / 12.5 | 6,243 / 6,245 | 2.83 / 5.38 / 8.50 | 0.66 / 13.98 / 4.64 / 17.49 | 102.90 / 108.61 / 128.01 | 106.61 / 113.53 / 120.16 | 20.1% | 118.5 MB | met |
| redis | Streaming, 150 KB body | 10 | 1.25 | 176 | 2,200 / 2,200 | 12.5 / 12.5 | 6,243 / 6,249 | 5.00 / 9.49 / 15.19 | 0.66 / 13.98 / 7.04 / 20.25 | 102.90 / 108.61 / 128.01 | 108.97 / 116.26 / 123.32 | 22.7% | 118.5 MB | missed |
| memory | Streaming, 150 KB body | 16 | 1.25 | 15 | 300 / 303 | 19.6 / 19.8 | 9,803 / 9,891 | 2.34 / 5.56 / 8.12 | 0.55 / 4.33 / 3.67 / 14.76 | 102.79 / 105.35 / 109.67 | 105.25 / 112.44 / 117.62 | 23.8% | 103.8 MB | met |
| redis | Streaming, 150 KB body | 16 | 1.25 | 15 | 300 / 297 | 19.6 / 19.5 | 9,803 / 9,771 | 4.20 / 10.78 / 15.91 | 0.55 / 4.33 / 5.59 / 22.27 | 102.79 / 105.35 / 109.67 | 107.32 / 118.55 / 124.07 | 26.1% | 115.7 MB | missed |
| memory | Streaming, 150 KB body | 64 | 1.25 | 5 | 398 / 405 | 74.9 / 76.0 | 37,427 / 38,018 | 1.35 / 1.98 / 3.90 | 0.34 / 11.98 / 2.26 / 16.44 | 101.90 / 107.29 / 117.35 | 103.34 / 109.48 / 116.98 | 54.4% | 123.7 MB | met |
| redis | Streaming, 150 KB body | 64 | 1.25 | 5 | 398 / 403 | 74.9 / 75.6 | 37,427 / 37,780 | 2.85 / 7.51 / 12.62 | 0.34 / 11.98 / 4.23 / 33.14 | 101.90 / 107.29 / 117.35 | 105.36 / 112.72 / 136.58 | 59.7% | 133.8 MB | missed |
| memory | Streaming, 150 KB body | 100 | 1.25 | 18 | 2,253 / 2,251 | 122.7 / 122.8 | 61,369 / 61,419 | 1.15 / 1.51 / 2.81 | 0.27 / 3.46 / 1.96 / 33.10 | 101.79 / 104.03 / 107.57 | 103.05 / 108.47 / 137.52 | 74.2% | 145.0 MB | missed |
| redis | Streaming, 150 KB body | 100 | 1.25 | 18 | 2,253 / 2,261 | 122.7 / 123.4 | 61,369 / 61,711 | 2.74 / 6.87 / 19.25 | 0.27 / 3.46 / 4.10 / 52.91 | 101.79 / 104.03 / 107.57 | 105.15 / 114.89 / 157.95 | 83.0% | 148.4 MB | missed |
| memory | Streaming, 150 KB body | 256 | 1.25 | 5 | 1,606 / 1,603 | 300.3 / 300.2 | 150,164 / 150,094 | 1.01 / 1.70 / 3.19 | 0.66 / 20.14 / 15.89 / 104.12 | 102.30 / 112.33 / 128.10 | 117.70 / 171.44 / 207.61 | 114.6% | 251.2 MB | missed |
| redis | Streaming, 150 KB body | 256 | 1.25 | 5 | 1,606 / 1,597 | 300.3 / 297.8 | 150,164 / 148,925 | 7.95 / 31.14 / 53.10 | 0.66 / 20.14 / 26.48 / 156.57 | 102.30 / 112.33 / 128.10 | 128.20 / 225.98 / 258.25 | 116.4% | 283.2 MB | missed |
| memory | Streaming, 150 KB body | 500 | 1.25 | 10 | 6,245 / 6,233 | 402.9 / 332.2 | 201,450 / 166,108 | 1.05 / 2.45 / 4.32 | 1,800.58 / 4,995.05 / 4,750.37 / 8,608.58 | 1,909.66 / 4,802.83 / 5,104.64 | 4,864.09 / 8,210.96 / 8,726.26 | 100.1% | 450.8 MB | missed |
| redis | Streaming, 150 KB body | 500 | 1.25 | 10 | 6,245 / 6,244 | 402.9 / 280.3 | 201,450 / 140,173 | 213.20 / 558.79 / 635.63 | 1,800.58 / 4,995.05 / 6,035.26 / 12,016.48 | 1,909.66 / 4,802.83 / 5,104.64 | 6,305.44 / 11,634.02 / 12,138.15 | 90.1% | 507.1 MB | missed |

</details>

Rows that miss the added TTFB targets at the SLO levels (10, 100 and 500 streams): Non-streaming, small body, redis store, 500 streams (client-side p99; gateway saturated); Streaming, 500 tokens, memory store, 500 streams (client-side p50 and p99; gateway saturated); Streaming, 500 tokens, redis store, 500 streams (gateway-measured p50 and p99, client-side p50 and p99; gateway saturated); Streaming, 150 KB body, redis store, 10 streams (gateway-measured p50, client-side p50); Streaming, 150 KB body, memory store, 100 streams (client-side p99); Streaming, 150 KB body, redis store, 100 streams (client-side p99); Streaming, 150 KB body, memory store, 500 streams (client-side p50 and p99; gateway saturated); Streaming, 150 KB body, redis store, 500 streams (gateway-measured p50 and p99, client-side p50 and p99; gateway saturated). At the other levels: Non-streaming, small body, memory store, 1 stream (client-side p50; n = 100); Non-streaming, small body, redis store, 1 stream (client-side p50; n = 100); Streaming, 500 tokens, memory store, 1 stream (client-side p50 and p99; n = 25); Streaming, 500 tokens, redis store, 1 stream (client-side p50 and p99; n = 25); Streaming, 500 tokens, redis store, 256 streams (gateway-measured p99, client-side p99); Streaming, 150 KB body, memory store, 1 stream (client-side p50; n = 25); Streaming, 150 KB body, redis store, 1 stream (gateway-measured p50, client-side p50; n = 25); Streaming, 150 KB body, redis store, 16 streams (client-side p50); Streaming, 150 KB body, redis store, 64 streams (client-side p99); Streaming, 150 KB body, memory store, 256 streams (client-side p50 and p99; gateway saturated); Streaming, 150 KB body, redis store, 256 streams (gateway-measured p50 and p99, client-side p50 and p99; gateway saturated).

#### Gateway overhead with several gateway processes (`serve --workers`, Redis store)

The 500-stream rows again on the Redis store, with the gateway as 1, 2, 3, 4 processes sharing one port through node:cluster, as `tokenyard serve --workers <n>` runs it (a primary that serves no traffic hands each connection to a worker in turn; every worker has its own instance id and Redis connection). The harness is in several processes too, so it is not the bottleneck: the mock runs as 3 processes on one port and the load generator as 3 processes that split the connections and start together (the single-process rows above saturate the mock at 150 KB and 500 streams). The direct path goes through the same mock and load processes; the mock and load CPU columns are per process over the gateway run. Same schedule, mock timing, policy, measures and verdict as the rows above. Gateway CPU is the sum over the workers and the primary, with each worker in brackets; a row is flagged saturated when one worker uses a full core. The row with 1 process is the control: the same harness with one gateway process. The SLO rows use 3 processes, chosen from development runs on this machine before this run; every count is in the table. These rows run before the single-process sweep above, which heats the laptop until it throttles.

| Scenario | Streams | Gateway processes | Added TTFB p50 / p95 / p99 (ms), gateway-measured | TTFB outside the provider p50 / p99 (ms), direct | Same, through the gateway | Throughput, direct / gateway | Gateway CPU (per process) | Mock CPU per process | Load generator CPU per process | Errors (direct / gateway) | Added TTFB target (both measures) |
|---|---:|---:|---|---|---|---|---:|---|---|---:|---|
| Non-streaming, small body | 500 | 1 | 0.71 / 42.25 / 78.28 (n = 25,000) | -0.06 / 2.99 | 1.36 / 218.99 | 2,475.3 / 2,475.3 req/s, 1,237,629 / 1,237,636 tokens/s | 117.7% | 6.6%, 6.7%, 6.7% | 7.9%, 7.9%, 7.9% | 0 / 0 | missed |
| Non-streaming, small body | 500 | 2 | 0.63 / 1.86 / 3.98 (n = 25,000) | -0.06 / 2.99 | 0.93 / 8.60 | 2,475.3 / 2,475.4 req/s, 1,237,629 / 1,237,708 tokens/s | 204.2% (101.5%, 102.5%) | 8.0%, 8.4%, 8.4% | 9.7%, 9.8%, 9.7% | 0 / 0 | met |
| Non-streaming, small body | 500 | 3 | 0.76 / 3.30 / 12.28 (n = 25,000) | -0.06 / 2.99 | 1.14 / 34.33 | 2,475.3 / 2,475.2 req/s, 1,237,629 / 1,237,625 tokens/s | 266.6% (87.6%, 89.4%, 89.4%) | 9.4%, 9.3%, 9.6% | 11.4%, 11.4%, 11.3% | 0 / 0 | missed |
| Non-streaming, small body | 500 | 4 | 0.93 / 4.43 / 10.07 (n = 25,000) | -0.06 / 2.99 | 1.48 / 21.82 | 2,475.3 / 2,474.6 req/s, 1,237,629 / 1,237,309 tokens/s | 332.3% (82.4%, 81.9%, 82.0%, 85.7%) | 10.6%, 10.5%, 10.8% | 13.1%, 13.1%, 13.0% | 0 / 0 | met |
| Streaming, 500 tokens | 500 | 1 | 5.76 / 11.20 / 19.11 (n = 6,236) | -0.31 / 1.50 | 16.95 / 42.91 | 604.1 / 603.1 req/s, 302,058 / 301,554 tokens/s | 107.9% | 26.3%, 25.9%, 26.6% | 18.3%, 18.4%, 18.2% | 0 / 0 | missed |
| Streaming, 500 tokens | 500 | 2 | 2.15 / 11.33 / 16.33 (n = 6,254) | -0.31 / 1.50 | 5.76 / 37.58 | 604.1 / 604.8 req/s, 302,058 / 302,404 tokens/s | 207.1% (103.4%, 103.4%) | 32.0%, 32.3%, 32.2% | 32.7%, 32.4%, 32.5% | 0 / 0 | missed |
| Streaming, 500 tokens | 500 | 3 | 5.56 / 55.15 / 76.48 (n = 6,249) | -0.31 / 1.50 | 26.18 / 128.23 | 604.1 / 604.0 req/s, 302,058 / 301,992 tokens/s | 253.7% (87.5%, 82.5%, 83.4%) | 31.5%, 30.9%, 31.4% | 32.3%, 32.3%, 32.0% | 0 / 0 | missed |
| Streaming, 500 tokens | 500 | 4 | 19.48 / 75.33 / 112.30 (n = 6,251) | -0.31 / 1.50 | 72.84 / 235.65 | 604.1 / 594.8 req/s, 302,058 / 297,408 tokens/s | 278.3% (69.5%, 69.2%, 71.0%, 68.4%) | 34.1%, 34.3%, 33.6% | 30.5%, 30.3%, 30.3% | 0 / 0 | missed |
| Streaming, 150 KB body | 500 | 1 | 188.37 / 419.02 / 499.46 (n = 6,238) | 0.11 / 8.40 | 1,413.79 / 3,596.34 | 605.4 / 467.0 req/s, 302,708 / 233,483 tokens/s | 114.7% | 40.9%, 33.9%, 35.9% | 7.4%, 7.4%, 7.5% | 0 / 0 | missed |
| Streaming, 150 KB body | 500 | 2 | 10.83 / 46.38 / 79.31 (n = 6,261) | 0.11 / 8.40 | 38.23 / 189.77 | 605.4 / 604.2 req/s, 302,708 / 302,095 tokens/s | 241.9% (119.0%, 122.6%) | 56.2%, 57.2%, 55.7% | 19.9%, 19.9%, 19.7% | 0 / 0 | missed |
| Streaming, 150 KB body | 500 | 3 | 5.83 / 27.96 / 38.87 (n = 6,254) | 0.11 / 8.40 | 18.09 / 98.03 | 605.4 / 604.1 req/s, 302,708 / 302,069 tokens/s | 373.5% (123.7%, 119.4%, 130.1%) | 56.5%, 54.9%, 59.3% | 31.7%, 31.4%, 31.4% | 0 / 0 | missed |
| Streaming, 150 KB body | 500 | 4 | 23.98 / 118.41 / 215.40 (n = 6,268) | 0.11 / 8.40 | 201.02 / 1,008.74 | 605.4 / 562.9 req/s, 302,708 / 281,428 tokens/s | 292.3% (75.0%, 70.2%, 75.4%, 71.5%) | 53.6%, 52.1%, 55.1% | 15.9%, 16.2%, 16.0% | 0 / 0 | missed |

#### Budget correctness

The G4 proof scenario of spec 7.4: requests sent at the same moment, each on its own connection opened beforehand, through the gateway against one enforced budget, each with an actual cost drawn (seeded) between 0 and its limits. "Admit calls before the first settle" counts the requests the store decided while the first admitted ones were still open.

| Store | Estimator | Budget | Requests sent at once | Admit calls before the first settle | Most open reservations | Admitted | Rejected | Final spend | Max spent + reserved after any admit | Max overspend | Final spend minus settled costs | Reserved left |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| memory | worst-case | $1.00 | 1,000 | 1,000 | 16 | 16 | 984 | $0.120120 | $0.998049 | $0.000000 | 0 micro-USD | 0 micro-USD |
| redis | worst-case | $1.00 | 1,000 | 1,000 | 16 | 16 | 984 | $0.120120 | $0.998049 | $0.000000 | 0 micro-USD | 0 micro-USD |
| memory | session-aware | $1.00 | 1,000 | 1,000 | 16 | 16 | 984 | $0.120120 | $0.998049 | $0.000000 | 0 micro-USD | 0 micro-USD |
| redis | session-aware | $1.00 | 1,000 | 1,000 | 16 | 16 | 984 | $0.120120 | $0.998049 | $0.000000 | 0 micro-USD | 0 micro-USD |

Concurrency trade-off: one 150,000-byte turn with max_tokens 32,000 on claude-opus-5-5, sent concurrently in one session under a $25.00 session budget (enforced), while the mock holds every stream open:

| Estimator | Reservation per turn | Turns admitted in flight |
|---|---:|---:|
| worst-case | $2.0600 | 12 of 40 |
| session-aware | $2.0600 | 12 of 40 |

session-aware reserves the same as worst-case here: the estimator is not given the session's previous cache read share yet (src/policy/decide.ts passes none), and the route sets no reserveOutputTokens.

#### Cache economics

The 40-turn Claude Code shaped session of conformance test C15, priced at claude-opus-5-5 list prices:

| Path | Session cost | Uncached input tokens | Cache read tokens | Cache write tokens | Cache hit ratio |
|---|---:|---:|---:|---:|---:|
| direct | $0.1574 | 0 | 338,518 | 15,384 | 95.65% |
| tokenyard | $0.1574 | 0 | 338,518 | 15,384 | 95.65% |
| naive proxy | $0.1572 | 0 | 337,972 | 15,370 | 95.65% |

The naive proxy flattens `system` into a string, which drops the cache breakpoint on the system block. This session also marks the newest user block, and that breakpoint caches the whole prefix, the flattened system text included, so through the naive proxy the session still reads almost the same prefix from cache and costs about the same; its usage still differs from the direct run (conformance test C15b fails on it).

#### Secret scan

Default rules on a 4.1 MiB synthetic coding-agent body: last-turn scan 361.4 MiB/s, full-body scan 97.6 MiB/s. False-positive corpus (source trees and lockfiles sent as tool results): 843 files, 9.4 MB, 0 block hits.

#### Replay throughput

1,000,000 synthetic trace records (the demo week repeated, 103.9 MB gzipped export) read, parsed and replayed against the demo's base and head policies in 54.4 s (18,368 records/s, fidelity 81.1%).

#### Estimator calibration

| Traces | Requests with usage | Bounds (bytes / context-window) | Bytes bound to billed input, min / median / max | Reservation to actual cost, min / median / max | Billed input above bound |
|---|---:|---:|---|---|---:|
| Demo traffic (mock provider, 4 bytes per token) | 3,647 | 3,647 / 0 | 4.04 / 5.44 / 66.37 | 12.70 / 32.55 / 544.76 | 0 |
| Live Claude Code 2.1.316, 2.1.317, 2026-11-02, 2026-11-03 | 60 | 58 / 2 | 2.88 / 3.07 / 3.28 | 22.52 / 329.49 / 1,574.93 | 0 |
| Live Codex 0.166.0, 2026-11-02, 2026-11-03 | 7 | 2 / 5 | 5.02 / 5.02 / 5.03 | 68.07 / 519.73 / 815.64 | 0 |

Live rows come from the local live runs through tokenyard (spec 14.1) and are aggregates only.

#### Soak

The shipped bundle (bin/tokenyard.mjs serve, policy from a directory, traces written, ops listener on) runs under an open-loop load with Poisson arrivals against the mock providers on loopback: Claude Code main turns (streaming, growing cached context), subagents, auxiliary and compaction calls, Codex Responses (streaming and not), product traffic with PII, client aborts mid-stream, secret blocks with session taint, refused models, hostile attribution headers (up to 900 characters of quotes, braces, percent signs and Latin-1 on every attribution header, new on every request; session ids from a fixed set of 300 such values), upstream 500, 529, mid-stream errors and dropped connections, a noisy key over its rate and stream limits every minute and 24 requests with max_tokens 128,000 and a 1.1 MB body at once on one session every two minutes, over the enforced 200 USD session budget. New sessions cycle through a fixed set of ids per key, because each distinct session id holds counter state until it has been idle for 24 hours; that cost is measured on its own (Redis keys and bytes per key). A preloaded probe (bench/soak-probe.mjs; the bundle is unchanged) reports every 30 s the event loop delay since the previous sample, then RSS and heap used right after a full GC (--expose-gc), and active handles; lsof gives open descriptors and TCP sockets; /metrics gives the series count and open reservations; the trace directory gives files and bytes; Redis gives keys by class and used memory. Memory is judged after a 5 minute warm-up on heap used after a full GC plus external memory: the least-squares trend over the rest of the run, projected over it, and the last 5 minutes against the first 5 must each stay under 10%; RSS is judged the same way on the gateway minus the mock provider sampled at the same moments (a control process), against 10% of the gateway RSS. Descriptors, sockets and handles are compared idle before and after the load. After the load every key must admit its full concurrent stream limit at once with one more refused, no reservation may be open or left to the sweeper, and in Redis no reservation, deadline or stream count may remain.

| Store | Gateways | Minutes | Requests (per second) | Gateway CPU | RSS, first / last 5 min after warm-up (MB), trend | Heap after GC, same (MB), trend | Open fds idle, before / after | Metric series, end | Redis keys after | Trace hours, MB per hour | Checks passed |
|---|---:|---:|---:|---:|---|---|---|---:|---:|---|---:|
| memory | 1 | 45 | 224,306 (83.1) | 40.5% | minus control 11.34 to 14.29, 3.81% | plus external 44.33 to 41.35, -1.26% | 10 / 10 | 68 | n/a | 2, 472.2 | 15 of 15 |
| redis | 2 | 45 | 439,960 (162.9) | 31.5%, 30.5% | 114.32 to 139.34, 26.91%; 114.51 to 138.3, 29.33% | 30.54 to 31.07, 1.79%; 30.59 to 31.05, 1.61% | 11 / 11; 11 / 11 | 67, 68 | 4,228 | 2, 450.2; 2, 449.9 | 27 of 29 |

Failed checks:

- redis: soak0001: RSS growth (114.32 to 139.34 MB; trend 26.91% (51.73 MB/h), windows 21.88% (n = 80); threshold trend and last 5 min against first, each under 10%)
- redis: soak0002: RSS growth (114.51 to 138.3 MB; trend 29.33% (56.79 MB/h), windows 20.77% (n = 80); threshold trend and last 5 min against first, each under 10%)

Thresholds, every check and the commands: docs/benchmarks.md, "Soak".
<!-- BENCH:END -->

How to read it. With one gateway process the added TTFB targets are met for small non-streaming requests at every SLO level on the memory store and at 10 and 100 streams on Redis, and for streaming 500 tokens at 10 and 100 streams on both stores. The misses at the SLO levels are listed row by row at the end of the overhead tables above. At 500 streams one process saturates a core: streaming passes every chunk through one event loop (the mock streams many times faster than a real provider), so requests queue before it handles them, and with Redis each admit reply also waits a full event-loop pass ([docs/benchmarks.md](docs/benchmarks.md#why-the-redis-store-misses-the-added-ttfb-target-at-500-streams-measured-2026-11-04)). In the single-process 150 KB row at 500 streams the load generator and the mock saturated too (the direct path's own TTFB outside the provider is above a second), so that row is an upper bound on the machine, not on the gateway alone. The 150 KB body also misses at 10 streams on Redis and at 100 streams on the client-side p99. The multi-worker table (`serve --workers`) puts the mock and the load generator in several processes, so the direct path stays fast, and runs the gateway as 1 to 4 processes: small non-streaming requests at 500 streams on Redis meet the targets with 2 and with 4 processes; streaming at 500 streams does not with any count in this run, and the 150 KB body goes from seconds to tens of milliseconds on the client side but still misses. On this laptop the gateway, the mock, the load generator, Redis and the desktop share the cores, and adding a fourth gateway process made the rows worse; docs/benchmarks.md has the numbers and the development runs in which streaming at 500 streams met the targets with 2 and 3 processes. The Redis rows run against a container behind Docker Desktop's network on macOS. Streaming totals vary from run to run by more than the gateway adds. The cache row shows that the naive proxy's damage depends on where the breakpoints are: on this session the flattened system block costs almost nothing, and conformance test C15b still fails it on the changed usage.

## Real sessions

Real Claude Code and Codex sessions through tokenyard against the real APIs, in two runs: Claude Code 2.1.316 and Codex 0.166.0 on 2026-11-02, Claude Code 2.1.317 and Codex 0.166.0 on 2026-11-03 (UTC). They ran through the live harness, which enforces a hard cap on the spend of all live runs together with tokenyard's own budget. The data is the anonymized export in [examples/live](examples/live): `live.ndjson.gz` (written by `traces export --anonymize` with a one-off salt that was never stored), the HTML report built from that file only, and `summary.json` (aggregates computed from it by `bench/live-summary.ts`). Tenants, teams, keys and repos are pseudonyms and client versions are dropped. Every linkable id (record and instance ids, the session, agent and prompt HMACs, the prefix hash of the tools and system block, guardrail value HMACs) is re-keyed with the export's salt, so equal values stay equal within the export but none of them matches the raw traces or another export. What is left in clear: timestamps, models, token counts, costs, route names and the policy revision (here the live policy's name). Traces never hold prompt text.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="examples/live/report-dark.png">
  <img alt="tokenyard cost report by session for the anonymized live export" src="examples/live/report-light.png" width="720">
</picture>

The report prices each request at its recorded cost; a refused request has none, so the report counts it as "unpriced" (for example "+11 unpriced") and adds nothing for it. Why each was refused is listed under Refusals below.

Cost per Claude Code session, tokenyard's own figure against the `total_cost_usd` Claude Code printed at the end of each session (copied from [the live log](test/live/claude-code.live.md)). Sessions 1 to 5 are the first run, 6 to 11 the second:

| Session | Model | Billed requests | Main and subagent turns | tokenyard | Claude Code | Cache hit ratio |
|---|---|---:|---|---:|---:|---:|
| 1 | Sonnet 5.5 | 7 | 4 and 3 | $0.171340 | $0.1713382 | 70.96% |
| 2 | Sonnet 5.5 | 5 | 3 and 2 | $0.099030 | $0.0990300 | 77.19% |
| 3 | Opus 5.5 | 2 | 2 and 0 | $0.158844 | $0.1588440 | 49.76% |
| 4 | Sonnet 5.5 | 1 | 1 and 0 | $0.074617 | $0.0746165 | 0.00% |
| 5 | Sonnet 5.5 | 3 | 3 and 0 | $0.012376 | $0.0123766 | 99.36% |
| 6 | Haiku 5.5 | 1 | 1 and 0 | $0.002157 | $0.002156575 | 0.00% |
| 7 | Haiku 5.5 | 17 | 11 and 5, plus 1 compaction | $0.012180 | $0.012180325 | 85.78% |
| 8 | Opus 5.5 | 2 | 2 and 0 | $0.101979 | $0.1019788 | 49.66% |
| 9 | Haiku 5.5 | 15 | 6 and 9 | $0.010198 | $0.010197095 | 83.14% |
| 10 | Haiku 5.5 | 0 | refused at the first request (budget block) | $0.000000 | $0 | n/a |
| 11 | Haiku 5.5 | 7 | 7 and 0, then refused (budget block) | $0.002590 | $0.002589415 | 95.55% |

- **Cost.** Over the 11 sessions tokenyard counted $0.645311 and Claude Code $0.6453075. tokenyard rounds each request half up to a whole micro-USD; Claude Code reports a float. Per request, the token counts were equal to Claude Code's own OTel `api_request` events wherever both were captured. In the second run all 42 OTel `api_request` events joined one to one to a trace record: OTel $0.12910221, tokenyard $0.129104, a difference of 1.79 micro-USD (0.00139%) in total and at most 0.495 micro-USD on one request ([the live log](test/live/claude-code.live.md) has the join).
- **Cache.** Cache reads were 78.27% of all prompt tokens over the 60 billed Claude Code requests (71.02% in the first run, 83.10% in the second). tokenyard forwards the body bytes unchanged, so the cache breakpoints Claude Code sets reach the provider as sent. The second run also sent one identical scripted 5-turn Haiku 5.5 session through the gateway and once direct, each starting cold: cache reads were 79.94087% of prompt tokens through the gateway and 79.94088% direct. The direct run went around the gateway's cap; it cost $0.002236, listed in `summary.json` (`run2FromLog`) and not in the total below. The same comparison on a 40-turn session is on the mock (Measured, cache economics).
- **Bound to actual (the tokenizer assumption).** 72 requests were billed in all (Claude Code, Codex and the scripted cache session). 65 used the bytes bound, and their billed input was 0.199 to 0.348 of it; 7 used the context-window bound. No billed request exceeded its bound: 0 violations.
- **Reservations.** An ordinary Claude Code turn reserved $1.66 to $1.84 on Sonnet 5.5, $3.30 to $3.58 on Opus 5.5 and up to $0.44 on Haiku 5.5, for turns that cost a few cents or less. A Sonnet turn whose history held a `tool_reference` block reserved $5.81 (context-window bound). Codex on gpt-5.4-mini reserved $0.69 to $0.74 for its first turn and $0.96 (first run) or $1.29 (second run, after the Responses worst case began counting cache writes on top of input) for each later one, whose encrypted reasoning items force the context-window bound.
- **Refusals.** In the first run 32 of the 53 recorded requests were refused. 25 by the budget: Claude Code's WebSearch request (one `web_search_20250305` server tool, `max_uses` 8) needs a worst-case reservation of $58.16 on Sonnet 5.5 (computed by the estimator from the traced features; a refused record carries no reservation), so all 11 attempts were refused, and 11 context-window Sonnet turns at $5.81 and 3 Opus requests at $9.15 from a client without a Claude Code User-Agent were refused for the same reason. To keep the runs small, the cap was lowered from the shell for each harness start: $3, then $5, then $8 (the cap is cumulative over all live runs). The Opus requests came during the $3 start, the Sonnet turns during the $5 start and the WebSearch requests during the $8 start, so each reservation was larger than its run's whole cap; spend already charged at those moments was $0.17, $0.50 and $0.51. Caps and amounts are in `summary.json`, the caps from the live logs. 6 were the first Codex attempt, refused because Codex sent a tool type the gateway did not know yet (it now looks inside it), and 1 asked for a model the live route does not allow. In the second run 7 of 58 were refused: 5 by the budget, on purpose (the budget block below), and 2 hand-made encoded bodies (`content-encoding`). The refusals are the hard bound working as designed; see Limitations.
- **Budget block.** In the second run the harness was restarted twice with the cap just above the spent amount. At $0.704842 (spent $0.674842) Claude Code's first request reserved $0.066392 and was refused at once with 429 and `x-should-retry: false`; `claude -p` printed the message after 1 s and made no retry, and Codex's first request (reservation $0.740598) got 429 `insufficient_quota` and Codex stopped after that 1 request. At $0.754842 a Haiku session with `max_tokens` of 1,000 had 7 requests admitted and billed, and the next one (reservation $0.07796 with $0.677432 spent) was refused, again shown at once. Every harness start in `summary.json` (`starts`) ended within its cap.
- **Codex.** One task in each run (read a file, add a one-line comment): 3 billed requests and $0.013388 in the first, 4 and $0.016497 in the second, cache reads 65.35% and 73.5% of prompt tokens. Codex 0.166.0 sent no `Content-Encoding` header to the API-key base URL; tokenyard forwards such bodies unchanged and refuses an encoded body with 400 before reading it. Details and the `response.completed` usage shape are in [the Codex live log](test/live/codex.live.md).
- **Total live spend**, every request, by tokenyard's own counter: $0.677432 ($0.529595 in the first run, $0.147837 in the second). Every billed request was settled by the request itself and none overran its reservation (0 overruns).

The estimator calibration rows at the end of the Measured block come from the same live runs.

## Conformance

[docs/conformance.md](docs/conformance.md) is generated from the test names in `test/conformance/`: rules C1 to C18 for Anthropic Messages (Claude Code) and R1 to R8 for OpenAI Responses (Codex), each a test that sends recorded or synthetic traffic through the gateway in front of a mock and compares what the provider received and what the client got back, each linked to the documentation it comes from. They run in CI on every push. Among them: body bytes upstream equal the client's bytes for every fixture (C1), headers including `anthropic-beta` forwarded verbatim (C2), no buffering of SSE (C6), truncated streams reach the client truncated and are settled from the usage seen (C8), client aborts close the upstream within 100 ms (C9), upstream errors forwarded unchanged (C10), and a 40-turn session with identical usage through tokenyard and direct (C15), with a deliberately naive proxy failing the same tests (C1b, C15b) to show they can fail.

Failure behaviour is tested the same way, against mocks: provider 5xx and 529, drops mid-stream, slow headers, refused and reset connections, clients that leave at any point or stop reading, Redis paused or unreachable under load, policy files caught mid-write and a flapping policy URL. After each scenario every request has exactly one trace line, is charged at least what the provider billed, fell back only before the first byte, and leaves nothing reserved. Scenarios, results and the fixes they led to: [docs/chaos.md](docs/chaos.md) (`npm run test:chaos`).

Invariants that must hold for any input are property tests and fuzzers with fixed seeds: budgets never above their limit and always released, the memory and Redis stores agreeing on the same operations, concurrent admits on one key matching a sequential model, replay reproducing every recorded decision of random request mixes, and the SSE parser, policy YAML loader, attribution headers, anonymizer and secret scanner under hostile input. List, seeds and findings: [docs/testing.md](docs/testing.md) (`npm run test:fuzz`).

Client versions checked by hand: Claude Code 2.1.316 (against the mock, then the live sessions above) and 2.1.317 (live), and Codex 0.166.0 (live, one task in each run). Every new client release can add fields, headers and beta values; the suite is re-run on new versions and the versions are recorded in that file.

## Budgets

**What is guaranteed.** With these premises:

- the `worst-case` estimator,
- a correct and complete price table (models, tiers, modifiers, server tools),
- `serverToolsWithoutMaxUses: block`,
- the tokenizer assumption (at most one input token per byte of body text; see Limitations),
- a provider that bills no more than the bound,

every request's actual cost is at most its own reservation, and the counter store admits a request only if spent plus reserved plus its estimate stays within the limit on every enforced level, checked and applied in one atomic call (a Lua script on Redis; a critical section without `await` in memory). Two invariants follow, for any number of concurrent requests whose reservation each fits the budget on its own:

1. **Reserved:** at every moment, on every enforced level, spent plus reserved is at most the limit.
2. **Settled:** spent is at most the limit at every moment, because settle replaces each reservation with an actual cost that is not larger.

The worst-case estimate prices every input token at the model's highest input-side rate (the 1 hour cache write rate in today's tables) times every modifier above one, bounds input by the body's byte count plus a fixed overhead (or by the whole context window for any body it cannot bound that way), bounds output by the client's own `max_tokens`, and multiplies both by the server-tool iteration limit when server tools are enabled, plus each tool's `max_uses` times its fee. Coding-agent bodies are never modified, so the client's own `max_tokens` is what the estimate uses.

**The proof.** `test/limits/budget-proof.test.ts` (G4) issues 1,000 requests at once (up to 100 in flight) against a $1 budget, with each actual cost drawn (seeded) between 0 and that request's reservation, and asserts after every admit that invariant 1 holds on the totals the store returns, that final spend is within the budget, that final spend equals the sum of settled costs exactly in micro-USD with nothing left reserved (no lost update), and that every rejection saw spent plus reserved plus its estimate above the limit. A fast-check property test checks that the memory store's admit outcomes equal a sequential model applied in the store's commit order. Every inference route goes through the same admit call, and `test/edge/route-coverage.test.ts` fails if one does not. CI runs it on the memory store in every test job, and on Redis in its `redis` job (`npm run test:redis`, Linux with Node 22, a throwaway `redis:7` container on loopback). The benchmark repeats the scenario through the whole gateway, 1,000 requests on their own open connections sent at the same moment, on both stores and both estimators: 16 admitted and 984 rejected each time, spent plus reserved never above $0.998049 after any admit, overspend $0, and final spend minus settled costs 0 micro-USD (the Budget correctness table in Measured).

**The concurrency trade-off.** Worst-case reservations are large. One Claude Code turn with a 150,000-byte body and `max_tokens` of 32,000 on Opus 5.5 reserves $2.0600; under a $25 session budget only 12 of 40 such turns sent at once were admitted in flight (12 at a time, not 12 in total), and the rest got 429 until earlier ones settled. The live sessions show the same in practice: ordinary turns reserved $1.66 to $3.58 for turns that cost cents (Real sessions). The `session-aware` estimator is meant to admit more concurrency in exchange for a weaker bound (overspend at most the sum, over requests in flight, of actual minus estimate), but in v0.1 it reserved the same $2.0600 in that benchmark, because the gateway does not yet pass it the session's previous cache read share and the route set no `reserveOutputTokens`. That is why the session budget in the example starts in audit mode.

**Restarts.** The memory store keeps spend in the process. After a restart it holds only what the `--trace-dir` warm-up seeds from the traces of the current windows, so without `--trace-dir` every restart starts each enforced budget from zero; `tokenyard serve` warns about this on stderr at start. `--store redis` keeps spend across restarts.

`onOverrun: allow-and-debit` lets a stream that outruns its reservation finish and puts the budget into debt, so the next request is blocked; under the premises an overrun cannot happen, and if one does the trace flags `overrun: true`. Cutting a coding-agent stream mid tool call would waste every token already spent, so it is not offered.

## Running several instances

One gateway process is single-threaded: in the benchmarks it saturates one core at a few hundred streams. To scale out, run several `tokenyard serve` processes (on one machine or several) behind a load balancer, all with `--store redis` on one Redis server and the same `TOKENYARD_TRACE_SALT`, and give each its own `--instance-id` (or let each pick one). Budgets, rate limits, concurrent request limits, session taint and the R11 latch then live in Redis and hold across processes; each process settles the requests it admitted, the sweeper lock lets one process at a time settle what a dead one left, and every process writes its own trace files, which `tokenyard traces export` merges. Sessions need no stickiness. `docker compose --profile redis up` runs two such gateways.

**Several processes from one command.** `tokenyard serve --workers <n>` (default 1) does the same on one machine without a load balancer: a primary process forks n workers with `node:cluster`, they share `--port`, and the primary serves no traffic itself; it hands each new connection to the next worker (round robin, also on Windows). `n` is a whole number from 1 to the CPU count, and more than 1 needs `--store redis`: on the memory store each process would keep its own budgets, so `serve` refuses. Every worker is a whole gateway:

- its own instance id, `<instance>-w<k>` where `<instance>` is `--instance-id` or the default and k counts every fork, replacements included, so each process writes its own trace files and `traces export` and `policy replay` see one instance per process (an instance id is never reused by a later process);
- its own policy loader, so a change to the policy directory (or the bundle URL) reaches every worker;
- its own sweeper; the Redis sweep lock lets one process sweep per interval, and a sweep settles a reservation only once whoever runs it;
- its own ops listener: worker k serves `/metrics`, `/healthz` and `/readyz` on `--metrics-port` plus k minus 1 (9464 to 9466 for 3 workers by default), each answering for its own process, so scrape them as separate targets; `serve` refuses a range past port 65535.

A worker that exits after it was ready is logged and replaced by a new process in the same slot (its open reservations are swept from Redis like those of any instance that died). A worker that exits before it is ready (a bad policy, Redis unreachable, the port taken) stops every worker and the primary exits 1, and so do more than 5 crashes within a minute, so a supervisor such as systemd or Kubernetes sees the failure instead of a restart loop. SIGTERM or SIGINT to the primary drains every worker as below and the primary exits 0 once all have; a second signal cuts at once. The primary passes the drain to the workers over the cluster's IPC channel, not as a signal, because on Windows processes cannot signal each other (there only Ctrl+C in the console reaches the gateway, as SIGINT). The URL is printed on stdout once every worker listens.

This is how the soak in [Measured](#measured) runs its Redis row: two gateway processes behind one Redis for 45 minutes, each at about a third of a core. Across both processes, every enforced budget key ended with spent within its limit, every key's concurrent request limit held, and a secret sent through one gateway tainted the session on the other. Heap after GC, descriptors, sockets, handles and Redis keys stayed within the soak's thresholds; RSS did not (a step at the same moment in both gateways and in the unrelated mock process, with the heap flat), so that run passed 27 of 29 checks; [docs/benchmarks.md](docs/benchmarks.md#soak-benchsoakts) has the numbers. Since then the primary memory check is heap after GC plus external memory, and RSS is judged against the mock process as a control; the memory-store row was rerun that way and passed all 15 checks, the Redis row has not been rerun yet. The R11 latch across processes is covered by `npm run test:redis`, not by the soak. `serve --workers` is tested in `npm run test:redis` (`test/cli/serve-workers.test.ts`: two workers on one port with their own trace files through export and replay, the budget proof spread over three workers, a policy change reaching every worker, the drain on SIGTERM) and, without Redis on Linux and Windows, by `test/edge/cluster.test.ts` (port sharing, replacement after a crash, startup failure, crash loop).

**Shutdown.** On SIGTERM or SIGINT `tokenyard serve` drains: it stops accepting connections, `/readyz` answers 503 (`draining`), and requests and streams in flight get up to `--shutdown-grace-ms` (default 30000, at most 2147483647, the Node timer maximum; larger values are refused) to finish and settle at their actual cost. Idle keep-alive connections close at once, and a connection whose answer ends during the drain closes after it. What still runs when the grace period ends is cut and settles at its reservation, as any cut stream does; a second signal cuts at once, and `--shutdown-grace-ms 0` stops at once as before. Give the orchestrator a termination grace period longer than the drain (Kubernetes `terminationGracePeriodSeconds` defaults to 30 s, the same as the default drain).

## How it differs

Only what the cited sources say. "Not checked" means this README makes no claim either way.

| | tokenyard v0.1 | LiteLLM | Bifrost | Claude apps gateway |
|---|---|---|---|---|
| See what a policy change would do to recorded traffic before it ships | Yes: `policy replay` and a GitHub Action that comments on the pull request | Not found: a review of 15 gateways found replay or shadow evaluation in none ([deepinspect.ai](https://www.deepinspect.ai/blog/best-ai-gateway-2026)) | Not found (same review) | No: "Configuration is the YAML file; redeploy to change it" ([docs](https://code.claude.com/docs/en/claude-apps-gateway)) |
| Clients and models | Claude Code (Claude models only), Codex, product services | Not checked | Codex CLI guide ([docs](https://docs.getbifrost.ai/cli-agents/codex-cli)) | Claude Code, Claude models only, one issuer, Linux only ([docs](https://code.claude.com/docs/en/claude-apps-gateway)) |
| Request body on coding-agent routes | Forwarded byte for byte (conformance C1) | Open issues on lost thinking blocks ([#24985](https://github.com/BerriAI/litellm/issues/24985), [#32188](https://github.com/BerriAI/litellm/issues/32188)) and 400s on `output_config.effort` in passthrough ([#25877](https://github.com/BerriAI/litellm/issues/25877)) | Not checked | Not checked |
| Budgets under concurrency | Reserve then settle in one atomic admit; proof test above | Issues: 5 concurrent requests used 6.6 times a 100 TPM limit ([#18730](https://github.com/BerriAI/litellm/issues/18730)); lost counter updates ([#20977](https://github.com/BerriAI/litellm/issues/20977)); an aborted stream released its reservation as zero ([#35568](https://github.com/BerriAI/litellm/issues/35568)) | Not checked | Spend limits ([docs](https://code.claude.com/docs/en/claude-apps-gateway)) |
| Added p99 latency on a local mock | See Measured; method and hardware differ, so not comparable | 0.7 ms (Rust path), 257.7 ms (Python proxy) in LiteLLM's July 2026 benchmark ([LiteLLM](https://docs.litellm.ai/blog/rust-ai-gateway-benchmarks)) | 4.5 ms in the same benchmark | Not checked |

tokenyard does not try to win on speed; a TypeScript gateway will not. What it adds is the replay, the budget guarantee with its proof, and protocol fidelity for coding agents.

## Security, privacy and supply chain

- **Keys.** Developer keys are `ty_live_` plus 43 base62 characters, printed once and stored as SHA-256 only; revoking one is deleting its line (hot reload). The prefix lets secret scanners, tokenyard's own rule included, find leaked keys. Provider keys stay in the gateway's environment, are never logged or reflected, and upstream URLs come only from the policy; upstream redirects are not followed.
- **Identity comes from the key.** Tenant, team, traffic class and billing come from the key. Client-asserted fields (request class, agent type, session, repo, branch, ticket, feature, User-Agent) are attribution only and not a security boundary: a route that matches on them can choose a chain or a rewrite, but never grants a model the key's own routes do not allow, and `policy check` warns when it would. Session budgets and request-class routing are best effort; hard limits belong on key, team and tenant.
- **No content in traces.** Traces hold features and decisions, never prompt text, tool content, file paths from bodies or credentials; session, agent and prompt ids are HMAC-SHA256 pseudonyms, and a model name the price table does not price is written as a salted pseudonym `model-<hex>`. OTel content attributes are never set. `traces export --anonymize` replaces tenant, team, key, repo, branch, ticket and feature with salted pseudonyms and drops the client version; its salt is a one-off (`TOKENYARD_EXPORT_SALT`, `--salt-file`, or by default a random salt that is never stored) and is refused when it equals the trace salt (`TOKENYARD_TRACE_SALT` or `--trace-salt-file`).
- **No secrets on the command line.** The trace salt, the metrics token, a Redis URL with a password and the export salt come from the environment or a `--*-file <path>`; `--trace-salt`, `--metrics-token`, `--salt` and a `--redis-url` with credentials are refused, because every local user can read command lines.
- **Secret guardrail.** The newest turn is scanned with every rule and the history with the block rules before admit; a hit blocks the request (or warns) on coding-agent traffic and taints the session, and is redacted only on product traffic. The scan runs on decoded JSON strings, with a fallback to raw bytes for malformed bodies. It cannot stop prompt injection or the agent exfiltrating data locally.
- **Policy is data.** YAML parsed by Zod, never executed. The GitHub Action runs the bundle from the base commit (or a pinned release), so a pull request cannot change the code that judges it; the base policy is read from the base commit's git objects, never from a working-tree path a pull request could plant; symlinked policy files are refused; only the bot's own comment is updated; fork pull requests get the job summary only and no trace token.
- **Paths.** Every user-controlled path is opened without following symbolic links below a trusted root (the OpenSSH `safe_path` rule for system links), with bounded reads.
- **File modes.** Trace files, exports, HTML reports, replay JSON and the last-known-good policy file are created 0600, in directories created 0700; an existing trace or export file is narrowed to 0600 when written again.
- **Ops endpoints.** `/metrics` is served only on a separate ops listener, on 127.0.0.1 by default; bound beyond loopback it requires a bearer token. Without a token, `/metrics` and `/readyz` answer only requests whose `Host` is a loopback address or `localhost` (421 otherwise), so a web page cannot read them through DNS rebinding; `/healthz` answers any `Host`. The same rules hold on the API port, which serves `/healthz` and `/readyz` too (never `/metrics`). `/readyz` never asks for the token: with one set it answers any `Host`, and only `/metrics` checks the bearer token. A Kubernetes `httpGet` probe sends the pod IP as `Host`, so without a token a `/readyz` readiness probe gets 421: add `httpHeaders: [{ name: Host, value: localhost }]` to the probe, or set a metrics token. `/healthz` works as a liveness probe as it is. Metric label values come from bounded sets.
- **Container.** The image runs as a non-root user with a read-only root filesystem, all capabilities dropped and one writable data volume; compose publishes ports on 127.0.0.1 only.
- **Supply chain.** No runtime dependencies in the published package: everything is bundled into one committed file, `bin/tokenyard.mjs`, and CI fails when it differs from a fresh build. Lockfile committed. `npm run check:secrets` applies the gateway's own secret rules to every tracked file (inside `.gz` files too) and, in CI, to every entry of the packed npm tarball; a pre-commit hook in `.githooks/` runs it on the staged files before each commit once enabled with `git config core.hooksPath .githooks`. Publishing with npm provenance is planned for the first release; it is not done yet.

## Limitations

- **The tokenizer assumption is tested, not proven (R11).** The bytes bound rests on at most one token per byte of text, which holds for byte-level BPE but is not published for Claude's tokenizer. Every live run and the calibration benchmark check billed input against the bound; one violation turns the bytes bound off (every request then uses the context-window bound) until the factor is understood. The switch is a key in the counter store (`ty:{_global}:r11`, no expiry), so every instance on the same store and every restart keeps it; an instance reads it before its first request and every 30 s after that, so another instance follows within 30 s. Delete the key to turn the bytes bound back on. So far: no violation.
- **Worst-case reservations can exceed a small budget outright.** A request with a server tool is bounded by the tool's iteration limit times the whole context window: Claude Code's WebSearch request reserves $58.16 on Sonnet 5.5 (computed from the live traces' features with price table version 2026-11-03), so it is refused under any smaller budget, and Claude Code then reports the tool as failed. A history with a `tool_reference` block (Claude Code's deferred tool search), Codex's encrypted reasoning items, and OpenAI built-in client tools (`local_shell`, `apply_patch`, local `shell`) force the context-window bound, $5.81 per Sonnet 5.5 turn and $0.96 to $1.29 per gpt-5.4-mini turn in the live runs. This is the price of a hard bound.
- **`session-aware` reserves the same as `worst-case` in v0.1**, because the gateway does not yet give it the session's previous cache read share. Under either estimator a request that ends without its final usage (a stream cut before `message_delta`, an unpriced answer) is charged the worst-case estimate, not the lower session-aware reservation.
- **Retries after a refusal.** tokenyard's refusals that waiting cannot clear (budget, secret, taint, model or server tool not allowed, unpriced) carry `x-should-retry: false`. Claude Code honours it and shows the message at once. Codex 0.166.0 does not on a 403: it retried one five times before printing it. On the budget block (429 `insufficient_quota`) it stopped at once.
- **Unpriced means refused.** Server tool prices are per provider: OpenAI tools are keyed `openai/<type>` in the price table, so an Anthropic entry never prices an OpenAI tool of the same name. The example table prices OpenAI `web_search` ($10 per 1,000 calls, each `web_search_call` output item is charged); other OpenAI built-in server tools and named service tiers (`priority`, `flex` and others) have no prices, so those requests are refused rather than priced as standard. A priced OpenAI tool whose calls the gateway does not count settles at its full reservation. MCP connector tools and unknown tool types are treated as unpriced server tools.
- **No `/v1/chat/completions`** in v0.1 (cut from the schedule): Cline, OpenCode and Chat Completions product traffic are not supported. Codex works over Responses only, without WebSocket transport (`supports_websockets = false`).
- **Behind any gateway, Claude Code loses some features** ([Connect](https://code.claude.com/docs/en/llm-gateway-connect.md)): Remote Control and voice dictation are unavailable with a gateway credential, Remote Control is disabled with a non-Anthropic `ANTHROPIC_BASE_URL`, and gateway sessions are not eligible for the HIPAA configuration.
- **A session budget resets after the session is idle.** Session ids come from the client, so session state cannot live forever: a session budget level (and the session's marker) expires `sessions.idleTtlHours` (default 24) after the session's last request, and a session that comes back later starts that budget from zero. A session that reaches its budget is blocked until then. One key may start `sessions.newPerKeyPerHour` (default 1,000) new sessions an hour, a service key `sessions.newPerServiceKeyPerHour` (default 10,000), and a key's own `maxNewSessionsPerHour` in keys.yaml overrides either; a client that sends a new session id with every request is refused once it has used that allowance (S-V2-1 in docs/security-review.md).
- **Bodies that cost too much to scan are refused.** The secret scan's cost grows with JSON values, escapes and rule matches, not only with bytes, so a request body gets 413 `scan-budget` (`x-should-retry: false`, nothing sent) when it holds more than 1,048,576 JSON values or 1,048,576 escape sequences, or when its scan needs more than 3,145,728 decoded pieces or 65,536 rule matches (S-V3-1, S-V3-3). Ordinary JSON-encoded source has one escape per 16 to 30 bytes, so this allows 16 to 30 MiB of it; the benchmark's 31 MiB coding-agent body, about eight times a 1 M token context, stays within all four (82% of the escapes, 58% of the decoded pieces). Within them the scan still costs time in proportion to the bytes, bounded by the 32 MiB cap: the slowest 32 MiB bodies measured (Apple M2 Pro, Node 22) held the event loop for up to 0.68 s on a coding-agent route and 1.24 s on a product route when answered (one 32 MiB bare number), and up to 1.11 s and 2.19 s when refused with 400 after the scan, because JSON that does not parse or repeats a key is scanned both raw and decoded first (32 MiB of private key header lines without an end line) (docs/chaos.md).
- **Write policy files atomically.** A changed policy directory activates only when two reads 250 ms apart agree, so a file caught mid-write is not activated; a writer slower than that can still be caught. Use a temporary file and a rename, as most editors and `git checkout` do.
- **Redis Cluster is not supported.** All keys of one tenant share a hash tag, but the settle and sweep scripts touch keys they do not declare and the sweeper scans with `SCAN`, which does not cover a cluster. Use a single Redis server. The Redis tests (`npm run test:redis`) run against a single server, in CI's `redis` job (Linux, Node 22) and locally with Docker.
- **A rolling restart waits for streams, up to a limit.** A stream still running `--shutdown-grace-ms` (default 30 s) after SIGTERM is cut and charged its full reservation, since its final usage never arrives (Running several instances, Shutdown).
- **Memory-store budgets survive a restart only through `--trace-dir`.** Without it a restarted `--store memory` gateway starts every enforced budget window from zero, and `serve` warns on stderr at start. Use `--trace-dir` (warm-up) or `--store redis`. `serve` also warns at start for each provider whose credential variable is unset (its requests get the provider's 401).
- **A stable trace salt is required** for session taint to hold across restarts and instances: `--store redis` refuses to start without `TOKENYARD_TRACE_SALT` or `--trace-salt-file`, and the memory store keeps taint only for the life of the process.
- **`/metrics` exposes tenant, team and route names.** It is on the ops listener only (127.0.0.1:9464 by default, `--no-metrics` to turn it off); binding it beyond loopback requires a token (`TOKENYARD_METRICS_TOKEN` or `--metrics-token-file`). `/healthz` and `/readyz` never ask for the token, but without one `/readyz` answers only a loopback `Host` (421 otherwise), so a Kubernetes readiness probe needs `Host: localhost` or a token (Security, Ops endpoints).
- **Symbolic links in configured paths.** A link in a CLI or config path is accepted only when the link and every directory above it are owned by root and not group- or world-writable; a symlinked config directory owned by a normal user is refused, so pass the real path. "Root" means uid 0 as the process sees it: in a rootless container or a user namespace that may be an unprivileged host user, and when tokenyard runs as root, every link root created is trusted. On Windows only the no-links-below-the-root rule applies.
- **Client-asserted headers are not a security boundary** (see Security). The `policy check` warning about header-matched routes uses a static approximation of the runtime check and can differ from it in some configurations.
- **Replay limits.** The exactness table above is the whole claim. Cross-instance admit order on Redis is approximated; session taint from before `--since` is not rebuilt; a new secret rule cannot be replayed; latency and answer quality are not computed.
- **Repo and branch attribution is fixed at launch** of Claude Code (`tokenyard env`), so a branch switch mid-session is not reflected.
- **The demo pull request is not open yet.** The picture at the top is a local render of the comment Markdown. The Action writes `replay.json` and exposes its path as an output but does not upload it; add an `actions/upload-artifact` step as `.github/workflows/policy-replay.yml` does.
- **The last-known-good file is checked for corruption, not authenticated.** Its sha256 catches a torn or accidentally edited copy; anyone who can write `--state-dir` as the gateway's user can write a valid one. The file must be owned by that user with mode 0600 and is refused otherwise; keep the state directory private to the gateway, like the trace directory.
- **Docker Compose 2.20 or later** is needed for the compose demo (optional dependencies between profiles).
- **The live cap is per package checkout.** `npm run live` keeps its spend in `.live/traces` under the package root, so two checkouts or worktrees of the repository each get the full `TOKENYARD_LIVE_BUDGET_USD` cap. Run live tests from one checkout only.
- **Measured on one laptop against a mock.** The SLO rows that say "missed" are missed; the policy propagation and error-rate SLOs are production measures and are not measured here.
- **PII redaction on product routes** skips 13-digit integers in the epoch-millisecond range when matching card numbers, to avoid redacting timestamps.

## Development

```sh
npm ci
npm test                 # unit, conformance, budget proof (memory store), docs checks
npm run test:redis       # Redis store, G4 on Redis and taint (starts a throwaway local Redis in Docker)
npm run test:chaos       # chaos and failure scenarios, long runs and Redis outages included (docs/chaos.md)
npm run test:fuzz        # property tests and fuzzers with 20 times the runs, Redis included (docs/testing.md)
npm run test:coverage    # the suite with V8 coverage and per-module thresholds (docs/quality-gates.md)
npm run test:mutation    # Stryker on decide, the budget accounting, the estimator and the scanner (docs/quality-gates.md)
npm run test:pack        # pack the tarball, install it into an empty project, run the command
npm run check            # typecheck, lint, check:bundle, check:secrets and bench:check in one command
npm run typecheck && npm run lint
npm run build            # rebuild bin/tokenyard.mjs; commit it with any change under src/
npm run check:bundle     # fails when the committed bundle is stale
npm run check:secrets    # the gateway's secret rules over tracked files, .gz files and tar entries; add a .tgz to scan it
git config core.hooksPath .githooks   # once per clone: the pre-commit hook scans the staged files with the same rules
npm run bench            # writes bench/results.json; then node scripts/bench-to-readme.mjs --write README.md
npm run bench:check      # fails when the README block differs from bench/results.json
```

TypeScript strict, ESM, Vitest, raw `node:http`, `undici` upstream, Node 20.19 or later (CI on Linux and Windows: the suite on Node 22 and 24, the packed bundle on Node 20.19; quality gates in [docs/quality-gates.md](docs/quality-gates.md)). The design is in [docs/superpowers/specs/2026-11-02-gateway-design.md](docs/superpowers/specs/2026-11-02-gateway-design.md); designed but not built: [quality evaluation](docs/future-quality.md). Changes: [CHANGELOG.md](CHANGELOG.md).

## Publishing

The package sets `publishConfig.provenance: true`, so a local `npm publish` fails outside a supported CI provider (npm cannot sign provenance from a laptop). A hand publish needs `npm publish --provenance=false`; a provenance-signed release needs a later trusted publish job with `id-token: write`, which CI does not have yet.

Licence: MIT.
