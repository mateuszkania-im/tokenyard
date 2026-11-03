# tokenyard: design spec

Date: 2 November 2026. Status: brief approved by Mateusz Kania, spec for v0.1 (the 12-day MVP). Open questions resolved on 2 November 2026 (section 17).
Author of the brief: Mateusz Kania. Decisions taken while writing this spec, rather than by Mateusz, are marked **(my call)**; they can be changed by whoever builds it without asking. Decisions Mateusz took after reading the first draft are marked **(Mateusz, 2026-11-02)** and are not changed without asking him.

Research this spec is built on (in the author's notes, not in this repo): a market review of 15 gateways, Anthropic's Claude Code gateway documentation, budget and replay literature, and LiteLLM's issue history. Every fact that constrains the design cites its source inline.

## 1. Intent

tokenyard is an open-source LLM gateway in TypeScript for the traffic of coding agents. Claude Code is the first client, Codex the second, and product AI features (a service calling a model) the third. It does two jobs:

1. **In the request path, mechanism only.** It forwards Claude Code and Codex traffic without changing a byte, enforces budgets, rate limits, model allowlists and secret guardrails, attributes every request to a developer, team, repo, session, subagent and request class, and records a decision trace.
2. **Outside the request path, policy as code.** Routing, budgets, limits and guardrails live in a YAML file in git. Every pull request that changes the policy gets a comment computed by replaying recorded traffic through the proposed policy: which requests would route elsewhere, which would be blocked, which budgets would be hit, the cost delta, and how many agent sessions would have been cut off in the middle of a task.

The one-sentence pitch: **Policy CI for coding-agent traffic.** Change a budget or a route the way you change code: in a PR, with a diff of what it would have done to last week's traffic.

### Why this, and why now

- Speed is no longer a differentiator. In LiteLLM's July 2026 benchmark against a local mock, added p99 latency was 0.7 ms for LiteLLM's Rust path, 2.3 ms for Portkey, 4.5 ms for Bifrost and 257.7 ms for the LiteLLM Python proxy ([LiteLLM blog](https://docs.litellm.ai/blog/rust-ai-gateway-benchmarks)). A TypeScript gateway will not win that race and does not try to.
- Nobody tests policy changes before rollout. A review of 15 gateways found replay or shadow evaluation in none of them; policy testing is manual ([deepinspect.ai](https://www.deepinspect.ai/blog/best-ai-gateway-2026)). Request mirroring in Envoy AI Gateway exists only as an open proposal ([envoyproxy/ai-gateway #2137](https://github.com/envoyproxy/ai-gateway/issues/2137)).
- The most common complaints about gateways in front of Claude Code are protocol fidelity, not speed: lost thinking blocks ([LiteLLM #24985](https://github.com/BerriAI/litellm/issues/24985), [#32188](https://github.com/BerriAI/litellm/issues/32188)), 400s on `output_config.effort` even in passthrough ([#25877](https://github.com/BerriAI/litellm/issues/25877)). Anthropic's own guide says: "A gateway that rewrites or redacts request bodies for content inspection breaks the pairing the same way stripping does, so inspect without modifying" ([Claude Code gateway protocol](https://code.claude.com/docs/en/llm-gateway-protocol.md)).
- Budgets under concurrency are a known failure class: 5 concurrent requests used 6.6 times a 100 TPM limit ([LiteLLM #18730](https://github.com/BerriAI/litellm/issues/18730)); unprotected read-modify-write lost 75 to 93% of counter updates ([#20977](https://github.com/BerriAI/litellm/issues/20977)); an aborted stream released its reservation as zero ([#35568](https://github.com/BerriAI/litellm/issues/35568)); streamed requests still log as $0 in open issues as of 2 November 2026 ([#48937](https://github.com/BerriAI/litellm/issues/48937), [#37923](https://github.com/BerriAI/litellm/issues/37923)).
- Claude Code sends attribution headers that general gateways ignore: `x-claude-code-session-id`, `x-claude-code-agent-id`, `x-claude-code-parent-agent-id`, and with `CLAUDE_CODE_GATEWAY_HINT_HEADERS=1` also `x-claude-code-request-class` (`main`, `subagent`, `workflow`, `compaction`, `auxiliary`), `x-claude-code-agent-type` and `x-claude-code-prompt-id` ([Claude Code gateway protocol](https://code.claude.com/docs/en/llm-gateway-protocol.md)). That gives cost per session, per subagent and per user prompt for free.
- Anthropic's own Claude apps gateway covers SSO, model allowlists and spend limits for Claude Code, but "Configuration is the YAML file; redeploy to change it", it has one issuer (not multi-tenant), Claude models only, Linux only, and no way to see what a config change would do to traffic ([Claude apps gateway](https://code.claude.com/docs/en/claude-apps-gateway)). tokenyard is neutral (Claude Code, Codex, product features) and its core is the replay.

### Portfolio intent

This is a portfolio project for AI Platform Engineer roles. The ideas it must make visible: mechanism in the request path and policy outside it; safe rollout of config (validation at build and at load, atomic swap, last-known-good, audit mode before enforce); SLOs measured, not claimed; adoption with a two-line change; multi-tenant isolation; least privilege; evals of the gateway itself (conformance suite, budget proof, replay fidelity check); cost per request. The README must let a reviewer check each of these in under ten minutes.

## 2. Goals, non-goals, anti-goals

### Goals (v0.1)

| # | Goal | Done when |
|---|---|---|
| G1 | Protocol-faithful passthrough for Claude Code on `/v1/messages` (streaming and not) and for Codex on `/v1/responses` | Conformance suite (section 10) green; a real Claude Code session through tokenyard shows the same cache hit ratio as the same session direct to the mock provider |
| G2 | Policy as code: YAML, Zod schema, JSON Schema export, `policy check`, bundle with revision, hot swap, last-known-good, audit mode | Policy swap without restart, `tokenyard_policy_revision_info` reports the active revision |
| G3 | Replay in CI: `tokenyard policy replay` plus a GitHub Action that posts one sticky PR comment | The demo PR in this repo carries a real bot comment produced by the Action |
| G4 | Budgets that hold under concurrency: reserve then settle, atomic across tenant, team, key, repo and session; Redis and in-memory stores | The budget proof test (section 7.4) is green in CI on both stores: N = 1,000 concurrent requests against a $1 budget with the worst-case estimator, through a mock whose actual cost per request is drawn at random between 0 and that request's reservation. With every request's own reservation fitting the budget on its own, total admitted reserved cost never exceeds the budget at any admit, and total settled spend never exceeds the budget |
| G5 | Attribution per tenant, team, developer key, repo, branch, ticket, session, subagent, request class and prompt | `tokenyard report` splits cost by each; cost per request matches Claude Code's own `claude_code.api_request.cost_usd` on a real session |
| G6 | API billing (USD budgets, fallbacks) is the required mode. Subscription passthrough (OAuth token forwarded; visibility, guardrails, audit; cost shown as "API-equivalent") is **experimental**: off unless the gateway and `policy check` run with `--experimental-subscription`, and absent from the README until the terms question in R2 is answered (section 6.8) **(my call)** | A real Claude Code session on an API key works through tokenyard and appears in the report. Subscription passthrough: conformance tests against the mock are green (section 10, item 17); the manual check in `docs/experimental-subscription.md` is flagged "not run" and is not part of done |
| G7 | Secret guardrail: block or warn on coding-agent traffic, redact only on product traffic | False-positive corpus and scan time published in the README |
| G8 | One-command demo with deterministic mock providers, no API key | `docker compose up` and `npx @mateuszkania-im/tokenyard demo` both end with a replay report |
| G9 | OTel export with GenAI semantic conventions plus tokenyard attributes for cost, policy revision and route | Spans visible in a local collector in the compose `otel` profile |
| G10 | Every number in the README reproducible by one command | `npm run bench` writes `bench/results.json`; CI fails if the README block differs |

### Non-goals (v0.1, possibly later)

- Translation between provider formats (Anthropic to Bedrock, Anthropic to OpenAI). It is the largest source of 400s and lost cache in other gateways (section 15).
- Shadow traffic to a candidate route, golden-set evals, LLM-as-judge quality comparison. Designed in section 9.8, not built.
- Admin UI, web dashboard, REST API to change policy. Git is the source of truth.
- PII detection with NER (Presidio). Only regex PII on product routes.
- MCP gateway, semantic caching, Kubernetes operator, multi-region.
- Codex on a ChatGPT subscription (Bifrost's `backend-api/codex` pattern, [Bifrost Codex guide](https://docs.getbifrost.ai/cli-agents/codex-cli)). Codex is supported with API keys only.

### Anti-goals (things tokenyard must never do)

- **Modify a coding-agent request body.** No redaction, no field stripping, no reordering of `system`, no re-serialisation of JSON. The only exception is an explicit model alias rewrite on a route that opts in, and the schema forbids it on coding-agent traffic by default (section 6.4).
- **Route Claude Code to non-Claude models.** Anthropic "doesn't support routing Claude Code to non-Claude models through any gateway" ([LLM gateway](https://code.claude.com/docs/en/llm-gateway)). The schema rejects such a route.
- **Pool or share subscription credentials.** In subscription mode each developer's own OAuth token goes to the provider for that developer's own requests and nowhere else.
- **Store prompt content by default.** Traces hold features and decisions, not text.
- **Claim anything about answer quality from replay.** Replay answers "who, where, how much", never "how good".
- **Put an LLM call in the request path.** Guardrails are deterministic code.
- **Treat headers as identity.** Identity comes from the credential; headers are best-effort attribution.

## 3. Users and adoption

### Personas

- **Platform engineer (operator).** Runs tokenyard, owns the policy repo, reviews policy PRs. Wants to know what a change does before it ships, and wants a budget that cannot be overrun by parallel subagents.
- **Developer.** Uses Claude Code or Codex. Wants nothing to change in how the agent behaves; accepts two environment variables.
- **Team lead or FinOps.** Reads cost per team, repo, session and per active developer-day. Anthropic's published reference point is "around $13 per developer per active day and $150-250 per developer per month, with costs remaining below $30 per active day for 90% of users" ([Claude Code costs](https://code.claude.com/docs/en/costs)); the report shows the team's figure next to it.
- **Product engineer.** Calls a model from a service; gets the same budgets and traces, plus PII redaction, with a service key.

### Adoption story

1. **Operator, 10 minutes.** `docker compose up` (gateway plus Redis) or `npx @mateuszkania-im/tokenyard serve --policy policy/policy.yaml`. `tokenyard keys create --tenant acme --team web --name alice` prints a key once (`ty_` prefix, 32 random bytes, base62) and appends its SHA-256 hash to `keys.yaml`.
2. **Developer, two lines.**

   ```sh
   export ANTHROPIC_BASE_URL=https://tokenyard.internal.example
   export ANTHROPIC_AUTH_TOKEN=ty_live_xxxxxxxx
   ```

   Claude Code sends `ANTHROPIC_AUTH_TOKEN` as `Authorization: Bearer` and `ANTHROPIC_API_KEY` as `x-api-key`; a credential in the other variable arrives in a header the gateway does not read and fails with 401, so tokenyard accepts both ([Connect](https://code.claude.com/docs/en/llm-gateway-connect.md)).
3. **Fleet rollout with managed settings.** The operator distributes the same through Claude Code managed settings and pins the gateway as the only allowed destination with `allowedProviders: ["customEndpoint"]` (Claude Code v2.1.285 or later) ([LLM gateway](https://code.claude.com/docs/en/llm-gateway)):

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

   `apiKeyHelper` is a command that prints only the credential (cached 5 minutes by default; extra output makes it fail since v2.1.227) ([Connect](https://code.claude.com/docs/en/llm-gateway-connect.md)). `tokenyard-key` is an example name for a script that reads the key from the OS keychain; tokenyard does not ship it in v0.1.
4. **Repo and ticket attribution (optional).** Claude Code does not send repo or branch. `eval "$(tokenyard env)" && claude` sets `ANTHROPIC_CUSTOM_HEADERS` to `x-tokenyard-repo`, `x-tokenyard-branch` and `x-tokenyard-ticket` (ticket parsed from the branch name with a configurable regex). Headers are fixed at launch, so a branch switch mid-session is not reflected. Custom headers from project settings need approval in Claude Code, so they go in the environment or user settings ([Connect](https://code.claude.com/docs/en/llm-gateway-connect.md)).
5. **Subscription mode (experimental, off by default, not in the README; section 6.8).** The developer sets only `ANTHROPIC_BASE_URL` and `ANTHROPIC_CUSTOM_HEADERS="x-tokenyard-key: ty_live_xxxxxxxx"`, and no credential variable. Claude Code then keeps the claude.ai OAuth login as the credential; the gateway must forward the OAuth value in `anthropic-beta` or requests fail with 401 ([LLM gateway](https://code.claude.com/docs/en/llm-gateway)). With a credential variable set, the subscription is not used and traffic is billed per token to the upstream key owner ([LLM gateway](https://code.claude.com/docs/en/llm-gateway)). See risk R2 on whether this is allowed.
6. **Codex.** In `~/.codex/config.toml` (`wire_api = "responses"` is the only supported format since early 2026; Codex calls `{base_url}/responses`, so `base_url` includes `/v1`) ([Codex config](https://learn.chatgpt.com/docs/config-file/config-advanced), [Bifrost Codex guide](https://docs.getbifrost.ai/cli-agents/codex-cli)):

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

   `requires_openai_auth = false` and `supports_websockets = false` follow Bifrost's guide (third-party source; Codex prefers an existing OpenAI OAuth session, so the developer runs `/logout` first).
7. **Product feature.** A service key (`kind: service`) and the base URL in the official SDK. Traffic class comes from the key, never from a header.
8. **Rollout of a new limit.** Budgets start with `mode: audit` for a week: checked, logged, not enforced. Then a PR switches them to `enforce`, and the replay comment shows what enforcement would have done during that week. Stripe ran every rate limiter in observation mode before enforcing ([Stripe](https://stripe.com/blog/rate-limiters)); Kubernetes separates `Deny`, `Warn` and `Audit` on the binding ([Kubernetes VAP](https://www.kubernetes.io/docs/reference/access-authn-authz/validating-admission-policy/)).

## 4. Constraints

- **Language and tooling** (same as why-diff and read-receipts): TypeScript with `strict` and `noUncheckedIndexedAccess`, ESM, Vitest, esbuild bundle to one file `bin/tokenyard.mjs` committed and checked in CI (`npm run check:bundle`), no runtime dependencies in the published package (everything bundled), MIT licence, published as `@mateuszkania-im/tokenyard` with the command `tokenyard`, honest Limitations section, numbers in the README only if measured.
- **Node.** `engines` `>=20.19` and CI on Node 20.19, 22 and 24 on Linux, plus Node 22 on Windows (same matrix shape as read-receipts). Node 20 left maintenance on 30 April 2026, so the Docker image uses Node 24 **(my call)**. Nothing in v0.1 needs `node:sqlite`, which keeps Node 20 possible.
- **One package, not a monorepo** **(my call).** The research proposed a pnpm monorepo with ten packages. The siblings are single packages with one bundle, and the modules in section 5 are directories under `src/` with an import rule enforced by a test (`policy/` and `replay/` may not import `edge/`, `limits/redis-store.ts` or anything that does I/O). This keeps the purity boundary that makes replay possible without the overhead of workspaces.
- **Dependencies (bundled):** `undici` (upstream client: its `request`/`stream`/`dispatch` APIs measured about 3 times faster than `fetch` in its README, 18.5 to 20.8 thousand versus 5.4 thousand req/s, [nodejs/undici](https://github.com/nodejs/undici)), `zod` (schema and JSON Schema export), `yaml`, `redis` (node-redis, official client) **(my call over ioredis)**, `commander`, `picocolors`, and the OpenTelemetry JS packages loaded only when OTLP export is configured. Dev only: `vitest`, `esbuild`, `tsx`, `typescript`, `fast-check`, `oxlint`.
- **HTTP server:** raw `node:http` **(my call)**. Fastify measured nearly the same as raw `node:http` on Node 24 (POST 69.1 versus 72.2 thousand req/s; Express 44.1 thousand) ([fastify/benchmarks](https://github.com/fastify/benchmarks)); the gateway has few routes and no need for a framework.
- **Hot path budget:** at most one network round trip that is not the upstream call: the counter store's `admit`. Rate checks, budget reservations, the per-key concurrent stream cap and the session taint check and write all happen inside that one atomic call (a Redis Lua script, or its in-memory equivalent) **(my call)**. Everything else is in memory or after the response ends.
- **Live tests (Mateusz, 2026-11-02).** Real Claude Code and Codex sessions through the gateway are approved. They use the Anthropic API key in the repo's gitignored `.env` (`ANTHROPIC_API_KEY`, credits valid until 2026-11-16) with a hard cap of 20 USD in total across all live runs, enforced by tokenyard itself on the live-test traffic (`TOKENYARD_LIVE_BUDGET_USD=20`, section 14.1). The key value is never printed, logged, committed or copied anywhere else. Codex live tests run only when `OPENAI_API_KEY` is present in the environment, under the same 20 USD total cap **(my call)**; otherwise they run against the mock and are listed as "not verified live".
- **Build time:** about 12 working days, by coding agents, reviewed by Mateusz. The cut line in section 14 says what goes first if days slip.
- **Platforms:** the gateway, CLI and replay run on Linux, macOS and Windows. Redis-backed tests run on Linux in CI (service container); Windows runs the memory store.

## 5. Architecture

### 5.1 Planes

- **Data plane:** the `tokenyard serve` process. Stateless apart from in-memory caches; holds one compiled policy snapshot (plus an optional candidate in audit mode), talks to upstream providers and to the counter store, writes traces.
- **Control plane:** the policy repo and CI. `policy check` validates, `policy replay` computes the PR comment, `policy build` produces the bundle on merge, a static location (object storage, a web server, or a file path) serves it. There is no control plane server in v0.1: the "control plane" is git plus CI plus a static file, which is the point.
- **State:** the counter store (Redis, or memory for one instance) holds budget spend, reservations and rate-limit state. The trace store (NDJSON files) holds decision traces; it is both the ledger and the replay input.

### 5.2 Modules (`src/`)

| Directory | Responsibility | May do I/O |
|---|---|---|
| `edge/` | HTTP server, path matching, auth, header forwarding rules, error envelopes, request body reading with size cap | yes |
| `surfaces/` | One file per API surface: `anthropic-messages`, `anthropic-count-tokens`, `anthropic-models`, `openai-responses`, `openai-chat`. Feature extraction (read-only JSON parse) and the surface's error shape | no |
| `stream/` | SSE parser, the tee transform, usage accumulators for Anthropic, Responses and Chat Completions, abort handling | no (pure parsers; the tee is a Transform) |
| `upstream/` | undici pools per provider, chain executor, retry budget, circuit breakers | yes |
| `policy/` | Zod schema, JSON Schema export, semantic validation, compiler, `decide()`, `resolve()`, bundle format | no |
| `policy-loader/` | File watch, URL polling with ETag, last-known-good on disk, revision metrics | yes |
| `limits/` | `CounterStore` interface, `memory-store`, `redis-store` with Lua scripts, GCRA, reservation estimator, sweeper | store files yes, estimator no |
| `pricing/` | Price table loading and validation, cost function | no |
| `guardrails/` | Secret rules, scanner, session taint, PII rules and redaction for product traffic | no |
| `ledger/` | Trace record schema, writer (bounded async queue to NDJSON), reader, HMAC pseudonymisation | writer and reader yes |
| `replay/` | Replay engine, simulated counter store, cost model, diff, terminal, JSON and Markdown renderers | reads traces only |
| `telemetry/` | OTel spans and metrics, Prometheus text endpoint | yes |
| `report/` | `tokenyard report`: cost views from traces (terminal, `--json`, `--html`) | reads traces only |
| `mock/` | Deterministic Anthropic and OpenAI mock providers with a prompt-cache simulator, scenario knobs, synthetic agent traffic generator | yes |
| `cli.ts` | `serve`, `demo`, `mock`, `policy check|build|replay|schema`, `report`, `keys create`, `traces export`, `env` | yes |

### 5.3 Request lifecycle: Anthropic Messages, streaming

Timestamps are taken at each numbered step and stored on the trace.

1. **Accept.** Match on the path, not the full URL: Claude Code posts `/v1/messages?beta=true` ([Claude Code gateway protocol](https://code.claude.com/docs/en/llm-gateway-protocol.md)). An optional mount prefix (`--base-path`) is stripped first. `HEAD /api/hello` (connection warming) gets an empty 200 **(my call; the guide says it may be rejected safely)**.
2. **Authenticate.** Read the credential from `x-tokenyard-key`, then `Authorization: Bearer`, then `x-api-key`. Look up its SHA-256 in the in-memory key map (constant-time compare not needed on a hash lookup; the map is keyed by hash). Unknown key: 401 in the Anthropic error envelope. In subscription mode (experimental, 6.8) the key comes from `x-tokenyard-key` and `Authorization` carries the user's OAuth token, which is kept for forwarding and never logged.
3. **Read the body** into one `Buffer`, up to the configured cap (default 32 MiB **(my call; builder checks Anthropic's documented request size limit and matches it)**). Over the cap: 413 in the Anthropic envelope.
4. **Extract features** with one read-only `JSON.parse` of a copy: `model`, `stream`, `max_tokens`, tool count, `thinking` present, server tools enabled with their `max_uses`, the input token bound (section 7.3), number of `anthropic-beta` values, body size, SHA-256 of the canonical `tools` plus `system` bytes as `prefixHash` (to detect cache breaks between turns of a session), and attribution headers. The parsed object is never serialised again on coding-agent routes; the forwarder only ever sees the original `Buffer` (a type-level rule: the forwarder takes `Buffer`, not an object). **(updated 2026-11-03 during the build)** Every control rests on this parse of bytes that are forwarded unchanged, so a body another parser may read differently is refused with 400 in tokenyard's own envelope and `x-should-retry: false`: a `Content-Encoding` other than `identity` (checked before the body is read), a UTF-8 byte order mark, any key repeated inside one JSON object at any depth (one linear pass, objects and arrays nested more than 128 deep refused too), and, when an enforced budget level applies, JSON that does not parse (without one it is still forwarded, so the provider answers its own 400). A last-turn secret in such a body is still answered as a secret.
5. **Guardrails** (section 6.6), before admit and without any store call: scan the last message (the newest user turn and its `tool_result` blocks) with every rule, and the rest of the body with the `block` rules, reporting history hits only as HMACs of the matched values. Result: hits with action `block` or `warn`, each with `where: last-turn | history`.
6. **Decide** (pure, section 6.5): `decide(policy, features)` returns a plan: route, provider chain, reservations to make with their estimates, rate checks, stream slots, the taint check and taint writes, guardrail outcome.
7. **Admit:** one call to the counter store: GCRA checks, the per-key concurrent stream cap, the session taint check and write, and budget reservations, atomic across all levels (section 7). A request already blocked by a last-turn secret still makes this call when it has taint to write; the call then writes the taint and nothing else.
8. **Resolve** (pure): `resolve(policy, plan, admission)` returns forward or block. A block is answered in the Anthropic error envelope (section 5.6) and traced; no upstream call.
9. **Forward.** Headers per section 5.5; the original body bytes; `accept-encoding: identity` towards upstream on inference paths so the tee can parse plain text **(my call)**. An `AbortController` is tied to the client socket's `close`, so a cancelled Claude Code turn stops upstream generation.
10. **First response headers from upstream.** If the status is retryable (section 8) and nothing has been written to the client yet, try the next provider in the chain. Otherwise write status and headers to the client and flush them immediately. Add `x-tokenyard-request-id`, `x-tokenyard-policy-revision` and `X-Accel-Buffering: no`. Never compress the response.
11. **Body.** `pipeline(upstreamBody, tee, res)` with backpressure. The tee passes every chunk on unchanged before parsing it, so parsing cannot delay or alter bytes. The SSE parser takes `input_tokens`, `cache_creation_input_tokens` (with the 5m and 1h split) and `cache_read_input_tokens` from `message_start`, and overwrites with any values in later `message_delta` events, because "The token counts shown in the `usage` field of the `message_delta` event are *cumulative*" ([Anthropic streaming](https://platform.claude.com/docs/en/build-with-claude/streaming)). It notes `event: error` (for example `overloaded_error` after a 200), whether `message_stop` arrived, and ignores unknown event types. `ping` events pass through like any other bytes.
12. **End.** Usage source is `final` when `message_stop` was seen, `partial` when the stream ended or was aborted after `message_start` (input billed, output from the last `message_delta`, or, when there was none, flagged `estimated`), `none` when no `message_start` arrived. **(updated 2026-11-03 during the build)** A stream that ended without a final output count (no `message_delta` usage, whether it was aborted, cut or ended with `message_stop`) settles at the full reservation, as a Responses stream without terminal usage does (ruling S20-2), never at `ceil(streamed delta chars / 4)`: streamed characters bound nothing (summarized and redacted thinking are billed for tokens never streamed, CJK text is about one token per character), the client chooses when to abort, and the input count from `message_start` bounds nothing either, because with compaction or a server-tool loop most billed input arrives only in the final `message_delta` (`usage.iterations`). When the usage carries `iterations` (compaction), each bucket is the sum over the iterations, because the top-level fields leave the compaction iteration out ([Compaction at a token threshold](https://platform.claude.com/docs/en/build-with-claude/compaction-threshold#understanding-usage)). A truncated upstream stream reaches the client truncated: tokenyard never synthesises a `message_stop` (Claude Code treats a clean end after a started block as a dropped connection, which is the truth). Cost is computed (section 7.6), the reservation is settled and the stream slot released in the same store call (never released to zero when usage exists, the [#35568](https://github.com/BerriAI/litellm/issues/35568) bug), the trace is queued, the span ends. Settle and trace happen after `res.end()`.

Non-streaming requests follow the same steps; the body is piped unchanged and a copy is parsed for `usage` after the end.

`/v1/messages/count_tokens` is forwarded with the same header rules and no reservation; if the provider has no such endpoint the gateway returns 404 and Claude Code falls back to a character estimate ([Claude Code gateway protocol](https://code.claude.com/docs/en/llm-gateway-protocol.md)). `GET /v1/models` is answered by tokenyard itself from the models the key's routes allow, only ids that contain `claude` (Claude Code keeps only those), with no redirect and well inside the 3 s discovery timeout ([Claude Code gateway protocol](https://code.claude.com/docs/en/llm-gateway-protocol.md)).

### 5.4 Request lifecycle: OpenAI Responses, streaming (Codex)

Same steps 1 to 12, with these differences:

- Paths: `/v1/responses` and `/responses` (Codex appends `/responses` to `base_url`).
- Features: `model`, `stream`, `max_output_tokens` (when absent, the model's `maxOutputTokens` from the price table is used for the reservation), tool count, `reasoning` present, session from the `session_id` or `session-id` header. Codex sends a session header used by Bifrost for affinity, and third-party sources list `originator`, `session_id`, `version` and `thread_id`; there is no official list ([Bifrost Codex guide](https://docs.getbifrost.ai/cli-agents/codex-cli), [tokn-headers](https://docs.rs/tokn-headers/0.2.0/src/tokn_headers/schemas/personas/codex_cli.rs.html)). tokenyard reads them as best-effort attribution and forwards them unchanged.
- Usage: only in the terminal `response.completed` event; `response.incomplete` carries `incomplete_details`; `response.failed` carries an error ([OpenAI streaming events](https://developers.openai.com/api/reference/resources/responses/streaming-events)). The exact usage shape inside `response.completed` (`input_tokens`, `output_tokens`, `input_tokens_details.cached_tokens`) was not confirmed from a primary source in the research, so the accumulator is written against a recorded fixture on day 10 and a unit test pins it. A stream that ends without `response.completed` is settled as `partial` from streamed output text.
- Encrypted reasoning items and unknown fields pass through untouched (they are just bytes).
- WebSocket transport is not supported; the docs tell users to set `supports_websockets = false`.

`/v1/chat/completions` (Cline, OpenCode, product features) is a stretch goal for day 10. On product routes only, tokenyard may add `stream_options.include_usage = true` when the client did not ask, and then drops the extra usage chunk before it reaches that client, because without it an interrupted stream may never report usage ([OpenAI community](https://community.openai.com/t/usage-stats-now-available-when-using-streaming-with-the-chat-completions-api-or-completions-api/738156)). On coding-agent routes the body is never touched, so usage may be missing and the request is settled as `estimated`.

### 5.5 Header rules

Requests to upstream: forward every header **except** hop-by-hop headers (`connection`, `keep-alive`, `proxy-*`, `te`, `trailer`, `transfer-encoding`, `upgrade`), `host` (set to the upstream host), `content-length` (recomputed only when a product route changed the body), `accept-encoding` (set to `identity`), everything starting with `x-tokenyard-`, and the inbound credential, which is replaced by the provider credential in API mode and forwarded unchanged in passthrough mode. In API mode `openai-organization` and `openai-project` are dropped as well: the operator's key, not the client, decides which organization and project it bills **(updated 2026-11-03 during the build, security review C6)**. This is a denylist on purpose: `anthropic-beta` must be forwarded verbatim ("don't allowlist individual values"), headers and body fields are open lists, and a gateway pinned to an observed list breaks on the next release ([Claude Code gateway protocol](https://code.claude.com/docs/en/llm-gateway-protocol.md)). `x-claude-code-*` headers are forwarded too **(my call; the guide says they need not be, and forwarding keeps the request identical to a direct one)**.

Responses to the client: forward every header except hop-by-hop ones; `retry-after`, `x-should-retry` and `anthropic-ratelimit-unified-*` pass through unchanged ([Claude Code gateway protocol](https://code.claude.com/docs/en/llm-gateway-protocol.md)). tokenyard adds only its own `x-tokenyard-*` headers and `X-Accel-Buffering: no`. In API mode the provider account ids `anthropic-organization-id`, `openai-organization` and `openai-project` are dropped, and a non-2xx body is cut to 64 KiB (with a `[truncated by tokenyard]` marker) and has the provider credential and its masked forms (prefix, a mask, last four characters) replaced by `[redacted]` in everything forwarded, content-length recomputed (S25-3); such an answer with a content-encoding other than identity is replaced by tokenyard's own error with the same status, since compressed bytes cannot be checked; passthrough answers are forwarded as they are **(updated 2026-11-03 during the build, security review B2)**.

### 5.6 Errors

- **Upstream errors** are forwarded unchanged: status, headers and body bytes. Claude Code's automatic recovery (thinking type swap, `cache_control` moved, effort removed, and others) matches on the upstream's wording, and a gateway envelope breaks it ([Claude Code gateway protocol](https://code.claude.com/docs/en/llm-gateway-protocol.md)). Context-limit errors in the gateway's own words also stop auto-compaction ([Connect](https://code.claude.com/docs/en/llm-gateway-connect.md)).
- **tokenyard's own errors** use the surface's envelope: Anthropic `{"type":"error","error":{"type":"...","message":"tokenyard: ..."}}`, OpenAI `{"error":{"type":"...","code":"...","message":"tokenyard: ..."}}`, with `x-tokenyard-request-id`. Types **(my call; the builder confirms with a real Claude Code session on day 2 that each message is shown to the user and not retried in a loop)**:
  - rate limit: 429 `rate_limit_error` with `retry-after` as integer seconds, at most 60, because a value above 60 stops retries and shows the error at once ([Claude Code gateway protocol](https://code.claude.com/docs/en/llm-gateway-protocol.md));
  - budget exhausted: 429 `rate_limit_error` with no `retry-after`, which is how Anthropic answers a reached spend cap ([Anthropic rate limits](https://platform.claude.com/docs/en/api/rate-limits)), and a message naming the budget and when its window resets;
  - per-key concurrent stream cap reached: 429 `rate_limit_error` with `retry-after: 1`;
  - secret blocked, in the last turn or by session taint: 400 `invalid_request_error` naming the rule, the message index and what to do (`/clear`, rotate the key, add a deny rule for the file); never the secret itself;
  - model or route not allowed: 403 `permission_error`;
  - counter store down with `budgets: closed`: 503 `api_error` with `retry-after: 5`.

## 6. Policy

### 6.1 Principles

Taken from Envoy xDS, OPA bundles, Cedar and Kubernetes admission ([Envoy xDS](https://www.envoyproxy.io/docs/envoy/latest/api-docs/xds_protocol), [OPA bundles](https://www.openpolicyagent.org/docs/management-bundles), [Cedar](https://docs.cedarpolicy.com/overview/terminology.html)):

- A declarative artifact with a revision id, validated when written (CI) and again when loaded (gateway).
- Atomic activation of a whole snapshot; on any load failure the last good snapshot keeps running and the failure is reported, as Envoy does on NACK and OPA does on a failed bundle.
- The data plane reports which revision it runs, and every trace records it. Anthropic's own gateway logs a `config.load` event with the file's sha256 ([Claude apps gateway](https://code.claude.com/docs/en/claude-apps-gateway)).
- The caller supplies every input to the decision, Cedar style: the engine looks nothing up. This purity is what makes replay exact.
- Policy is **data, not code**: YAML, never a TypeScript config file **(my call)**. A PR can change a number or a route; it cannot run code in the gateway or in the CI job that replays it (section 11).

### 6.2 Files

A policy directory holds `policy.yaml`, `prices.yaml` and `keys.yaml` (hashes only, safe to commit to a private repo). `tokenyard policy schema > policy.schema.json` exports JSON Schema for editor completion.

### 6.3 Example

```yaml
# policy/policy.yaml
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
    serverTools: [web_search, tool_search_tool_regex, tool_search_tool_bm25]   # server tools are denied unless listed
  - name: codex
    match: { surface: openai-responses, traffic: coding-agent }
    chain: [openai]
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

`prices.yaml` (values from [Claude pricing](https://platform.claude.com/docs/en/about-claude/pricing), USD per million tokens; every entry carries its source URL and retrieval date):

```yaml
version: 2026-11-02
models:
  claude-opus-5-5:   { input: 4, output: 20, cacheWrite5m: 5,    cacheWrite1h: 8, cacheRead: 0.20,
                       source: https://platform.claude.com/docs/en/about-claude/pricing, retrieved: 2026-11-02 }
  claude-sonnet-5-5: { input: 2, output: 10, cacheWrite5m: 2.50, cacheWrite1h: 4, cacheRead: 0.10, source: ..., retrieved: ... }
  claude-haiku-5-5:  { input: 0.1, output: 0.5, cacheWrite5m: 0.125, cacheWrite1h: 0.2, cacheRead: 0.01, tiers: [...], source: ..., retrieved: ... }
modifiers:
  inferenceGeoUs: 1.1                 # all token categories, Claude 4.6 and later
serverTools:
  web_search: { perUseUsd: 0.01, maxIterations: 10, source: ..., retrieved: ... }   # $10 per 1,000 searches
```

**(updated 2026-11-03 during the build)** The example now matches `examples/policy/policy.yaml`: the product routes rewrite to `claude-haiku-5-5`, which is in the priced table (Haiku 4.5 is not, and no price is typed from memory); a `product-default` route allows the model for product traffic that sends no `feature` header, because header-derived match fields never grant access (section 11); and the `claude-code` route lists its `serverTools`, because a server tool type not listed on the matched route is refused (`server-tool-not-allowed`), so Claude Code's WebSearch and deferred tool search need the entry.

Every model entry also carries `maxContextTokens` and `maxOutputTokens` (the largest context window and output the model accepts with any beta header), copied from the models overview page with source and date, because the worst-case bound (7.3) needs them. Long-context `tiers` and every modifier are part of the table; the worst-case estimator uses the highest input-side rate across them.

### 6.4 Validation rules

Zod schema plus semantic checks; errors fail `policy check` and refuse a load, warnings are printed and shown in the PR comment.

Errors:

- Every provider in a chain exists; chains have 1 to 3 entries.
- A route whose `match.surface` is `anthropic-messages` and whose traffic is `coding-agent` may only chain `format: anthropic` providers.
- `rewriteModel` and `redact` are errors on `coding-agent` traffic, unless the route sets `allowBodyRewrite: true` and names the reason in `because:` (the escape hatch is explicit and greppable) **(my call)**.
- `credential: passthrough` only with the provider's official host (`api.anthropic.com`, `api.openai.com`), so a user's OAuth token can never be sent to a third-party host.
- `credential: passthrough`, keys with `billing: subscription` and routes matching `billing: subscription` are errors unless the gateway or `policy check` runs with `--experimental-subscription` (section 6.8).
- Every priced model has `maxContextTokens` and `maxOutputTokens`; every server tool type a route can see is priced or covered by `failure.unpricedModel` (the worst-case bound needs both, 7.3).
- Every model in `allowModels` patterns that resolves to a concrete id in `rewriteModel`, and every model a route can produce, has a price. A model without a price is an error, because unpriced models counted as $0 is a known failure in other gateways ([Portkey budget limits](https://portkey.ai/docs/product/ai-gateway/virtual-keys/budget-limits), [LiteLLM #48937](https://github.com/BerriAI/litellm/issues/48937)).
- Budget names unique; `window` is `day`, `week` or `month` (UTC) except `scope: session`, which has none; `usd > 0`.
- `failure.counterStoreDown.budgets` must be stated explicitly when any budget uses `mode: enforce`.
- **(updated 2026-11-03 during the build)** `reserveOutputTokens` on a route chosen by client headers (`requestClass`, `agentType`, `repo`, `feature`) on coding-agent traffic needs `allowBodyRewrite: true`, so the cap is written into the body (`E_RESERVE_OUTPUT_NO_REWRITE`, 7.3).

Warnings:

- A child budget larger than its parent (team above tenant).
- A surface with no route (requests on it would get 403 "no route").
- A route that can never match because an earlier route covers it.
- `estimator: session-aware` together with `onExceed: block` on a session budget (the guarantee in 7.4 does not hold).
- `serverToolsWithoutMaxUses: assume` together with any enforced budget (the guarantee in 7.4 does not hold for those requests).

### 6.5 Decision function contract

```ts
// src/policy/decide.ts (pure: no I/O, no clock, no randomness)
export interface RequestFeatures {
  id: string;                          // gateway request id (ULID), also the reservation id
  ts: number;                          // ms since epoch, supplied by the caller
  surface: 'anthropic-messages' | 'anthropic-count-tokens' | 'openai-responses' | 'openai-chat';
  traffic: 'coding-agent' | 'product'; // from the key
  billing: 'api' | 'subscription';     // from the key
  tenant: string; team: string | null; keyId: string;
  model: string; stream: boolean;
  inputTokensBound: number;            // provable upper bound on billed input tokens per iteration, see 7.3
  boundKind: 'bytes' | 'context-window';
  maxOutputTokens: number | null;
  serverTools: Array<{ type: string; maxUses: number | null }>;
  toolCount: number; thinking: boolean;
  attribution: {
    session: string | null; agent: string | null; parentAgent: string | null;
    requestClass: 'main' | 'subagent' | 'workflow' | 'compaction' | 'auxiliary' | null;
    agentType: string | null; promptId: string | null;
    repo: string | null; branch: string | null; ticket: string | null; feature: string | null;
  };
  guardrail: { hits: GuardrailHit[] }; // computed before decide and before admit, from content the trace never stores
}

export interface GuardrailHit {
  rule: string; action: 'block' | 'warn' | 'redact';
  valueHmac: string;                   // HMAC-SHA256 of the matched value with the deployment salt
  where: 'last-turn' | 'history';
}

export interface Plan {
  policyRevision: string;
  route: string | null;                // null: no route matched
  chain: Array<{ provider: string; upstreamModel: string; rewritesModel: boolean }>;
  reservations: Array<{ budget: string; key: string; limitMicroUsd: number; estMicroUsd: number; enforce: boolean }>;
  rateChecks: Array<{ limit: string; key: string; emissionMs: number; burst: number; quantity: number }>;
  streamSlots: Array<{ limit: string; key: string; max: number }>;
  taint: {                             // null when the request has no session key and no block hits
    key: string;                       // tenant-tagged session key, or the key id when there is no session
    check: string[];                   // valueHmacs of history hits: blocked if any is in the taint set
    add: Array<{ rule: string; valueHmac: string }>;   // last-turn block hits: written to the taint set
    ttlMs: number;
  } | null;
  preBlock: BlockReason | null;        // decided without counters: model not allowed, no route, last-turn secret
  warnings: Warning[];                 // guardrail warns, audit-mode notes
}

export interface Admission {           // returned by CounterStore.admit(plan)
  admitted: boolean;
  failed: { kind: 'budget' | 'rate' | 'streams' | 'taint'; name: string; spentMicroUsd?: number; retryAfterMs?: number; rule?: string } | null;
  audit: Array<{ name: string; wouldFail: boolean }>;
  totals: Array<{ key: string; spentMicroUsd: number; reservedMicroUsd: number; limitMicroUsd: number }>;  // post-admit, enforced levels
  storeDown?: true;                    // admit could not reach the store; failure.counterStoreDown applied
}

export interface Decision {
  action: 'forward' | 'block';
  block: { status: 400 | 403 | 429 | 503; type: string; reason: BlockReason; message: string; retryAfterS: number | null } | null;
  plan: Plan;
  admission: Admission | null;
}

export function decide(policy: CompiledPolicy, f: RequestFeatures): Plan;
export function resolve(policy: CompiledPolicy, plan: Plan, admission: Admission | null): Decision;
```

Rules:

- `decide` and `resolve` are deterministic in their arguments. A property test (fast-check) runs each twice on random inputs and compares results; an import-rule test keeps I/O modules out of `policy/`.
- Route matching is first match wins over `surface`, `traffic`, `billing`, `tenant`, `team`, `requestClass`, `agentType`, `repo`, `feature` and model glob **(my call; firewall-style order is easy to review in a diff)**.
- Weighted splits (`chain` entries with `weight`) pick by `hash(session or request id)`, so a session sticks to one choice without any session state. This matters because the prompt cache is isolated per workspace and switching model or provider mid-session starts from zero ([Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)).
- `onExceed: downgrade` (with `downgradeTo: <model>`) is allowed only on product traffic or on coding-agent requests with request class `auxiliary` or `compaction` behind `allowBodyRewrite`. It costs a second store call on the exceeded path only.
- Audit mode: `CompiledPolicy` may carry a candidate. The gateway runs `decide` and `resolve` for both, enforces the active one, and stores the candidate's decision on the trace. The candidate is evaluated against the active policy's counters, so its budget results are approximate; replay is the exact tool.

### 6.6 Guardrails

**Secrets.** A curated set of prefix-anchored rules ported from the gitleaks catalog to JS regexes: AWS `AKIA`/`ASIA` key ids, GitHub `ghp_`, `gho_`, `ghs_`, `github_pat_`, Slack `xox[abposr]-`, Stripe `sk_live_` and `rk_live_`, `-----BEGIN ... PRIVATE KEY-----` blocks, JWTs, Anthropic `sk-ant-`, OpenAI `sk-proj-`, Google `AIza`, tokenyard's own `ty_live_`. Each rule has a keyword prefilter (literal `includes` before the regex). Gitleaks is "feature complete" and its author moved to Betterleaks ([gitleaks](https://github.com/gitleaks/gitleaks)); there is no npm library that loads those rules natively, so the port is ours, with the source rule id and licence noted per rule. Entropy-only detection is `warn` at most, because hashes, UUIDs and lockfile integrity strings produce false positives in code.

- **What is scanned, and when:** all scanning happens before admit and needs no store call. The newest turn (the last message and its `tool_result` blocks) is scanned with every rule; its hits carry `where: last-turn` and decide block or warn. The rest of the body is scanned with the `block` rules only (keyword prefilter first, so a body without any rule keyword costs one `includes` pass per keyword); its hits carry `where: history` and are reported only as HMACs of the matched values. History hits never block on their own: earlier turns were judged when they were new.
- **Session taint, inside admit (my call):** taint lives in the counter store next to the budgets (`ty:{tenant}:taint:<session>`, a set of value HMACs with a TTL of `taintTtlHours`). When a last-turn hit blocks a request, `admit` adds its value HMAC to the session's taint set (the session is `x-claude-code-session-id`, or the key when there is none) and makes no reservation. On every other request `admit` checks the request's history-hit HMACs against the taint set in the same atomic call as the rate checks and reservations, and fails with `kind: 'taint'` if any is present. Without this, the next turn would carry the secret in its history and pass. The hot path keeps one store round trip. The message tells the developer to `/clear`, rotate the secret and add a deny rule. The secret is never stored, only its HMAC. The HMAC key is HMAC(trace salt, "guardrail"), so instances sharing the trace salt share taint while pseudonyms and value HMACs never share a key; PII hits carry no value HMAC (an empty string) and never taint, because a PESEL or an e-mail address is few enough guesses to enumerate **(updated 2026-11-03 during the build, security review B8)**.
- **Store down:** last-turn blocking needs no store and keeps working; the taint check is skipped and the trace marks `taintUnchecked: true` **(my call)**.
- **Replay** rebuilds taint from the traces: the sim store applies the recorded hits (`where` and `valueHmac`) through the same admit logic, so a taint block in the recorded traffic is reproduced.
- **Coding-agent traffic:** `block` or `warn`. **Product traffic:** `block`, `warn` or `redact` (placeholder `[REDACTED:<RULE>_<n>]`).
- **PII** (product traffic only): email, PESEL with checksum, IBAN with mod-97, card numbers with Luhn.
- **Measured, not assumed:** a false-positive corpus (the source trees of why-diff, read-receipts and tokenyard, plus `package-lock.json` files and a set of public fixtures) must produce zero `block` hits; scan time per MB is in the README.

What a gateway cannot do is written in the README: it cannot stop prompt injection or a command the agent runs locally after the model replies. Egress control belongs to the sandbox. Prompt injection stays first in the OWASP LLM Top 10 for 2025 and is described as something "you can't patch your way out" of (secondary summary: [Coralogix](https://coralogix.com/ai-blog/owasp-top-10-for-llm-applications/)).

### 6.7 Bundles and loading

- `tokenyard policy build --out dist/policy-bundle.json` writes one JSON file: `{ manifest: { revision, schemaVersion, createdAt, sha256 }, policy, prices, keys }` with keys normalised and sorted. `revision` is the commit sha when run in CI (`GITHUB_SHA`), otherwise the first 12 hex characters of the content sha256.
- Sources: `--policy <dir>` (watched with debounce) or `--policy-url <url>` (polled every 15 s with `If-None-Match`; any redirect is an error) **(my call on 15 s; the research suggests 10 to 30 s)**.
- On a new bundle: verify sha256, validate, compile to an immutable structure (precomputed matchers), then swap one reference (`active = compiled`), which is atomic in single-threaded Node. On failure: keep the old snapshot, increment `tokenyard_policy_load_errors_total`, log the reason.
- Last-known-good is written to `--state-dir` and used at startup when the source is unreachable, like OPA's `persist: true` ([OPA bundles](https://www.openpolicyagent.org/docs/management-bundles)). With no source and no last-known-good the gateway refuses to start.
- In-flight requests finish under the snapshot they started with.
- JWS signatures over the bundle are deferred; sha256 integrity plus a trusted source is the v0.1 model.

### 6.8 Experimental: subscription passthrough

Until Anthropic's terms on proxying subscription traffic are verified (R2), subscription passthrough is behind a flag and out of the README **(my call)**:

- Off by default. `tokenyard serve --experimental-subscription` and `tokenyard policy check --experimental-subscription` enable the schema items listed in 6.4 (passthrough credentials, `billing: subscription` keys and routes); without the flag they are load errors.
- With the flag, behaviour is as described in sections 3 (step 5), 5.3 (step 2) and 7.6: the developer's OAuth `Authorization` header and `anthropic-beta` value go upstream unchanged, only to the official host; `x-tokenyard-key` is stripped; cost is labelled "API-equivalent"; budgets default to `onExceed: warn`.
- Tests: conformance item 17 (section 10) runs against the mock with the flag on. A manual check against a real subscription login is written down in `docs/experimental-subscription.md` and marked "not run" until R2 is answered; it is not part of any done criterion.
- The README, the demo and the example policy do not mention or depend on it. `docs/experimental-subscription.md` is the only user-facing description.

## 7. Budgets, rate limits and cost

### 7.1 Store interface

```ts
export interface CounterStore {
  admit(plan: Plan, nowMs?: number): Promise<Admission>;          // atomic: rate checks, stream slots, taint, all reservations
  settle(id: string, actualMicroUsd: number, perLevel?: boolean): Promise<'settled' | 'unknown'>;  // idempotent; releases the stream slot
  sweep(nowMs: number): Promise<number>;                            // settles overdue reservations and frees their slots
  snapshot(keys: string[]): Promise<Record<string, { spent: number; reserved: number }>>;
  seed(entries: Array<{ key: string; spentMicroUsd: number; ttlMs: number }>): Promise<void>;  // warm-up from traces (9.2, 14.1)
}
```

Implementations: `memory-store` (one instance, demo and tests; atomic because Node is single-threaded and `admit` has no `await` inside the critical section), `redis-store` (Lua), and `sim-store` in `replay/` (memory store driven by a virtual clock).

Money is stored as integer micro-USD (`HINCRBY`, not `HINCRBYFLOAT`) so that sums never drift **(my call)**.

### 7.2 Reserve then settle in Redis

Keys share the hash tag `{tenant}` so that all keys of one script sit in one Redis Cluster slot: `ty:{acme}:b:team-day:web:2026-11-02` (hash fields `s` spent, `r` reserved), `ty:{acme}:res:<id>` (reservation record), `ty:{acme}:deadlines` (sorted set by deadline), `ty:{acme}:g:<limit>:<key>` (GCRA theoretical arrival time), `ty:{acme}:st:<limit>:<key>` (open stream count), `ty:{acme}:taint:<session>` (set of value HMACs, TTL `taintTtlHours`).

`admit.lua` (sketch):

```lua
-- KEYS: budget keys..., res key, deadlines zset, gcra keys..., stream keys..., taint key
-- ARGV: id, est, n, limits..., enforce flags..., deadline, window TTLs..., gcra params..., stream maxes...,
--       taint check hmacs..., taint add hmacs..., taint ttl
local t = redis.call('TIME')                                  -- store clock for GCRA, not the instance clock
if redis.call('EXISTS', resKey) == 1 then return {2} end      -- duplicate admit for this id: no second reservation
-- 0) taint: SADD the add-hmacs and PEXPIRE the set; if any add-hmac was given, return {0, 'taint-written'}
--    (the request was already blocked by a last-turn hit); else SISMEMBER each check-hmac, first hit returns {0, 'taint', rule}
-- 1) GCRA checks; first failing limit returns {0, 'rate', name, retryAfterMs} without writing anything
-- 2) stream slots: for each, GET count >= max returns {0, 'streams', name}
-- 3) budget checks: for each enforced level, spent + reserved + est > limit returns {0, 'budget', i, spent}
--    audit levels are checked and reported, never block
-- 4) all passed: HINCRBY r est on every level (audit ones too, so audit spend is real), EXPIRE window keys,
--    INCR stream counts, HSET res record {est, keys, stream keys}, ZADD deadlines deadline id, update GCRA TATs
return {1, auditResults}
```

`settle.lua`: if the reservation record is gone, return `unknown` (idempotent); otherwise for each level `HINCRBY r -est` and `HINCRBY s actual`, `DECR` the record's stream keys, delete the record, `ZREM` the deadline. `sweep.lua`: for ids past their deadline (default 2 times the request timeout), settle at the reserved estimate and mark the trace `settledBy: sweeper`. Any instance runs the sweeper every 30 s under a short `SET NX` lock. **(updated 2026-11-03 during the build)** The upstream client's timeouts bound only idle gaps, so a stream that keeps sending could outlive its 20 minute reservation and lose its stream slot to the sweeper while it still runs. Every request therefore has a total deadline of 18 minutes (above Claude Code's 10 minute request timeout, below the reservation deadline): when it fires the upstream request is aborted and the request settles at its reservation (trace `errorClass: request_deadline`); a client still waiting for headers gets 504 `timeout_error` with `x-should-retry: false`.

### 7.3 The estimate

The budget guarantee stays hard **(Mateusz, 2026-11-02)**, so the `worst-case` estimator is an upper bound, not a guess:

- **Input token bound, `boundKind: bytes`.** When every content block in the body has a type on a short list of text-only types (`text`, `thinking`, `redacted_thinking`, `tool_use`, and `tool_result` whose content is text) and no field is present that makes the provider add input on its side (image, document, file or URL sources, `mcp_servers`, `container`, server tools), `inputTokensBound = min(bodyBytes + overheadTokens, maxContextTokens)` with `overheadTokens = 4096` **(my call; covers the tool-use system prompt and message framing the provider adds; the builder checks it against the sizes Anthropic documents for the tool-use system prompt and raises it if needed)**. Why it holds: a byte-level BPE tokenizer emits at most one token per byte of text, so a text of B UTF-8 bytes is at most B tokens, and JSON escaping only adds bytes, so `bodyBytes` is at least the byte length of all the text it carries. Claude's tokenizer is not published; that "at most one token per byte" holds for it is an **assumption that is tested**, not proven: every live run and the calibration benchmark (12.3, item 6) assert `actual input <= inputTokensBound` for every request, and one failure fails the run. The cap at `maxContextTokens` is safe because a request over the context window is rejected and not billed.
- **Input token bound, `boundKind: context-window`.** Any other body (an unknown block type or field included, so a new Claude Code feature fails safe): `inputTokensBound = maxContextTokens`.
- **Input price.** All input tokens are priced at the highest input-side rate the model has: the maximum of `input`, `cacheWrite5m`, `cacheWrite1h` and `cacheRead` across every tier, which in today's table is `cacheWrite1h`, times every modifier above 1.
- **Output.** `max_tokens` (Responses: `max_output_tokens`, or the model's `maxOutputTokens` when absent; product routes: the route's `reserveOutputTokens` cap, which the gateway writes into the body) priced at the highest output rate across tiers, times every modifier above 1. Coding-agent bodies are never modified, so the reservation uses the client's own `max_tokens`. **(updated 2026-11-03 during the build)** `reserveOutputTokens` lowers the reservation only when the gateway writes it into the body (`max_tokens`, or `max_output_tokens` on Responses, inserted when absent), byte-faithfully and under the same rule as `rewriteModel`: product routes, or coding-agent routes with `allowBodyRewrite: true`; a body where the field cannot be set exactly gets 400 `output-cap-failed`. Elsewhere it is ignored, and validation refuses it (`E_RESERVE_OUTPUT_NO_REWRITE`) on a route chosen by client headers, where any client could otherwise pick the smaller reservation.
- **Server tools.** When the request enables a server tool (for example `web_search`), the provider may loop up to the tool's `maxIterations` from the price table (the builder checks the value against the server tools docs). Input bound becomes `maxIterations * maxContextTokens`, output bound `maxIterations * maxOutputTokens`, and the fee bound is `max_uses * perUseUsd` per tool. A server tool without `max_uses` has no fee bound: with `reservation.serverToolsWithoutMaxUses: block` (default) the request gets 403 `permission_error` when it would touch an enforced budget; with `assume` the estimator uses `assumedMaxUses` and the trace flags `boundAssumed: true`, which takes those requests out of the guarantee. An unpriced server tool type follows `failure.unpricedModel`. **(updated 2026-11-03 during the build)** MCP connector tools (`mcp_servers`, `mcp_toolset`) and every tool type that is neither a custom tool (no type, or type `custom`) nor a known client tool go through this server-tool path rather than being treated as a plain input expander: they resolve to an unpriced server tool and are refused unless `failure.unpricedModel` allows them, so a new provider-side tool cannot slip past the bound. Anthropic-defined client tools and OpenAI built-in client tools (`local_shell`, `apply_patch`, local `shell`) have hidden definitions and force the `context-window` bound; a hosted OpenAI `shell` (container) is a server tool.
- **Compaction.** **(updated 2026-11-03 during the build)** Threshold compaction (a `compact_*` edit in `context_management.edits`) runs an extra compaction sampling iteration, checked at the start of each sampling iteration ([Compaction at a token threshold](https://platform.claude.com/docs/en/build-with-claude/compaction-threshold)). The bound adds one compaction iteration per sampling iteration: `maxContextTokens` of input and, since no summary limit is documented, `maxOutputTokens` of output each. On-demand compaction (top-level `compaction`) is one call capped by `max_tokens` and is bounded as an ordinary request; its usage is read from `usage.iterations`.
- **Rounding.** The reservation is computed in micro-USD and rounded up.
- `session-aware` estimator: input priced with the cache read share of the session's previous request (kept in a small in-memory LRU per instance), output as `min(max_tokens, route.reserveOutputTokens)` (the cap only where it is written into the body). Admits more concurrency; gives up the hard bound.
- The trace stores the bound, its kind and the actual input total; the README reports the measured ratio from the demo and from the live sessions.

### 7.4 What is guaranteed

Premises: `estimator: worst-case`; a correct and complete price table (models, tiers, modifiers, server tools); `serverToolsWithoutMaxUses: block`; the tokenizer assumption in 7.3; a provider that bills no more than the bound. Then every request's actual cost is at most its own reservation, and the store admits a request only if `spent + reserved + est <= limit` holds on every enforced level, checked and applied atomically. Two invariants follow, for any number N of concurrent requests whose reservation each fits the budget on its own:

1. **Reserved:** at every moment, on every enforced level, `spent + reserved <= limit`. So the total reserved cost of admitted, unsettled requests plus everything already settled never exceeds the budget.
2. **Settled:** `spent <= limit` at every moment, because settle replaces each reservation with an actual cost that is not larger.

The proof test (G4) runs N = 1,000 concurrent requests against a $1 budget on both stores, through a mock whose actual cost for each request is drawn (seeded) uniformly between 0 and that request's reservation. It asserts: (a) after every admit, the totals the store returns satisfy invariant 1 (the Redis script and the memory store both return post-admit totals for this); (b) final `spent <= limit`; (c) final `spent` equals the sum of settled costs exactly, in micro-USD, and `reserved` is back to 0, so no update was lost (the [#20977](https://github.com/BerriAI/litellm/issues/20977) failure); (d) every rejected request was rejected with `spent + reserved + est > limit` as seen by its own admit. A fast-check property test on the memory store adds the precise form of "behaves like a sequential run": for any interleaving of admits and settles, each admit's outcome equals what a sequential model returns when it applies the same operations in the store's commit order. The first draft's claim that the number admitted equals what a sequential run admits is dropped: with random completion order, which requests fit depends on timing, and no invariant ties the count to one particular sequential order.

**Concurrency trade-off (in the README):** worst-case reservations are large. One Claude Code turn with a 150,000-byte body and `max_tokens` of 32,000 on Opus 5.5 reserves about 154,000 input tokens at $8 per million plus 32,000 output tokens at $20 per million, times the 1.1 modifier, roughly $2.06, while a typical turn with a warm cache costs a few cents. Under a $25 session budget that allows about 12 turns in flight at once (not 12 turns in total); requests beyond the headroom get 429 until earlier ones settle. Teams that need more concurrency switch to `session-aware` and accept the weaker bound below. The README states this with numbers produced by the benchmark, not these.

With `session-aware`, the bound becomes: overspend at most the sum, over requests in flight, of (actual minus estimate), and the README says so. `onOverrun: allow-and-debit` lets a stream that outruns its reservation finish and puts the budget into debt; the next request is blocked. Under the premises above an overrun cannot happen; if one does, the trace flags `overrun: true` and the proof test fails on it. Cutting a coding-agent stream mid tool call wastes every token already spent, so cutting is not offered for coding-agent traffic.

Coverage: every inference route goes through the same admit hook. A test enumerates the route table and fails if one does not, because LiteLLM's budget bypasses were coverage gaps, not maths: pass-through routes ([#10750](https://github.com/BerriAI/litellm/issues/10750)) and another client path, $764.78 spent against a $50 budget ([#12977](https://github.com/BerriAI/litellm/issues/12977)).

### 7.5 Rate limits

GCRA: one theoretical arrival time per key, no background process, Redis `TIME` as the clock ([Brandur](https://brandur.org/rate-limiting)). `rpm` uses quantity 1; `itpm` (input tokens per minute) uses quantity `inputTokensBound`. Output-token limits are not shaped at admission, matching Anthropic's own OTPM, which counts only tokens actually generated ([Anthropic rate limits](https://platform.claude.com/docs/en/api/rate-limits)).

### 7.6 Cost

Per request, from the four Anthropic token buckets ([Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)):

```
cost = input * p.input + cacheWrite5m * p.cacheWrite5m + cacheWrite1h * p.cacheWrite1h
     + cacheRead * p.cacheRead + output * p.output     (then modifiers: inferenceGeoUs 1.1, tiers)
```

`input_tokens` is only the part after the last cache breakpoint; total input is read plus creation plus input. When `cache_creation` has no 5m/1h split, all of it is 5m. Cache read multipliers differ by model (0.1, 0.05 for Opus 5.5 and Sonnet 5.5, 0.025 for Fable 5.1), which is why the table stores absolute prices, not multipliers. Haiku 5.5's higher tier above 100k prompt tokens is a `tiers` entry. For Responses, cached tokens come from `input_tokens_details.cached_tokens` (shape pinned by fixture, see 5.4). The trace stores the price table version so cost can be recomputed.

**Subscription mode (experimental, 6.8):** the same function gives "API-equivalent" USD. It is labelled as such everywhere (report, PR comment, OTel attribute `tokenyard.cost.basis = "api-equivalent"`). Budgets on subscription keys default to `onExceed: warn`; `block` is allowed (a team may want to cap even subscription use) and the schema prints a warning. The `anthropic-ratelimit-unified-*` response headers are recorded on the trace as the plan-limit view.

Unknown model at runtime (a new Claude Code alias): with `unpricedModel: allow-and-flag` the reservation uses the most expensive priced model in the table, the request is flagged `unpriced`, and the report lists it; with `block` it gets 403.

## 8. Fallbacks, retries and idempotency

- A fallback or retry happens **only before the first byte is written to the client**. Bytes already sent are never retried and two providers' streams are never spliced.
- Retryable before headers: connect and TLS errors (before the request body is written; see Idempotency below), 500, 502, 503, 504 and 529. Spend-cap 429 (`enforced_spend_limit_reached`, no `retry-after`) opens that provider's breaker until the policy's `openSeconds` ([Anthropic rate limits](https://platform.claude.com/docs/en/api/rate-limits)). Other 429s are forwarded unchanged so Claude Code's own retry logic applies, unless the route sets `fallbackOn429: true`. Other 4xx are always forwarded unchanged.
- Mid-stream errors (`event: error` after a 200) are forwarded as they are and counted in metrics, because status-code metrics alone undercount them.
- At most 3 attempts per request (the chain length cap). A per-tenant retry budget of 10% of requests over a trailing minute stops fallback storms ([Google SRE](https://sre.google/sre-book/handling-overload/)). Circuit breaker per provider with the thresholds from `failure.breaker`; numbers live in policy, mechanism in code.
- A fallback to another Anthropic workspace starts a cold cache; the trace marks `cacheColdRisk: true` and replay prices it (9.4).
- **Idempotency.** The gateway request id is the reservation id, so `admit` and `settle` are idempotent per request. A client `Idempotency-Key` header (product routes) is scoped per key: the reservation id becomes `hash(tenant, key, Idempotency-Key)`, a concurrent duplicate gets 409, and a request with the same key but a different body fingerprint gets 422 ([Brandur, idempotency keys](https://brandur.org/idempotency-keys)). Replaying a completed response from a cache is deferred. Claude Code sends no idempotency key; its retries are new requests. **(updated 2026-11-03 during the build)** A failed attempt settles at zero only when it failed in the connect phase, before any byte of the request body was written upstream: then the provider billed nothing. Once the body was written (a reset or a timeout before headers, a client that leaves while a non-streaming answer is generated, a client that leaves after the headers came) the provider may be generating and billing, so the request settles at its reservation, and the chain does not fall back to another provider, which would bill the same request again under one reservation. Fallback stays for connect-phase failures and for retryable statuses the provider answered.

## 9. Traces and replay

### 9.1 Trace record

One NDJSON line per request, written after the response ends through a bounded async queue (overflow drops the record and increments `tokenyard_traces_dropped_total`; the hot path never waits on disk). Files: `<trace-dir>/<tenant>/<YYYY-MM-DD>/<HH>.<instanceId>.ndjson`, rotated hourly **(my call: NDJSON instead of the SQLite ledger in the research; no native module, works on Node 20 and Windows, and the same file is the replay input)**. `instanceId` comes from `--instance-id`, or else 8 hex characters of a hash of hostname and start time, so two instances never write the same file **(my call)**. Each file starts with a segment record `{ v: 1, kind: 'segment', instance, startedAt, firstSeq }`; while the instance runs it appends a heartbeat record `{ kind: 'heartbeat', instance, ts, seq }` every 60 s (from the sweeper tick, off the hot path) and a `{ kind: 'shutdown' }` record on graceful stop. Request records carry `instance` and a per-instance `seq` that increases by one per record, so a gap means dropped records.

```ts
interface TraceRecord {
  v: 1;
  kind: 'request';
  id: string; ts: string;                        // request start, ISO
  instance: string; seq: number;                 // writer instance and its record sequence number
  tenant: string; team: string | null; keyId: string;   // config names and opaque key id, in clear
  traffic: 'coding-agent' | 'product'; billing: 'api' | 'subscription'; surface: string;
  client: { agent: 'claude-code' | 'codex' | 'other'; version: string | null };   // from User-Agent, best effort
  attribution: {                                 // session, agent, parentAgent, promptId: HMAC-SHA256 with a per-deployment salt
    session: string | null; agent: string | null; parentAgent: string | null; promptId: string | null;
    requestClass: string | null; agentType: string | null;
    repo: string | null; branch: string | null; ticket: string | null; feature: string | null;
  };
  features: { model: string; stream: boolean; inputTokensBound: number; boundKind: 'bytes' | 'context-window';
              maxOutputTokens: number | null; serverTools: Array<{ type: string; maxUses: number | null }>;
              toolCount: number; thinking: boolean; bodyBytes: number; prefixHash: string | null;
              contextCompacted: boolean };
  guardrail: { hits: Array<{ rule: string; action: 'block' | 'warn' | 'redact'; valueHmac: string; where: 'last-turn' | 'history' }> };
  policy: { revision: string; candidateRevision?: string };
  decision: { route: string | null; action: 'forward' | 'block'; reason: string | null;
              chain: string[]; reservedMicroUsd: number; boundAssumed: boolean; taintUnchecked: boolean;
              audit: Array<{ name: string; wouldFail: boolean }> };
  candidateDecision?: TraceRecord['decision'];
  outcome: {
    provider: string | null; upstreamModel: string | null; attempts: number; cacheColdRisk: boolean;
    status: number; errorClass: string | null; midStreamError: string | null;
    ttfbMs: number | null; totalMs: number; addedTtfbMs: number | null;
    usage: { input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number } | null;
    usageSource: 'final' | 'partial' | 'estimated' | 'none';
    costMicroUsd: number | null; costBasis: 'billed' | 'api-equivalent'; priceTable: string;
    aborted: boolean; settledBy: 'request' | 'sweeper'; overrun: boolean;
    rateLimitHeaders?: Record<string, string>;   // anthropic-ratelimit-unified-* only
  };
}
```

**(updated 2026-11-03 during the build)** Fields added to the record while building, each documented in `src/ledger/record.ts`: `attribution.sanitized` (a client header value was cut or had characters dropped at ingest); `features.fastMode` and `features.serviceTier` (the reservation was priced at fast or tier rates); `policy.candidateError` (the audit candidate failed to decide); `decision.storeDown` (admit could not reach the counter store and `failure.counterStoreDown` applied), `decision.preDecision` (the request ended before a decision; replay skips it), `decision.admitOffsetMs` and `decision.admitSeq` (when admit ran, and its order within one millisecond on that instance; replay admits in this order); `outcome.outputEstimated` (output counted from streamed characters because no output count arrived), `outcome.fast`, `outcome.serviceTier`, `outcome.modifiers` and `outcome.serverToolUses` (what the cost was priced with), `outcome.settledAtEstimate` (no usage arrived, so the reservation was settled as the cost), `outcome.chargedMicroUsd` (what the store charged the budgets at settlement; warm-up seeds from it) and `outcome.boundExceeded` (billed input above a bytes bound, R11). The export manifest gains `instances[].shutdown`.

No prompt text, no tool content, no file paths from the body, no credentials. `addedTtfbMs` is the time from request received to first byte written, minus the upstream's own time to first byte. Retention is the operator's (a `traces prune --older-than 30d` command). Content capture is not available in v0.1.

### 9.2 Replay algorithm

`tokenyard policy replay --base <policy dir or git ref> --head <policy dir> --traces <files or dir> [--since 7d] [--tenant acme] --md comment.md --json replay.json`

1. Load one merged trace set produced by `tokenyard traces export` (9.5), sorted by `ts`, then `id`. Replay refuses a directory of raw per-instance files and names the export command, because a partial set would undercount budgets **(my call)**.
2. Run the **base** policy and the **head** policy separately over the same traces, each with its own `sim-store` on a virtual clock driven by `ts`. Diffing head against base (rather than head against what was recorded) keeps the comparison fair when traces were recorded under several revisions.
3. For each record and each policy: build `RequestFeatures` from the trace (guardrail hits, with their `where` and `valueHmac`, come from the recorded `guardrail.hits`, so session taint is rebuilt and applied by the sim store exactly as `admit` does it in the gateway), call `decide`, `sim-store.admit`, `resolve`. If forwarded, compute the replayed cost (9.4), then `sim-store.settle`.
4. **Session cuts.** A session is *cut* when a policy blocks one of its requests after at least one of its earlier requests was forwarded. From that point the policy's simulation drops the session's remaining recorded requests (assumption: the agent stops) and the report counts them as "requests that would not have happened as recorded", with their recorded cost.
5. **Fidelity check.** For records whose `policy.revision` equals the base revision, replaying the base must reproduce the recorded decision. The agreement rate is printed at the top of every comment; disagreements are listed by reason (missing counter state at the start of the window, dropped traces, retries the trace cannot see). The check also reports **missing instances**: an instance whose segment and heartbeat records show it running during an hour for which the merged set holds no file of it, sequence gaps per instance (dropped records), and an instance without a `shutdown` record whose heartbeats stop before the end of the window. Each is listed with the hours affected. A low rate or any missing instance tells the reviewer not to trust the diff.
6. **Warm-up.** Budget windows that started before `--since` are seeded from the recorded spend in the traces before the window, so a daily budget on day one is not empty.

### 9.3 What replay computes, and how exactly

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

Replay is deterministic: same traces and policies give byte-identical JSON and Markdown (snapshot test). The README has this table verbatim.

### 9.4 PR comment

One sticky comment, found and updated by the marker `<!-- tokenyard-replay -->`. Layout (the numbers below are illustrative, not a measurement):

```markdown
<!-- tokenyard-replay -->
### tokenyard policy replay: `a1b2c3d` (base) vs `e4f5a6b` (head)

Traffic: 7 days, 18,240 requests, 412 sessions, tenant `acme`. Fidelity: base replay matches recorded decisions on 99.6% of requests (details below).

| | Base | Head | Change |
|---|---|---|---|
| Cost (billed) | $1,912.40 | $2,031.75 | **+$119.35 (+6.2%)**, estimated (model change) |
| Requests rerouted | | 3,104 | `compaction` and `auxiliary` to `claude-haiku-4-5` |
| Requests blocked | 0 | 41 | 38 `team-day` (web), 3 `dev-rpm` |
| Sessions cut mid-task | 0 | **9** | 6 main, 3 subagent; 212 later requests ($88.10) would not have run as recorded |
| Budget hits | none | `team-day` web on 3 of 7 days | first hit 2026-10-29 16:42 UTC |

Why the cost went up: moving `compaction` to `claude-haiku-4-5` starts a cold cache in 1,880 sessions (+$146.20 in cache writes), larger than the saving on output (-$26.85).

<details><summary>Rerouted requests by route and request class</summary> ... </details>
<details><summary>Cut sessions</summary> session hash, team, repo, request class, request index, budget </details>
<details><summary>How exact is this</summary> the table from section 9.3, with the rows that applied to this run </details>

Check: **failed** (`ci.failOn.cutSessions: 0`). Policy check: 0 errors, 1 warning.
```

The terminal renderer prints the same sections; `--json` holds everything (schema version 1, documented in `docs/replay-json.md`).

### 9.5 GitHub Action

`action.yml` at the repo root (as in why-diff), `runs: using: node24` with the committed bundle. Inputs: `policy-dir`, `base-ref` (default `github.base_ref`), `traces` (path or URL), `traces-token` (optional), `since`, `comment` (default true), `token`. Steps: `policy check`, fetch base policy with `git show <base>:<dir>`, `policy replay`, post or update the sticky comment and the job summary, upload `replay.json` as an artifact, exit 1 when a `ci.failOn` gate is exceeded. Needs `permissions: pull-requests: write`. Fork PRs get the job summary only and no trace URL secret.

Where traces come from in CI: `tokenyard traces export --since 7d --out traces.ndjson.gz` on the gateway host (or on shared storage that holds every instance's files), published to a location the CI job can read with a read-only token. Export reads every `<HH>.<instanceId>.ndjson` file in the window, merges and orders the records by `ts`, then `id`, and writes a manifest line first: `{ kind: 'manifest', since, until, instances: [{ id, firstTs, lastTs, records, seqGaps, hoursWithoutFile }] }`. `--anonymize` replaces tenant, team, key id, repo, branch and ticket with stable pseudonyms (`tenant-1`, `repo-a`) and drops `client.version`; session and agent ids are already HMACs. **(updated 2026-11-03 during the build, security reviews B5 and B7)** The export salt is a one-off from `TOKENYARD_EXPORT_SALT` or `--salt-file`, by default a random salt that is never stored, and is refused when it equals the trace salt (`TOKENYARD_TRACE_SALT`, or the file `traces export --trace-salt-file` names; whose holder would reverse the pseudonyms by dictionary); secret values (trace salt, metrics token, Redis URL with a password, export salt) are never accepted as command-line flags, only from the environment or a `--*-file <path>`. **(updated 2026-11-03 during the build)** `--anonymize` also re-keys every linkable id with the export salt, because the raw HMACs are stable across exports and `prefixHash` is an unsalted SHA-256 of the tools and system bytes (Claude Code's system block names the working directory, user and branch), so anyone holding those bytes could confirm it: record ids become their position in the export, and instance ids, session, agent, parent agent and prompt HMACs, `prefixHash` and guardrail `valueHmac`s are replaced by salted pseudonyms, consistently within one export so ordering, joins, cache breakers and taint still work. This is how the live-session excerpts in the README are produced (13). In this repo's demo, a synthetic trace file generated by `tokenyard demo` is committed under `examples/traces/`.

### 9.6 Designed, not built: quality evaluation

Two tiers for when a policy moves traffic between models: (1) a golden set of coding tasks run on both routes, scored first with deterministic checks (tests pass, diff applies) and then pairwise by an LLM judge with position swapping, since judges reach over 80% agreement with humans but have position and verbosity bias ([Zheng et al., 2023](https://arxiv.org/abs/2306.05685)); (2) shadow traffic on 1 to 5% of requests with a second sample of the known route to measure noise first, Diffy style ([Twitter: Diffy](https://blog.twitter.com/2015/diffy-testing-services-without-writing-tests)), charged through the same budgets so shadow calls cannot bypass accounting ([tas-llm-router #184](https://github.com/Tributary-ai-services/tas-llm-router/issues/184)). Both are documented in `docs/future-quality.md` and not built in v0.1.

## 10. Protocol-fidelity conformance suite

`test/conformance/`, run in CI on every push. Each test names the rule and links the doc section it comes from; `docs/conformance.md` is generated from the test names, with the Claude Code and Codex versions last checked by hand.

Harness: the mock provider records exactly what it received (method, path with query, headers, body bytes) and replays scripted responses with controllable timing. A test client sends fixtures through the gateway and compares.

Anthropic Messages (from [Claude Code gateway protocol](https://code.claude.com/docs/en/llm-gateway-protocol.md) unless noted):

1. Body bytes upstream equal body bytes from the client, for every fixture, including `cache_control` on `system` blocks and messages, block-form `system`, mid-conversation `role: "system"` entries, `thinking` blocks with signatures, `output_config`, `context_management`, tools with `strict` and `defer_loading`, unknown top-level fields, and a tool `pattern` with `\p{...}` (the v2.1.265 breakage).
2. `anthropic-version` and `anthropic-beta` forwarded verbatim, including unknown beta values, the OAuth value and `extended-cache-ttl`; every other non-denylisted header forwarded unchanged.
3. Path matching: `/v1/messages?beta=true` with the query kept; base path with and without `/v1` mount prefix.
4. Both `Authorization: Bearer` and `x-api-key` accepted; in API mode the inbound credential never reaches upstream; in passthrough mode `Authorization` reaches upstream unchanged and `x-tokenyard-key` does not.
5. SSE output bytes equal upstream bytes, `ping` events included, unknown event types included.
6. No buffering: upstream sends `message_start`, then waits 2 s; the client must receive `message_start` before the wait ends. Same for headers (flushed before the first body byte).
7. Mid-stream `event: error` (`overloaded_error`) after a 200 reaches the client unchanged and is counted.
8. A truncated upstream stream reaches the client truncated; no synthesised `message_stop`; usage settled as `partial`.
9. Client abort: the upstream connection is closed within 100 ms **(my call on the bound)** and usage seen so far is settled, not zero.
10. Upstream error passthrough: status, body bytes, `retry-after`, `x-should-retry`, `anthropic-ratelimit-unified-*` unchanged, for 400, 401, 413, 429, 500, 529.
11. tokenyard's own `retry-after` is an integer number of seconds.
12. `GET /v1/models?limit=1000` answers 200 without redirect, only ids containing `claude`, in under 3 s.
13. `HEAD /api/hello` does not error the client; `count_tokens` is forwarded.
14. No `content-encoding` on SSE responses; `X-Accel-Buffering: no` present.
15. **Cache integrity:** a recorded 40-turn agent session sent through tokenyard and sent directly to the mock produces identical usage on every turn (the mock simulates prompt caching from `cache_control` breakpoints). A deliberately naive proxy in `test/helpers/` that flattens `system` to a string fails this test, which proves the test can fail.
16. Claude Code attribution headers are parsed into the trace and forwarded.
17. **Subscription passthrough (experimental, run with `--experimental-subscription`):** the OAuth `Authorization` value and the `anthropic-beta` OAuth value reach the mock unchanged; `x-tokenyard-key` does not; the cost is labelled `api-equivalent`; without the flag the same policy fails to load.
18. Per-key concurrent stream cap: with `concurrentStreams: 2`, a third concurrent stream gets 429 with `retry-after: 1`, and a slot frees when a stream ends, is aborted, or is swept.

Codex Responses: body and header byte equality including encrypted reasoning items and unknown fields; SSE passthrough; `response.completed` usage parsed; `response.failed` and `response.incomplete` forwarded; truncated stream settled as `partial`; `/responses` and `/v1/responses` both served.

Fixtures are synthetic and built from the documented shapes **(my call)**, plus one header set captured from a real Claude Code session on a public repo with every value replaced. A `CONFORMANCE_LIVE=1` mode runs a small subset against the real APIs through the live-test harness (14.1): keys from `.env` and the environment, the 20 USD cap enforced by tokenyard; it never runs in CI. The manual check on day 2 (Claude Code) and day 10 (Codex) records the client versions in `docs/conformance.md`; Codex is listed as "not verified live" when no `OPENAI_API_KEY` was available.

## 11. Security model and threat model

### Assets

Provider API keys; developers' gateway keys; developers' OAuth subscription tokens (subscription mode); prompt content (source code, sometimes secrets); traces; the policy; budget counters.

### Trust boundaries

Developer machine (untrusted for anything but its credential); the gateway process; Redis; the policy source; the CI job that replays a PR; the trace store.

### Threats and mitigations

| Threat | Mitigation |
|---|---|
| Stolen developer key | Keys stored as SHA-256 only; per-key budgets and rate limits bound the damage; revoke by removing the line from `keys.yaml` (hot reload); `ty_live_` prefix so secret scanners (including tokenyard's own rule) find leaked keys |
| Header spoofing to dodge attribution or budgets (random session id per request, fake request class) | Identity, tenant, team, traffic class and billing come from the key. Session budgets and request-class routing are best effort and documented as such; hard limits are on key, team and tenant. Model allowlists are enforced whatever the headers say. **(updated 2026-11-03 during the build)** Client-asserted fields (request class, agent type, session, repo, branch, ticket, feature, User-Agent) are not a security boundary: route predicates on them only choose among chains and rewrites and never grant a model; authorisation uses the first route that matches on key-derived and request-intrinsic fields (tenant, team, traffic, billing, surface, model), and `policy check` warns when a header-matched route allows more than that route. Anthropic warns headers and User-Agent can be spoofed ([Claude apps gateway](https://code.claude.com/docs/en/claude-apps-gateway)) |
| Provider key leak through the gateway | Never logged, never reflected in responses or errors; upstream URLs come only from policy, never from the request; upstream redirects are not followed |
| OAuth subscription token misuse | Subscription passthrough is off unless `--experimental-subscription` is set (6.8). Forwarded only to the provider's official host (schema rule 6.4), only for the request it came with; never logged, stored or traced; no pooling |
| Prompt content leak through traces, logs or telemetry | Traces hold no content; logs hold no bodies; OTel opt-in content attributes (`gen_ai.input.messages` and similar) are never set; session and agent ids are HMAC-pseudonymised |
| Policy tampering | Policy only from git through CI; sha256 checked at load; active revision exported and traced; no runtime API that changes policy |
| Malicious policy PR attacking CI (exfiltrate traces, run code) | Policy is YAML parsed by Zod, never executed; the Action runs the released bundle pinned by version, not code from the PR; traces contain no content; fork PRs get no trace token |
| Budget bypass through concurrency or another path | Atomic reservation (7.2); route-coverage test (7.4) |
| Counter store outage | Explicit per-policy behaviour: rate limits open, budgets closed (or open, if the operator chooses and writes it down) |
| Denial of service | Body size cap, header size cap, per-key concurrent stream cap (in the counter store, checked inside `admit`, so it holds across instances), timeouts for headers and idle upstream streams (long enough for extended thinking), criticality-based shedding of `sheddable` product routes first ([Google SRE](https://sre.google/sre-book/handling-overload/)) |
| Cross-tenant leakage | Every key belongs to one tenant; every counter key and trace path is prefixed by tenant; replay and report filter by tenant; a test asserts no code path builds a counter key without the tenant tag |
| Secret sent to a provider | Secret guardrail (6.6). Limits stated plainly: it cannot stop prompt injection or local exfiltration by the agent |
| Live-test key leak | The key stays in the gitignored `.env` and in the gateway process environment only; the harness passes it with `node --env-file=.env`, never as an argument; a CI step and a pre-commit check (`.githooks/pre-commit`, enabled with `git config core.hooksPath .githooks`) scan the repo, `.gz` contents and every entry of the packed tarball with the gateway's secret rules and fail on a hit **(updated 2026-11-03 during the build, security review B4)**; developers' clients use a `ty_` key, never the provider key |
| Supply chain | Few dependencies, all bundled into one committed file; lockfile; `npm publish --provenance`; `npm audit signatures` in CI; README section on it. LiteLLM's PyPI releases 1.82.7 and 1.82.8 stole credentials in March 2026 ([DreamFactory](https://blog.dreamfactory.com/the-litellm-supply-chain-attack-a-complete-technical-breakdown-of-what-happened-who-is-affected-and-what-comes-next)) |

### Least privilege

The gateway needs provider keys, Redis credentials and read access to the policy source. The CI job needs `pull-requests: write`, read access to the policy directory and a read-only token for traces. Nobody needs write access to the running gateway. The Docker image runs as a non-root user with a read-only root filesystem and one writable state directory.

A security review pass (the same adversarial format as why-diff's) is part of day 12.

## 12. SLOs, observability and benchmarks

### 12.1 SLO targets

All are **targets to be measured**, not results. The README shows measured values next to each, or says "not yet measured". The latency targets come from the research's estimate for Node with in-memory policy and one Redis round trip; no primary measurement of a Node LLM gateway was found.

| SLI | Target |
|---|---|
| Added time to first byte (gateway minus direct to mock), p50 / p99 | under 5 ms / under 25 ms on the stated hardware and load |
| Gateway-attributable error rate (excludes provider errors forwarded correctly) | under 0.1% per month |
| Policy propagation, merge to all instances, p99 | under 60 s |
| Admitted spend above an enforced budget (worst-case estimator) | zero, checked by reconciliation of traces against counters |
| Conformance suite on the pinned Claude Code and Codex versions | 100% |
| Cache hit ratio through tokenyard versus direct, same session on the mock | equal |
| Replay of 1 million trace records | under 60 s on a CI runner |

### 12.2 OTel export

Per request, a SERVER span for the inbound call and one CLIENT span per upstream attempt named `{gen_ai.operation.name} {gen_ai.request.model}`, with GenAI attributes from the current conventions: `gen_ai.operation.name`, `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.request.stream`, `gen_ai.conversation.id` (the pseudonymised session), `gen_ai.response.finish_reasons`, `gen_ai.response.time_to_first_chunk`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.usage.cache_read.input_tokens`, `gen_ai.usage.cache_write.input_tokens`, `error.type` ([semantic-conventions-genai](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/client-inference.md)). The conventions are at status Development and define no cost attribute, so cost and the rest go in the `tokenyard.*` namespace: `tokenyard.cost.usd`, `tokenyard.cost.basis`, `tokenyard.price_table`, `tokenyard.policy.revision`, `tokenyard.route`, `tokenyard.request_class`, `tokenyard.agent.id`, `tokenyard.decision`, `tokenyard.added_ttfb_ms`. Note on input tokens: OTel's `gen_ai.usage.input_tokens` is all input, so it is set to input plus cache read plus cache write, while Anthropic's `input_tokens` excludes cache ([OTel Anthropic conventions, old page](https://opentelemetry.io/docs/specs/semconv/gen-ai/anthropic)). The attribute names are constants in one file with the semconv commit they were taken from, and a test fails if they change without an update there.

Metrics: `gen_ai.client.inference.duration`, `gen_ai.client.inference.time_to_first_chunk`, token usage counters, and `tokenyard_added_ttfb_seconds`, `tokenyard_requests_total{route,decision,status_class}`, `tokenyard_cost_usd_total{tenant,team,route,request_class}`, `tokenyard_cache_hit_ratio`, `tokenyard_policy_revision_info`, `tokenyard_policy_load_errors_total`, `tokenyard_traces_dropped_total`, `tokenyard_reservations_open`. High-cardinality ids (session, prompt, key) stay on spans and traces, never on metric labels. A plain Prometheus text endpoint `/metrics` serves the same counters without OTel configured **(my call)**. `/healthz` (process up) and `/readyz` (policy loaded, store reachable or failure mode allows traffic). **(updated 2026-11-03 during the build)** `/metrics` is never served on the API port: it is on a separate ops listener (`--metrics-port`, default 9464, bound to 127.0.0.1 by default, `--no-metrics` turns it off), and an ops listener bound beyond loopback refuses to start without a bearer token (`TOKENYARD_METRICS_TOKEN` or `--metrics-token-file`), because metric labels name tenants, teams and routes. Every label value comes from a bounded set (key records, policy names, priced models plus `other`, known enums plus `other`), so client headers cannot grow the series count. Without a token, `/metrics` and `/readyz` answer only a `Host` that is a loopback address or `localhost`, else 421 (DNS rebinding; security review B3, 2026-11-03).

`tokenyard report` (terminal, `--json`, `--html` like read-receipts) gives cost by tenant, team, key, repo, branch, session, request class, and per active developer-day next to Anthropic's reference figure, plus cache hit ratio per session and a "cache breaker" list: sessions whose `prefixHash` changed between turns.

Claude Code itself can export OTel with `claude_code.api_request` carrying `cost_usd` ([Claude Code monitoring](https://code.claude.com/docs/en/monitoring-usage)). The day 3 check compares tokenyard's cost against it for the same session. Whether `x-claude-code-session-id` equals OTel `session.id` is not confirmed by the docs (`/clear` replaces `session.id`), so the comparison joins on request id and time, not on session.

### 12.3 Benchmarks plan

All in `bench/`, run by `npm run bench`, results in `bench/results.json` with hardware, OS, Node and tool versions, and copied into the README between `<!-- BENCH:START -->` and `<!-- BENCH:END -->` by a script; CI fails if the block is out of date (as read-receipts does with its study block). Nothing is written in the README before it is run.

1. **Overhead.** Load generator: oha with latency correction, or autocannon; not k6, which does not correct coordinated omission by default ([TechEmpower](https://send-now.techempower.com/posts/wrk-vs-k6-vs-oha.html)). Same host, loopback, mock with fixed TTFT and token rate. Scenarios: non-streaming small request; streaming 500-token response; 150 KB request body (a long agent context). Concurrency 10, 100, 500 streams. Report added TTFB and added total time (gateway minus direct) at p50, p95, p99, plus CPU and RSS per 100 streams. Memory store and Redis store separately.
2. **Budget correctness.** 1,000 concurrent requests against a $1 budget, both stores, actual cost drawn at random up to each reservation (7.4): final spend, admitted count, maximum `spent + reserved` seen, maximum overspend. Also with `session-aware`, to show the difference, and the in-flight headroom of the 150,000-byte example turn under a $25 session budget, for the README's concurrency trade-off.
3. **Cache economics.** The 40-turn session from conformance test 15 through tokenyard and through the naive proxy, priced at Opus 5.5 list prices. At those prices a 100,000-token prefix costs $0.02 from cache and $0.40 uncached on every turn ([Claude pricing](https://platform.claude.com/docs/en/about-claude/pricing)); the benchmark reports what the whole session costs both ways.
4. **Secret scan.** Time per MB for the last-turn scan and a full-body scan; hits on the false-positive corpus.
5. **Replay throughput.** Records per second on 1 million synthetic records.
6. **Estimator calibration.** Ratio of `inputTokensBound` to actual input, and of reservation to actual cost, on the demo traffic and on the live sessions; any request with actual input above its bound fails the run (7.3).

## 13. README and demo plan

### Data shown in the README (Mateusz, 2026-11-02)

The demo and the demo PR run on synthetic traffic. Next to it, the README shows screenshots and excerpts from the real live sessions (14.1), fully anonymized: tenants, teams, keys, repos, branches, tickets and sessions pseudonymized with `traces export --anonymize`, no prompt content (traces never hold it), and screenshots taken from reports built on the anonymized export only. Every live number is labelled with the date and client version it was measured on.

### One-command demo

- `docker compose up` (file `compose.yaml`): `mock` (Anthropic and OpenAI mocks in one process), `tokenyard` (memory store, demo policy), `traffic` (deterministic generator: 8 developers in 3 teams, Claude Code-shaped sessions with subagents, compaction and auxiliary requests, cache markers, one fake AWS key pasted by one developer, a few Codex sessions). When traffic finishes, it runs `tokenyard policy replay` for the demo PR's policy change and prints the terminal report. Profiles: `redis` (Redis plus two gateway replicas, showing shared budgets), `otel` (OTel collector plus Jaeger).
- `npx @mateuszkania-im/tokenyard demo` does the same in one process without Docker, in under a minute on a laptop (target).
- The demo is deterministic (seeded); its trace file is committed under `examples/traces/` and is what the demo PR's Action replays.

### The demo PR

A real, open PR in the public repo, labelled `demo`, that changes `examples/policy/policy.yaml` in two plausible ways: move `compaction` and `auxiliary` requests to a cheaper Claude model, and tighten the `web` team's daily budget. The first change rewrites the model on coding-agent traffic, so the PR has to add `allowBodyRewrite: true` with a `because:` line, which is itself part of what the reviewer sees. The Action's comment on it is the screenshot and GIF in the README. The demo is built so that the cold-cache effect can show up if it exists in the data; the README reports whatever the replay computes, even if the "naive" change turns out cheaper.

### README outline

1. Title and one line: "Policy CI for coding-agent traffic."
2. GIF: the PR comment appearing after a push (recorded from the demo PR), plus light and dark PNG.
3. Quick start: `docker compose up` and `npx`.
4. Point Claude Code at it: the two lines; managed settings; Codex `config.toml`. Subscription mode is not mentioned (6.8).
5. What replay can and cannot tell you: the table from 9.3.
6. The policy file: the example from 6.3.
7. Measured: the generated benchmark block, then real sessions: anonymized results of the live Claude Code (and, if run, Codex) sessions: cost per session against Claude Code's own figure, cache hit ratio direct and through tokenyard, bound-to-actual ratio, one anonymized report screenshot and a trace excerpt.
8. Conformance: the generated matrix with client versions.
9. Budgets: the guarantee in 7.4 with its premises, the test that proves it, and the concurrency trade-off with measured numbers.
10. How it differs: table against LiteLLM, Bifrost and Claude apps gateway, every cell sourced, "planned" never shown as done.
11. Security, privacy and supply chain.
12. Limitations (one bullet per limit, as in why-diff).
13. Development; licence.

## 14. Milestones (12 working days)

| Day | Work | Done when |
|---|---|---|
| 1 | Scaffold (package.json, tsconfig, Vitest, esbuild bundle, CI on Linux and Windows, pack job); mock Anthropic provider with cache simulator and scenarios (TTFT, ping cadence, `overloaded_error` mid-stream, 429 with `retry-after`, 529 before headers, dropped connection); SSE parser and Anthropic usage accumulator | Parser and accumulator unit tests green; mock serves a scripted 40-turn session |
| 2 | Edge server, `/v1/messages` passthrough with tee, abort, header rules, error passthrough, `/v1/models`, `count_tokens`, `HEAD /api/hello`; conformance tests 1 to 16 | Suite green; real Claude Code works through tokenyard against the mock with the same cache hit ratio as direct; error display of each own-error type checked by hand against the mock. The same session against the real API runs on day 6 (14.1), because the 20 USD cap must be enforced by tokenyard's own budgets **(my call)** |
| 3 | Keys (hash), attribution, API billing, subscription passthrough behind `--experimental-subscription` (6.8), price table and cost, trace writer with instance ids, minimal `tokenyard report` | Cost per request matches the mock's billed usage priced by hand; subscription passthrough conformance (item 17) green on the mock. Cost against Claude Code's OTel `cost_usd` on a real API-key session is checked in the day 6 live run (14.1) |
| 4 | Policy schema (Zod), JSON Schema export, semantic validation, worst-case estimator (7.3, pure, needed by `decide`), compiler, `decide`/`resolve`, route matching, model allowlist, `policy check` | Property tests for determinism; every validation rule has a failing fixture |
| 5 | Loader (file watch, URL with ETag), bundle build, last-known-good, revision metrics, audit mode; chain executor with fallback rules, retry budget, breaker | Swap without restart under load with no failed request; a broken bundle keeps the old revision running |
| 6 | `CounterStore`: memory, Redis Lua (admit, settle, sweep), GCRA, per-key stream slots, warm-up from traces; budget proof test; first live run (14.1) | 1,000 concurrent on $1 with randomized actual cost holds on both stores in CI (7.4); route-coverage test green; a real Claude Code session through tokenyard on the live key, under the 20 USD cap, has per-request token counts equal to Claude Code's own OTel `api_request` events and cost matching its `cost_usd`; no direct-to-API run is made on the live key, since it would bypass the cap (cache fidelity against direct is proven on the mock, conformance item 15) |
| 7 | Secret rules, last-turn and history scan before admit, session taint inside `admit` (both stores), block and warn; product redaction and PII rules; false-positive corpus | Zero `block` hits on the corpus; scan time measured |
| 8 | Replay engine: sim store, base and head runs, cost model, session cuts, fidelity check, warm-up; terminal and JSON output | Snapshot tests deterministic; fidelity 100% on the demo traces replayed against their own revision |
| 9 | Markdown renderer, GitHub Action, demo traffic generator, committed demo traces, demo PR | The demo PR carries a real comment posted by the Action |
| 10 | `/v1/responses` passthrough, Responses usage, Codex conformance; `/v1/chat/completions` for product routes (stretch) | Real Codex works through tokenyard with `wire_api = "responses"` on the live harness when `OPENAI_API_KEY` is present; otherwise Codex is verified against the mock and listed as "not verified live" |
| 11 | OTel export, `/metrics`, Docker image, `compose.yaml` with profiles, `report --html` | `docker compose up` ends with a replay report; spans visible in the `otel` profile |
| 12 | Benchmarks run, README with generated blocks, anonymized live-session results, GIF and screenshots, security review pass, CHANGELOG 0.1.0, `npm pack` job | Every README number reproducible with `npm run bench`; package installs and runs from the tarball |

### 14.1 Live tests (Mateusz, 2026-11-02)

- **Harness:** `npm run live -- <scenario>` starts tokenyard with `node --env-file=.env`, the live policy `test/live/policy.yaml` and the memory store, prints only the gateway URL and a `ty_` key for the client, and refuses to start when `.env` has no `ANTHROPIC_API_KEY`, when today is after 2026-11-16, or when `TOKENYARD_LIVE_BUDGET_USD` is missing or above 20.
- **Cap enforced by tokenyard:** the live policy has one tenant `live` with a budget `live-total` (`scope: tenant`, `window: month`, `usd` from `TOKENYARD_LIVE_BUDGET_USD`, `onExceed: block`, `mode: enforce`, worst-case estimator, `serverToolsWithoutMaxUses: block`), covering every route, Anthropic and OpenAI together. Live traces go to `.live/traces/` (gitignored); at start the harness seeds the budget from every earlier live trace (the warm-up path, 9.2 step 6), so the cap holds across runs and processes, not per run. If the trace directory cannot be read, the harness refuses to start. All live runs fall inside November 2026, so the month window covers them all.
- **Key handling:** the Anthropic key is read only by the gateway process from its environment. It is never printed, logged, passed as an argument, written to traces or reports, committed or copied anywhere else. Claude Code and Codex talk to the gateway with the `ty_` key.
- **Codex:** run live only when `OPENAI_API_KEY` is set in the environment (the harness checks presence, never the value); otherwise the Codex scenarios use the mock and `docs/conformance.md` lists Codex as "not verified live". No other location is searched for keys.
- **Results:** the anonymized export of `.live/traces/` (`traces export --anonymize`) feeds the README's real-session section (13). Raw live traces stay local.

**Cut line** if days slip, in this order: `/v1/chat/completions`, `report --html`, PII redaction, audit mode in the gateway (replay stays), the circuit breaker (chain fallback stays), the `redis` compose profile. Never cut: conformance suite, budget proof, replay with fidelity check, the demo PR.

## 15. Deferred

Provider format translation (Bedrock, Vertex, OpenAI-compatible upstreams for Claude-format clients); Codex on a ChatGPT subscription; Presidio sidecar for NER PII; un-redaction; shadow traffic, golden-set evals and LLM judge (designed in 9.6); a randomised exploration slice for unbiased offline evaluation; latency in replay; response caching for idempotent replays; JWS-signed bundles; Postgres or ClickHouse trace sinks; tamper-evident hash-chained traces; SSO with short-lived keys; admin UI; MCP gateway; semantic cache; Helm chart and Kubernetes operator; multi-region; Bun and Workers runtimes; Codex WebSocket transport.

## 16. Risks

- **R1. Protocol churn.** Claude Code adds beta values, fields and headers every release; gateways that validated tool schemas broke on v2.1.265 to 267 and v2.1.275 ([Connect, troubleshooting](https://code.claude.com/docs/en/llm-gateway-connect.md)). Answer: byte passthrough, denylist headers, conformance suite re-run on new client versions, versions recorded in `docs/conformance.md`.
- **R2. Subscription passthrough terms.** Anthropic's docs describe a gateway that keeps the claude.ai OAuth login by setting only `ANTHROPIC_BASE_URL` ([LLM gateway](https://code.claude.com/docs/en/llm-gateway)), so it works technically. Whether Anthropic's Consumer Terms (Pro, Max) and the commercial terms for Team and Enterprise allow routing subscription traffic through a self-hosted proxy run by an employer **has not been verified**. Until it is, subscription mode is behind `--experimental-subscription`, absent from the README, and the demo does not depend on it (6.8) **(my call)**. Remote Control and voice dictation are unavailable behind a gateway credential, Remote Control is disabled with a non-Anthropic `ANTHROPIC_BASE_URL`, and gateway sessions are not eligible for the HIPAA configuration ([Connect](https://code.claude.com/docs/en/llm-gateway-connect.md)); the Limitations section says so.
- **R3. Anthropic closes the gap.** Claude apps gateway could add a dry-run mode, multi-tenancy or a panel. tokenyard's defence is neutrality (Codex, product traffic) and replay, but the gap may narrow.
- **R4. Replay overclaiming.** If the README promises more than "who, where, how much", a technical interviewer will ask about quality and counterfactuals. The exactness table and the fidelity rate are the answer; neither may be softened.
- **R5. Price table churn.** New models and multipliers appear often (0.025 and 0.05 read multipliers, a 100k tier for Haiku 5.5). Missing prices are validation errors, and the table records source and date per entry.
- **R6. Codex protocol from third-party sources.** Headers and the exact `response.completed` usage shape are not confirmed by OpenAI docs found so far. Day 10 pins them with a captured fixture.
- **R7. Node performance unmeasured.** The SLO latency targets are estimates. If measurement misses them, the README says so and the profile goes into an issue; the design does not change to chase microseconds.
- **R8. Worst-case reservations are large.** A 150k-token context with a large `max_tokens` reserves far more than it usually costs, which limits concurrency under small session budgets. That is why session budgets start in audit mode in the example, why `session-aware` exists with its weaker guarantee stated, and why the README states the concurrency trade-off with measured numbers (7.4). The hard bound makes it worse than the first draft's `bodyBytes / 3` estimate (about three times the input reservation, and every input token at the 1h cache write rate); that is the price of a guarantee that holds **(Mateusz, 2026-11-02)**.
- **R11. Tokenizer assumption.** The bytes bound in 7.3 rests on at most one token per byte, which is true of byte-level BPE but not published for Claude's tokenizer. Every live run and the calibration benchmark test it; a single violation turns the `bytes` bound off (all requests use `context-window`) until the factor is understood.
- **R12. Live-test spend.** The cap is 20 USD in total and the credits expire on 2026-11-16. Live runs are few and short, scheduled from day 6 on, and the harness refuses to start after the expiry date.
- **R9. Scope.** Translation and dashboards are the easiest places to spill over. The cut line in section 14 is the guard; days 1 and 2 (passthrough with cache intact) gate everything else.
- **R10. Demo realism.** The demo traffic is synthetic and the README says so. Real live sessions, anonymized, are shown next to it (13) **(Mateusz, 2026-11-02)**.

## 17. Open questions for Mateusz (resolved 2 November 2026)

1. **Name.** `tokenyard` approved, published as `@mateuszkania-im/tokenyard` **(Mateusz, 2026-11-02)**. Section 18.
2. **Live testing spend.** Real Claude Code and Codex sessions are approved **(Mateusz, 2026-11-02)**. They use the Anthropic key in the gitignored `.env` (credits valid until 2026-11-16) with a hard cap of 20 USD in total, enforced by tokenyard itself (`TOKENYARD_LIVE_BUDGET_USD=20`); the key value never leaves `.env` and the gateway process. Codex runs live only when `OPENAI_API_KEY` is in the environment, under the same cap **(my call)**, otherwise against the mock and listed as "not verified live". The subscription check is not run (item 4). Details in 14.1; dependent changes in G6, section 4 and the day 2, 3, 6 and 10 rows of section 14.
3. **Real traces.** The README uses synthetic traffic for the demo plus screenshots and excerpts from the real live sessions, fully anonymized: pseudonymized tenants, repos and sessions, no prompt content **(Mateusz, 2026-11-02)**. Section 13, `traces export --anonymize` in 9.5, R10.
4. **Subscription mode in v0.1.** Behind the `--experimental-subscription` flag and out of the README until Anthropic's terms on proxying subscription traffic are verified **(my call)**. The API-key path is the required one; subscription passthrough gets a conformance test against the mock and a manual check flagged "not run". Section 6.8, G6, R2.

Further decisions taken with these answers:

5. **Budget guarantee stays hard (Mateusz, 2026-11-02).** The worst-case estimator prices all input at the model's highest input-side rate, uses a bytes-based token bound with a tested assumption, and includes server-tool fees; G4 is restated as two invariants and the "admitted equals sequential" claim is replaced by a precise property test. Sections 7.3, 7.4, G4, R8, R11.
6. **Taint and stream caps inside admit (my call).** Session taint and the per-key concurrent stream cap live in the counter store and are checked in the same atomic `admit` call; secret scanning happens before admit and feeds it; replay rebuilds taint from traces. Sections 4, 5.3, 6.5, 6.6, 7.2.
7. **Traces from several instances (my call).** File names carry an instance id; `traces export` merges and orders them; replay requires the merged set and the fidelity check reports missing instances. Sections 9.1, 9.2, 9.5.

## 18. Name

Checked on 2 November 2026 with `npm view <name>` (unscoped and `@mateuszkania-im/<name>`) and `gh search repos <name> --limit 5`:

| Name | npm | `@mateuszkania-im/` | GitHub |
|---|---|---|---|
| **tokenyard** | free | free | one repo, `kaiyy06/TokenYard`: 0 stars, no description |
| yardmaster | free | free | unrelated: a 2018 Hubot plugin for Jenkins (13 stars), a Walmart yard-management app, `blothecap/yardmaster` (17 stars, no description) |
| replaygate | free | free | `bessavagner/replaygate`, "Record/replay regression testing for multi-turn AI agents" (0 stars): same field, likely confusion |

Also checked and rejected: `switchyard` (NVIDIA-NeMo/Switchyard, an LLM router with 3.5k stars), `agentgate` (npm taken; close to agentgateway), `turnout` (npm taken; a routing proxy on GitHub), `drydock`, `tollgate`, `gatecheck`, `waybill`, `policy-replay` (npm free, but generic and crowded by RL repos).

**Approved: `tokenyard` (Mateusz, 2026-11-02).** A rail yard is where traffic is sorted onto tracks by a written plan, which is what the gateway does with tokens; the name is free on npm both scoped and unscoped, has no meaningful GitHub conflict, is short, and reads well as a command (`tokenyard policy replay`). Published as `@mateuszkania-im/tokenyard` to match the siblings; the command is `tokenyard`.
