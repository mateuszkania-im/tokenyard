# tokenyard

[![ci](https://github.com/mateuszkania-im/tokenyard/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/mateuszkania-im/tokenyard/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@mateuszkania-im/tokenyard)](https://www.npmjs.com/package/@mateuszkania-im/tokenyard)
[![license](https://img.shields.io/github/license/mateuszkania-im/tokenyard)](LICENSE)

Policy CI for coding-agent traffic.

tokenyard is an LLM gateway in TypeScript for Claude Code and Codex traffic. It enforces budgets, rate limits, model allowlists and secret guardrails, and attributes the cost of every request to a team, repo and session. The policy is a YAML file in git, and every pull request that changes it gets a comment computed by replaying recorded traffic through the new policy: which requests would route elsewhere or be blocked, which budgets would be hit, the cost delta, and how many agent sessions would be cut off mid-task.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/demo-comment-dark.png">
  <img alt="The policy replay comment for the demo policy change: cost -5.6% (estimated), 200 requests rerouted, 5 sessions cut mid-task by a tighter team budget, check failed on purpose" src="docs/demo-comment-light.png" width="720">
</picture>

See it live: [pull request #2](https://github.com/mateuszkania-im/tokenyard/pull/2) is a standing demo where the `policy replay` workflow comments on a policy change (it is never merged).

## Quick start

No API key is needed: the demo runs against deterministic mock providers. It sends 7 days of synthetic traffic from 8 developers in 3 teams through the gateway, then replays the demo policy change.

```sh
npx @mateuszkania-im/tokenyard demo        # Node 20.19 or later, no Docker
```

From a clone (`bin/tokenyard.mjs` is the committed bundle):

```sh
git clone https://github.com/mateuszkania-im/tokenyard && cd tokenyard
node bin/tokenyard.mjs demo
```

With Docker Compose 2.20 or later (mock providers, the gateway, a traffic generator, then the replay report):

```sh
docker compose up --build --abort-on-container-exit --exit-code-from traffic
```

## Use it

[docs/usage.md](docs/usage.md) is the step-by-step setup for a team: install, policy directory, keys, `tokenyard serve`, Claude Code and Codex pointed at the gateway, cost reports, the replay Action in CI and several processes. For Claude Code it comes down to two variables per developer:

```sh
export ANTHROPIC_BASE_URL=https://tokenyard.internal.example
export ANTHROPIC_AUTH_TOKEN=ty_live_xxxxxxxx
```

## How it works

- **The request path only does mechanism.** The agent's bytes are forwarded unchanged (streaming included); the gateway checks the request against the policy, records the decision and settles the cost.
- **Budgets reserve, then settle.** Before a request goes upstream, its worst-case cost is reserved in one atomic call; when it ends, the reservation is replaced by the actual cost. The counters live in memory or in Redis (a Lua script), so concurrent requests cannot overspend an enforced budget. Details and the proof test: [docs/budgets.md](docs/budgets.md).
- **Secret guardrail with session taint.** The newest turn is scanned before admit; a secret blocks the request on coding-agent traffic and taints the session, so later requests in it are refused too. Product traffic is redacted instead.
- **Traces without content.** Each request writes one NDJSON decision record with features and costs, never prompt text; session, agent and prompt ids are HMAC pseudonyms.
- **Policy in git, replayed in CI.** `tokenyard policy replay` runs the base and the head policy over a trace export and diffs them. The GitHub Action (`action.yml`) posts the result as one pull request comment and fails the check on the gates the policy sets. What replay can and cannot answer: [docs/replay.md](docs/replay.md).
- **Several processes.** `tokenyard serve --workers <n>` runs n gateway processes on one port; with `--store redis` several machines share budgets, rate limits and taint. See [docs/scaling.md](docs/scaling.md).

## Quality

| What | Result | Where |
|---|---|---|
| Test suite | about 1,100 Vitest tests; CI on Linux and Windows, the suite on Node 22 and 24, the packed bundle on Node 20.19 | [quality-gates.md](docs/quality-gates.md) |
| Conformance | rules C1 to C18 (Anthropic Messages, Claude Code) and R1 to R8 (OpenAI Responses, Codex), 42 tests, run in CI on every push | [conformance.md](docs/conformance.md) |
| Mutation testing | score 86.88% on the decision, budget, estimator and scanner modules; the run fails under 80 | [quality-gates.md](docs/quality-gates.md#mutation-testing) |
| Line coverage | 90.48% of src, with per-module thresholds | [quality-gates.md](docs/quality-gates.md#coverage) |
| 45-minute soak | memory store 15 of 15 checks; two gateways on one Redis 30 of 30 checks (2026-11-04) | [scaling.md](docs/scaling.md), [benchmarks.md](docs/benchmarks.md#soak-benchsoakts) |
| Budget correctness | $0 over the budget with 1,000 requests sent at once, on both stores | [benchmarks.md](docs/benchmarks.md#measured) |
| Gateway overhead | added time to first byte 0.5 / 1.59 ms (p50 / p99) at 10 streams on the memory store, against targets of 5 / 25 ms; on a laptop against a mock | [benchmarks.md](docs/benchmarks.md#measured) |

## Limitations

- **Measured on one laptop against a mock provider.** At 500 concurrent streams on the Redis store, streaming requests miss the added-latency targets with 1 to 4 gateway processes; [docs/benchmarks.md](docs/benchmarks.md) has every row and why.
- **Worst-case reservations are large.** A Claude Code WebSearch request reserves $58.16 on Sonnet 5.5, so it is refused under any smaller budget. This is the price of a hard bound.
- **The tokenizer assumption is tested, not proven.** The input bound assumes at most one token per byte of text; every live run checks it, and one violation turns that bound off.
- **No `/v1/chat/completions`.** Codex works over Responses only, without WebSocket transport.
- **Redis Cluster is not supported.** Use a single Redis server.
- **Replay never measures answer quality,** and a new secret rule cannot be replayed, because traces hold no content.

The full list: [docs/security.md](docs/security.md#limitations).

## Documentation

- [Usage](docs/usage.md): setting it up for a team, step by step
- [Clients](docs/clients.md): Claude Code (managed settings too) and Codex configuration
- [The policy file](docs/policy.md): the example policy, annotated
- [Budgets](docs/budgets.md): what is guaranteed, the proof, the concurrency trade-off
- [Replay](docs/replay.md): what replay can and cannot tell you
- [Replay JSON](docs/replay-json.md): the machine-readable replay output
- [Running several instances](docs/scaling.md): Redis, `serve --workers`, shutdown
- [Real sessions](docs/real-sessions.md): live Claude Code and Codex sessions, anonymized
- [Benchmarks](docs/benchmarks.md): every measured number and how to reproduce it
- [Conformance](docs/conformance.md), [chaos tests](docs/chaos.md), [property tests and fuzzing](docs/testing.md), [quality gates](docs/quality-gates.md)
- [Security and limitations](docs/security.md), [security review](docs/security-review.md)
- [How it differs](docs/comparison.md) from LiteLLM, Bifrost and the Claude apps gateway
- [Development](docs/development.md): commands, how it is tested, publishing
- [Design spec](docs/superpowers/specs/2026-11-02-gateway-design.md), [future quality evaluation](docs/future-quality.md), [CHANGELOG](CHANGELOG.md)

## License

MIT, see [LICENSE](LICENSE).
