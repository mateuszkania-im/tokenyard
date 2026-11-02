# tokenyard: design spec

Date: 2 November 2026. Status: brief approved by Mateusz Kania, spec for v0.1 (the 12-day MVP).
Author of the brief: Mateusz Kania. Decisions taken while writing this spec, rather than by Mateusz, are marked **(my call)**; they can be changed by whoever builds it without asking.

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
| G4 | Budgets that hold under concurrency: reserve then settle, atomic across tenant, team, key, repo and session; Redis and in-memory stores | 1,000 concurrent requests against a $1 budget with the worst-case estimator end with spend at or below $1, in both stores, in CI |
| G5 | Attribution per tenant, team, developer key, repo, branch, ticket, session, subagent, request class and prompt | `tokenyard report` splits cost by each; cost per request matches Claude Code's own `claude_code.api_request.cost_usd` on a real session |
| G6 | Both billing modes: API billing (USD budgets, fallbacks) and subscription passthrough (OAuth token forwarded; visibility, guardrails, audit; cost shown as "API-equivalent") | A Claude Code session on a subscription login works through tokenyard and appears in the report |
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
5. **Subscription mode.** The developer sets only `ANTHROPIC_BASE_URL` and `ANTHROPIC_CUSTOM_HEADERS="x-tokenyard-key: ty_live_xxxxxxxx"`, and no credential variable. Claude Code then keeps the claude.ai OAuth login as the credential; the gateway must forward the OAuth value in `anthropic-beta` or requests fail with 401 ([LLM gateway](https://code.claude.com/docs/en/llm-gateway)). With a credential variable set, the subscription is not used and traffic is billed per token to the upstream key owner ([LLM gateway](https://code.claude.com/docs/en/llm-gateway)). See risk R2 on whether this is allowed.
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
- **Hot path budget:** at most one network round trip that is not the upstream call: the counter store. Everything else is in memory or after the response ends.
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
2. **Authenticate.** Read the credential from `x-tokenyard-key`, then `Authorization: Bearer`, then `x-api-key`. Look up its SHA-256 in the in-memory key map (constant-time compare not needed on a hash lookup; the map is keyed by hash). Unknown key: 401 in the Anthropic error envelope. In subscription mode the key comes from `x-tokenyard-key` and `Authorization` carries the user's OAuth token, which is kept for forwarding and never logged.
3. **Read the body** into one `Buffer`, up to the configured cap (default 32 MiB **(my call; builder checks Anthropic's documented request size limit and matches it)**). Over the cap: 413 in the Anthropic envelope.
4. **Extract features** with one read-only `JSON.parse` of a copy: `model`, `stream`, `max_tokens`, tool count, `thinking` present, number of `anthropic-beta` values, body size, SHA-256 of the canonical `tools` plus `system` bytes as `prefixHash` (to detect cache breaks between turns of a session), and attribution headers. The parsed object is never serialised again on coding-agent routes; the forwarder only ever sees the original `Buffer` (a type-level rule: the forwarder takes `Buffer`, not an object).
5. **Guardrails** (section 6.6): scan the last message (the newest user turn and its `tool_result` blocks) and, for a tainted session, the matched rules over the whole body. Result: hits with action `block` or `warn`.
6. **Decide** (pure, section 6.5): `decide(policy, features)` returns a plan: route, provider chain, reservations to make with their estimates, rate checks, guardrail outcome.
7. **Admit:** one call to the counter store: GCRA checks and budget reservations, atomic across all levels (section 7).
8. **Resolve** (pure): `resolve(policy, plan, admission)` returns forward or block. A block is answered in the Anthropic error envelope (section 5.6) and traced; no upstream call.
9. **Forward.** Headers per section 5.5; the original body bytes; `accept-encoding: identity` towards upstream on inference paths so the tee can parse plain text **(my call)**. An `AbortController` is tied to the client socket's `close`, so a cancelled Claude Code turn stops upstream generation.
10. **First response headers from upstream.** If the status is retryable (section 8) and nothing has been written to the client yet, try the next provider in the chain. Otherwise write status and headers to the client and flush them immediately. Add `x-tokenyard-request-id`, `x-tokenyard-policy-revision` and `X-Accel-Buffering: no`. Never compress the response.
11. **Body.** `pipeline(upstreamBody, tee, res)` with backpressure. The tee passes every chunk on unchanged before parsing it, so parsing cannot delay or alter bytes. The SSE parser takes `input_tokens`, `cache_creation_input_tokens` (with the 5m and 1h split) and `cache_read_input_tokens` from `message_start`, and overwrites with any values in later `message_delta` events, because "The token counts shown in the `usage` field of the `message_delta` event are *cumulative*" ([Anthropic streaming](https://platform.claude.com/docs/en/build-with-claude/streaming)). It notes `event: error` (for example `overloaded_error` after a 200), whether `message_stop` arrived, and ignores unknown event types. `ping` events pass through like any other bytes.
12. **End.** Usage source is `final` when `message_stop` was seen, `partial` when the stream ended or was aborted after `message_start` (input billed, output from the last `message_delta`, or estimated as `ceil(streamed delta chars / 4)` when there was none, flagged `estimated`), `none` when no `message_start` arrived. A truncated upstream stream reaches the client truncated: tokenyard never synthesises a `message_stop` (Claude Code treats a clean end after a started block as a dropped connection, which is the truth). Cost is computed (section 7.6), the reservation is settled (never released to zero when usage exists, the [#35568](https://github.com/BerriAI/litellm/issues/35568) bug), the trace is queued, the span ends. Settle and trace happen after `res.end()`.

Non-streaming requests follow the same steps; the body is piped unchanged and a copy is parsed for `usage` after the end.

`/v1/messages/count_tokens` is forwarded with the same header rules and no reservation; if the provider has no such endpoint the gateway returns 404 and Claude Code falls back to a character estimate ([Claude Code gateway protocol](https://code.claude.com/docs/en/llm-gateway-protocol.md)). `GET /v1/models` is answered by tokenyard itself from the models the key's routes allow, only ids that contain `claude` (Claude Code keeps only those), with no redirect and well inside the 3 s discovery timeout ([Claude Code gateway protocol](https://code.claude.com/docs/en/llm-gateway-protocol.md)).

### 5.4 Request lifecycle: OpenAI Responses, streaming (Codex)

Same steps 1 to 12, with these differences:

- Paths: `/v1/responses` and `/responses` (Codex appends `/responses` to `base_url`).
- Features: `model`, `stream`, `max_output_tokens`, tool count, `reasoning` present, session from the `session_id` or `session-id` header. Codex sends a session header used by Bifrost for affinity, and third-party sources list `originator`, `session_id`, `version` and `thread_id`; there is no official list ([Bifrost Codex guide](https://docs.getbifrost.ai/cli-agents/codex-cli), [tokn-headers](https://docs.rs/tokn-headers/0.2.0/src/tokn_headers/schemas/personas/codex_cli.rs.html)). tokenyard reads them as best-effort attribution and forwards them unchanged.
- Usage: only in the terminal `response.completed` event; `response.incomplete` carries `incomplete_details`; `response.failed` carries an error ([OpenAI streaming events](https://developers.openai.com/api/reference/resources/responses/streaming-events)). The exact usage shape inside `response.completed` (`input_tokens`, `output_tokens`, `input_tokens_details.cached_tokens`) was not confirmed from a primary source in the research, so the accumulator is written against a recorded fixture on day 10 and a unit test pins it. A stream that ends without `response.completed` is settled as `partial` from streamed output text.
- Encrypted reasoning items and unknown fields pass through untouched (they are just bytes).
- WebSocket transport is not supported; the docs tell users to set `supports_websockets = false`.

`/v1/chat/completions` (Cline, OpenCode, product features) is a stretch goal for day 10. On product routes only, tokenyard may add `stream_options.include_usage = true` when the client did not ask, and then drops the extra usage chunk before it reaches that client, because without it an interrupted stream may never report usage ([OpenAI community](https://community.openai.com/t/usage-stats-now-available-when-using-streaming-with-the-chat-completions-api-or-completions-api/738156)). On coding-agent routes the body is never touched, so usage may be missing and the request is settled as `estimated`.

### 5.5 Header rules

Requests to upstream: forward every header **except** hop-by-hop headers (`connection`, `keep-alive`, `proxy-*`, `te`, `trailer`, `transfer-encoding`, `upgrade`), `host` (set to the upstream host), `content-length` (recomputed only when a product route changed the body), `accept-encoding` (set to `identity`), everything starting with `x-tokenyard-`, and the inbound credential, which is replaced by the provider credential in API mode and forwarded unchanged in passthrough mode. This is a denylist on purpose: `anthropic-beta` must be forwarded verbatim ("don't allowlist individual values"), headers and body fields are open lists, and a gateway pinned to an observed list breaks on the next release ([Claude Code gateway protocol](https://code.claude.com/docs/en/llm-gateway-protocol.md)). `x-claude-code-*` headers are forwarded too **(my call; the guide says they need not be, and forwarding keeps the request identical to a direct one)**.

Responses to the client: forward every header except hop-by-hop ones; `retry-after`, `x-should-retry` and `anthropic-ratelimit-unified-*` pass through unchanged ([Claude Code gateway protocol](https://code.claude.com/docs/en/llm-gateway-protocol.md)). tokenyard adds only its own `x-tokenyard-*` headers and `X-Accel-Buffering: no`.

### 5.6 Errors

- **Upstream errors** are forwarded unchanged: status, headers and body bytes. Claude Code's automatic recovery (thinking type swap, `cache_control` moved, effort removed, and others) matches on the upstream's wording, and a gateway envelope breaks it ([Claude Code gateway protocol](https://code.claude.com/docs/en/llm-gateway-protocol.md)). Context-limit errors in the gateway's own words also stop auto-compaction ([Connect](https://code.claude.com/docs/en/llm-gateway-connect.md)).
- **tokenyard's own errors** use the surface's envelope: Anthropic `{"type":"error","error":{"type":"...","message":"tokenyard: ..."}}`, OpenAI `{"error":{"type":"...","code":"...","message":"tokenyard: ..."}}`, with `x-tokenyard-request-id`. Types **(my call; the builder confirms with a real Claude Code session on day 2 that each message is shown to the user and not retried in a loop)**:
  - rate limit: 429 `rate_limit_error` with `retry-after` as integer seconds, at most 60, because a value above 60 stops retries and shows the error at once ([Claude Code gateway protocol](https://code.claude.com/docs/en/llm-gateway-protocol.md));
  - budget exhausted: 429 `rate_limit_error` with no `retry-after`, which is how Anthropic answers a reached spend cap ([Anthropic rate limits](https://platform.claude.com/docs/en/api/rate-limits)), and a message naming the budget and when its window resets;
  - secret blocked: 400 `invalid_request_error` naming the rule, the message index and what to do (`/clear`, rotate the key, add a deny rule for the file); never the secret itself;
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
keys: ./keys.yaml                     # key hash, tenant, team, name, kind (developer|service), billing (api|subscription)

providers:
  anthropic:
    format: anthropic
    baseUrl: https://api.anthropic.com
    credential: { env: ANTHROPIC_API_KEY }
  anthropic-backup:                   # second workspace; a fallback here starts a cold cache
    format: anthropic
    baseUrl: https://api.anthropic.com
    credential: { env: ANTHROPIC_API_KEY_BACKUP }
  anthropic-subscription:
    format: anthropic
    baseUrl: https://api.anthropic.com
    credential: passthrough           # forwards the developer's own OAuth token
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
  - name: claude-code-subscription
    match: { surface: anthropic-messages, traffic: coding-agent, billing: subscription }
    chain: [anthropic-subscription]
  - name: codex
    match: { surface: openai-responses, traffic: coding-agent }
    chain: [openai]
  - name: support-summaries
    match: { traffic: product, feature: support-summary }
    chain: [anthropic]
    rewriteModel: claude-haiku-4-5    # product traffic only
    criticality: sheddable

budgets:
  - { name: org-month,  scope: tenant,  window: month, usd: 6000, onExceed: block }
  - { name: team-day,   scope: team,    window: day,   usd: 300,  onExceed: block }
  - { name: dev-day,    scope: key,     window: day,   usd: 40,   onExceed: block, mode: audit }
  - { name: session,    scope: session,                usd: 25,   onExceed: block, mode: audit }
  - { name: sub-watch,  scope: key,     window: day,   usd: 100,  onExceed: warn,
      match: { billing: subscription } }  # API-equivalent USD, visibility only

reservation:
  estimator: worst-case               # worst-case | session-aware
  onOverrun: allow-and-debit

rateLimits:
  - { name: dev-rpm, scope: key, rpm: 120, burst: 30 }

guardrails:
  secrets:
    rules: default                    # curated prefix rules, section 6.6
    codingAgent: block                # block | warn
    product: redact                   # block | warn | redact
    entropyOnly: warn                 # entropy-only hits never block
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
  claude-haiku-4-5:  { input: 1, output: 5,  cacheWrite5m: 1.25, cacheWrite1h: 2, cacheRead: 0.10, source: ..., retrieved: ... }
modifiers:
  inferenceGeoUs: 1.1                 # all token categories, Claude 4.6 and later
```

### 6.4 Validation rules

Zod schema plus semantic checks; errors fail `policy check` and refuse a load, warnings are printed and shown in the PR comment.

Errors:

- Every provider in a chain exists; chains have 1 to 3 entries.
- A route whose `match.surface` is `anthropic-messages` and whose traffic is `coding-agent` may only chain `format: anthropic` providers.
- `rewriteModel` and `redact` are errors on `coding-agent` traffic, unless the route sets `allowBodyRewrite: true` and names the reason in `because:` (the escape hatch is explicit and greppable) **(my call)**.
- `credential: passthrough` only with the provider's official host (`api.anthropic.com`, `api.openai.com`), so a user's OAuth token can never be sent to a third-party host.
- Every model in `allowModels` patterns that resolves to a concrete id in `rewriteModel`, and every model a route can produce, has a price. A model without a price is an error, because unpriced models counted as $0 is a known failure in other gateways ([Portkey budget limits](https://portkey.ai/docs/product/ai-gateway/virtual-keys/budget-limits), [LiteLLM #48937](https://github.com/BerriAI/litellm/issues/48937)).
- Budget names unique; `window` is `day`, `week` or `month` (UTC) except `scope: session`, which has none; `usd > 0`.
- `failure.counterStoreDown.budgets` must be stated explicitly when any budget uses `mode: enforce`.

Warnings:

- A child budget larger than its parent (team above tenant).
- A surface with no route (requests on it would get 403 "no route").
- A route that can never match because an earlier route covers it.
- `estimator: session-aware` together with `onExceed: block` on a session budget (the guarantee in 7.4 does not hold).

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
  inputTokensEst: number;              // ceil(bodyBytes / 3), see 7.3
  maxOutputTokens: number | null;
  toolCount: number; thinking: boolean;
  attribution: {
    session: string | null; agent: string | null; parentAgent: string | null;
    requestClass: 'main' | 'subagent' | 'workflow' | 'compaction' | 'auxiliary' | null;
    agentType: string | null; promptId: string | null;
    repo: string | null; branch: string | null; ticket: string | null; feature: string | null;
  };
  guardrail: { hits: GuardrailHit[] }; // computed before decide, from content the trace never stores
}

export interface Plan {
  policyRevision: string;
  route: string | null;                // null: no route matched
  chain: Array<{ provider: string; upstreamModel: string; rewritesModel: boolean }>;
  reservations: Array<{ budget: string; key: string; limitMicroUsd: number; estMicroUsd: number; enforce: boolean }>;
  rateChecks: Array<{ limit: string; key: string; emissionMs: number; burst: number; quantity: number }>;
  preBlock: BlockReason | null;        // decided without counters: model not allowed, no route, secret
  warnings: Warning[];                 // guardrail warns, audit-mode notes
}

export interface Admission {           // returned by CounterStore.admit(plan)
  admitted: boolean;
  failed: { kind: 'budget' | 'rate'; name: string; spentMicroUsd?: number; retryAfterMs?: number } | null;
  audit: Array<{ name: string; wouldFail: boolean }>;
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

- **What is scanned:** the newest turn (the last message and its `tool_result` blocks). Earlier turns were scanned when they were new.
- **Session taint:** when a hit blocks a request, the session (by `x-claude-code-session-id`, or the key when there is none) is marked tainted with the rule id and an HMAC of the matched value. Later requests in a tainted session are scanned in full with only those rules, and blocked while the same value is still present. Without this, the next turn would carry the secret in its history and pass, because only the newest turn is scanned. The message tells the developer to `/clear`, rotate the secret and add a deny rule. The secret is never stored.
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

## 7. Budgets, rate limits and cost

### 7.1 Store interface

```ts
export interface CounterStore {
  admit(plan: Plan, nowMs?: number): Promise<Admission>;          // atomic: rate checks plus all reservations
  settle(id: string, actualMicroUsd: number, perLevel?: boolean): Promise<'settled' | 'unknown'>;  // idempotent
  sweep(nowMs: number): Promise<number>;                            // settles overdue reservations
  snapshot(keys: string[]): Promise<Record<string, { spent: number; reserved: number }>>;
}
```

Implementations: `memory-store` (one instance, demo and tests; atomic because Node is single-threaded and `admit` has no `await` inside the critical section), `redis-store` (Lua), and `sim-store` in `replay/` (memory store driven by a virtual clock).

Money is stored as integer micro-USD (`HINCRBY`, not `HINCRBYFLOAT`) so that sums never drift **(my call)**.

### 7.2 Reserve then settle in Redis

Keys share the hash tag `{tenant}` so that all keys of one script sit in one Redis Cluster slot: `ty:{acme}:b:team-day:web:2026-11-02` (hash fields `s` spent, `r` reserved), `ty:{acme}:res:<id>` (reservation record), `ty:{acme}:deadlines` (sorted set by deadline), `ty:{acme}:g:<limit>:<key>` (GCRA theoretical arrival time).

`admit.lua` (sketch):

```lua
-- KEYS: budget keys..., res key, deadlines zset, gcra keys...
-- ARGV: id, est, n, limits..., enforce flags..., deadline, window TTLs..., gcra params...
local t = redis.call('TIME')                                  -- store clock for GCRA, not the instance clock
if redis.call('EXISTS', resKey) == 1 then return {2} end      -- duplicate admit for this id: no second reservation
-- 1) GCRA checks; first failing limit returns {0, 'rate', name, retryAfterMs} without writing anything
-- 2) budget checks: for each enforced level, spent + reserved + est > limit returns {0, 'budget', i, spent}
--    audit levels are checked and reported, never block
-- 3) all passed: HINCRBY r est on every level (audit ones too, so audit spend is real), EXPIRE window keys,
--    HSET res record {est, keys}, ZADD deadlines deadline id, update GCRA TATs
return {1, auditResults}
```

`settle.lua`: if the reservation record is gone, return `unknown` (idempotent); otherwise for each level `HINCRBY r -est` and `HINCRBY s actual`, delete the record, `ZREM` the deadline. `sweep.lua`: for ids past their deadline (default 2 times the request timeout), settle at the reserved estimate and mark the trace `settledBy: sweeper`. Any instance runs the sweeper every 30 s under a short `SET NX` lock.

### 7.3 The estimate

- `inputTokensEst = ceil(bodyBytes / 3)` **(my call)**: an upper-bound heuristic that needs no tokenizer. Base64 images make it loose. The trace stores both the estimate and the actual input total, and the README reports the measured ratio from the demo and from a real session.
- `worst-case` estimator: `inputTokensEst` priced as uncached input, plus `max_tokens` (or the route's `reserveOutputTokens` cap on product routes) priced as output. Coding-agent bodies are never modified, so the reservation uses the client's own `max_tokens`.
- `session-aware` estimator: input priced with the cache read share of the session's previous request (kept in a small in-memory LRU per instance), output as `min(max_tokens, route.reserveOutputTokens)`. Admits more concurrency; gives up the hard bound.
- Server tool fees (for example web search) are not in the estimate; they are added at settle from `server_tool_use` when the price table has a price, and listed as a known gap otherwise.

### 7.4 What is guaranteed

With `estimator: worst-case`, correct prices and a provider that bills no more than `max_tokens` of output, actual cost is at most the reservation, so **admitted spend never exceeds an enforced budget**. The proof test (G4) runs 1,000 concurrent requests against a $1 budget on both stores and asserts `spent <= limit` and that the number admitted equals what a sequential run admits. With `session-aware`, the bound becomes: overspend at most the sum, over requests in flight, of (actual minus estimate), and the README says so. `onOverrun: allow-and-debit` lets a stream that outruns its reservation finish and puts the budget into debt; the next request is blocked. Cutting a coding-agent stream mid tool call wastes every token already spent, so cutting is not offered for coding-agent traffic.

Coverage: every inference route goes through the same admit hook. A test enumerates the route table and fails if one does not, because LiteLLM's budget bypasses were coverage gaps, not maths: pass-through routes ([#10750](https://github.com/BerriAI/litellm/issues/10750)) and another client path, $764.78 spent against a $50 budget ([#12977](https://github.com/BerriAI/litellm/issues/12977)).

### 7.5 Rate limits

GCRA: one theoretical arrival time per key, no background process, Redis `TIME` as the clock ([Brandur](https://brandur.org/rate-limiting)). `rpm` uses quantity 1; `itpm` (input tokens per minute) uses quantity `inputTokensEst`. Output-token limits are not shaped at admission, matching Anthropic's own OTPM, which counts only tokens actually generated ([Anthropic rate limits](https://platform.claude.com/docs/en/api/rate-limits)).

### 7.6 Cost

Per request, from the four Anthropic token buckets ([Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)):

```
cost = input * p.input + cacheWrite5m * p.cacheWrite5m + cacheWrite1h * p.cacheWrite1h
     + cacheRead * p.cacheRead + output * p.output     (then modifiers: inferenceGeoUs 1.1, tiers)
```

`input_tokens` is only the part after the last cache breakpoint; total input is read plus creation plus input. When `cache_creation` has no 5m/1h split, all of it is 5m. Cache read multipliers differ by model (0.1, 0.05 for Opus 5.5 and Sonnet 5.5, 0.025 for Fable 5.1), which is why the table stores absolute prices, not multipliers. Haiku 5.5's higher tier above 100k prompt tokens is a `tiers` entry. For Responses, cached tokens come from `input_tokens_details.cached_tokens` (shape pinned by fixture, see 5.4). The trace stores the price table version so cost can be recomputed.

**Subscription mode:** the same function gives "API-equivalent" USD. It is labelled as such everywhere (report, PR comment, OTel attribute `tokenyard.cost.basis = "api-equivalent"`). Budgets on subscription keys default to `onExceed: warn`; `block` is allowed (a team may want to cap even subscription use) and the schema prints a warning. The `anthropic-ratelimit-unified-*` response headers are recorded on the trace as the plan-limit view.

Unknown model at runtime (a new Claude Code alias): with `unpricedModel: allow-and-flag` the reservation uses the most expensive priced model in the table, the request is flagged `unpriced`, and the report lists it; with `block` it gets 403.

## 8. Fallbacks, retries and idempotency

- A fallback or retry happens **only before the first byte is written to the client**. Bytes already sent are never retried and two providers' streams are never spliced.
- Retryable before headers: connect and TLS errors, a timeout before headers, 500, 502, 503, 504 and 529. Spend-cap 429 (`enforced_spend_limit_reached`, no `retry-after`) opens that provider's breaker until the policy's `openSeconds` ([Anthropic rate limits](https://platform.claude.com/docs/en/api/rate-limits)). Other 429s are forwarded unchanged so Claude Code's own retry logic applies, unless the route sets `fallbackOn429: true`. Other 4xx are always forwarded unchanged.
- Mid-stream errors (`event: error` after a 200) are forwarded as they are and counted in metrics, because status-code metrics alone undercount them.
- At most 3 attempts per request (the chain length cap). A per-tenant retry budget of 10% of requests over a trailing minute stops fallback storms ([Google SRE](https://sre.google/sre-book/handling-overload/)). Circuit breaker per provider with the thresholds from `failure.breaker`; numbers live in policy, mechanism in code.
- A fallback to another Anthropic workspace starts a cold cache; the trace marks `cacheColdRisk: true` and replay prices it (9.4).
- **Idempotency.** The gateway request id is the reservation id, so `admit` and `settle` are idempotent per request. A client `Idempotency-Key` header (product routes) is scoped per key: the reservation id becomes `hash(tenant, key, Idempotency-Key)`, a concurrent duplicate gets 409, and a request with the same key but a different body fingerprint gets 422 ([Brandur, idempotency keys](https://brandur.org/idempotency-keys)). Replaying a completed response from a cache is deferred. Claude Code sends no idempotency key; its retries are new requests, and a failed attempt that produced no usage settles at zero, which is correct because the provider billed nothing.

## 9. Traces and replay

### 9.1 Trace record

One NDJSON line per request, written after the response ends through a bounded async queue (overflow drops the record and increments `tokenyard_traces_dropped_total`; the hot path never waits on disk). Files: `<trace-dir>/<tenant>/<YYYY-MM-DD>/<HH>.ndjson`, rotated hourly **(my call: NDJSON instead of the SQLite ledger in the research; no native module, works on Node 20 and Windows, and the same file is the replay input)**.

```ts
interface TraceRecord {
  v: 1;
  id: string; ts: string;                        // request start, ISO
  tenant: string; team: string | null; keyId: string;   // config names and opaque key id, in clear
  traffic: 'coding-agent' | 'product'; billing: 'api' | 'subscription'; surface: string;
  client: { agent: 'claude-code' | 'codex' | 'other'; version: string | null };   // from User-Agent, best effort
  attribution: {                                 // session, agent, parentAgent, promptId: HMAC-SHA256 with a per-deployment salt
    session: string | null; agent: string | null; parentAgent: string | null; promptId: string | null;
    requestClass: string | null; agentType: string | null;
    repo: string | null; branch: string | null; ticket: string | null; feature: string | null;
  };
  features: { model: string; stream: boolean; inputTokensEst: number; maxOutputTokens: number | null;
              toolCount: number; thinking: boolean; bodyBytes: number; prefixHash: string | null;
              contextCompacted: boolean };
  guardrail: { hits: Array<{ rule: string; action: 'block' | 'warn' | 'redact'; valueHmac: string; where: 'last-turn' | 'history' }> };
  policy: { revision: string; candidateRevision?: string };
  decision: { route: string | null; action: 'forward' | 'block'; reason: string | null;
              chain: string[]; reservedMicroUsd: number; audit: Array<{ name: string; wouldFail: boolean }> };
  candidateDecision?: TraceRecord['decision'];
  outcome: {
    provider: string | null; upstreamModel: string | null; attempts: number; cacheColdRisk: boolean;
    status: number; errorClass: string | null; midStreamError: string | null;
    ttfbMs: number | null; totalMs: number; addedTtfbMs: number | null;
    usage: { input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number } | null;
    usageSource: 'final' | 'partial' | 'estimated' | 'none';
    costMicroUsd: number | null; costBasis: 'billed' | 'api-equivalent'; priceTable: string;
    aborted: boolean; settledBy: 'request' | 'sweeper';
    rateLimitHeaders?: Record<string, string>;   // anthropic-ratelimit-unified-* only
  };
}
```

No prompt text, no tool content, no file paths from the body, no credentials. `addedTtfbMs` is the time from request received to first byte written, minus the upstream's own time to first byte. Retention is the operator's (a `traces prune --older-than 30d` command). Content capture is not available in v0.1.

### 9.2 Replay algorithm

`tokenyard policy replay --base <policy dir or git ref> --head <policy dir> --traces <files or dir> [--since 7d] [--tenant acme] --md comment.md --json replay.json`

1. Load traces, sort by `ts` then `id`.
2. Run the **base** policy and the **head** policy separately over the same traces, each with its own `sim-store` on a virtual clock driven by `ts`. Diffing head against base (rather than head against what was recorded) keeps the comparison fair when traces were recorded under several revisions.
3. For each record and each policy: build `RequestFeatures` from the trace (guardrail hits come from the recorded `guardrail.hits`), call `decide`, `sim-store.admit`, `resolve`. If forwarded, compute the replayed cost (9.4), then `sim-store.settle`.
4. **Session cuts.** A session is *cut* when a policy blocks one of its requests after at least one of its earlier requests was forwarded. From that point the policy's simulation drops the session's remaining recorded requests (assumption: the agent stops) and the report counts them as "requests that would not have happened as recorded", with their recorded cost.
5. **Fidelity check.** For records whose `policy.revision` equals the base revision, replaying the base must reproduce the recorded decision. The agreement rate is printed at the top of every comment; disagreements are listed by reason (missing counter state at the start of the window, dropped traces, retries the trace cannot see). A low rate tells the reviewer not to trust the diff.
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

Where traces come from in CI: `tokenyard traces export --since 7d --out traces.ndjson.gz` on the gateway host, published to a location the CI job can read with a read-only token. In this repo's demo, a synthetic trace file generated by `tokenyard demo` is committed under `examples/traces/`.

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

Codex Responses: body and header byte equality including encrypted reasoning items and unknown fields; SSE passthrough; `response.completed` usage parsed; `response.failed` and `response.incomplete` forwarded; truncated stream settled as `partial`; `/responses` and `/v1/responses` both served.

Fixtures are synthetic and built from the documented shapes **(my call)**, plus one header set captured from a real Claude Code session on a public repo with every value replaced. A `CONFORMANCE_LIVE=1` mode runs a small subset against the real APIs with keys from the environment; it never runs in CI. The manual check on day 2 (Claude Code) and day 10 (Codex) records the client versions in `docs/conformance.md`.

## 11. Security model and threat model

### Assets

Provider API keys; developers' gateway keys; developers' OAuth subscription tokens (subscription mode); prompt content (source code, sometimes secrets); traces; the policy; budget counters.

### Trust boundaries

Developer machine (untrusted for anything but its credential); the gateway process; Redis; the policy source; the CI job that replays a PR; the trace store.

### Threats and mitigations

| Threat | Mitigation |
|---|---|
| Stolen developer key | Keys stored as SHA-256 only; per-key budgets and rate limits bound the damage; revoke by removing the line from `keys.yaml` (hot reload); `ty_live_` prefix so secret scanners (including tokenyard's own rule) find leaked keys |
| Header spoofing to dodge attribution or budgets (random session id per request, fake request class) | Identity, tenant, team, traffic class and billing come from the key. Session budgets and request-class routing are best effort and documented as such; hard limits are on key, team and tenant. Model allowlists are enforced whatever the headers say. Anthropic warns headers and User-Agent can be spoofed ([Claude apps gateway](https://code.claude.com/docs/en/claude-apps-gateway)) |
| Provider key leak through the gateway | Never logged, never reflected in responses or errors; upstream URLs come only from policy, never from the request; upstream redirects are not followed |
| OAuth subscription token misuse | Forwarded only to the provider's official host (schema rule 6.4), only for the request it came with; never logged, stored or traced; no pooling |
| Prompt content leak through traces, logs or telemetry | Traces hold no content; logs hold no bodies; OTel opt-in content attributes (`gen_ai.input.messages` and similar) are never set; session and agent ids are HMAC-pseudonymised |
| Policy tampering | Policy only from git through CI; sha256 checked at load; active revision exported and traced; no runtime API that changes policy |
| Malicious policy PR attacking CI (exfiltrate traces, run code) | Policy is YAML parsed by Zod, never executed; the Action runs the released bundle pinned by version, not code from the PR; traces contain no content; fork PRs get no trace token |
| Budget bypass through concurrency or another path | Atomic reservation (7.2); route-coverage test (7.4) |
| Counter store outage | Explicit per-policy behaviour: rate limits open, budgets closed (or open, if the operator chooses and writes it down) |
| Denial of service | Body size cap, header size cap, per-key concurrent stream cap, timeouts for headers and idle upstream streams (long enough for extended thinking), criticality-based shedding of `sheddable` product routes first ([Google SRE](https://sre.google/sre-book/handling-overload/)) |
| Cross-tenant leakage | Every key belongs to one tenant; every counter key and trace path is prefixed by tenant; replay and report filter by tenant; a test asserts no code path builds a counter key without the tenant tag |
| Secret sent to a provider | Secret guardrail (6.6). Limits stated plainly: it cannot stop prompt injection or local exfiltration by the agent |
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

Metrics: `gen_ai.client.inference.duration`, `gen_ai.client.inference.time_to_first_chunk`, token usage counters, and `tokenyard_added_ttfb_seconds`, `tokenyard_requests_total{route,decision,status_class}`, `tokenyard_cost_usd_total{tenant,team,route,request_class}`, `tokenyard_cache_hit_ratio`, `tokenyard_policy_revision_info`, `tokenyard_policy_load_errors_total`, `tokenyard_traces_dropped_total`, `tokenyard_reservations_open`. High-cardinality ids (session, prompt, key) stay on spans and traces, never on metric labels. A plain Prometheus text endpoint `/metrics` serves the same counters without OTel configured **(my call)**. `/healthz` (process up) and `/readyz` (policy loaded, store reachable or failure mode allows traffic).

`tokenyard report` (terminal, `--json`, `--html` like read-receipts) gives cost by tenant, team, key, repo, branch, session, request class, and per active developer-day next to Anthropic's reference figure, plus cache hit ratio per session and a "cache breaker" list: sessions whose `prefixHash` changed between turns.

Claude Code itself can export OTel with `claude_code.api_request` carrying `cost_usd` ([Claude Code monitoring](https://code.claude.com/docs/en/monitoring-usage)). The day 3 check compares tokenyard's cost against it for the same session. Whether `x-claude-code-session-id` equals OTel `session.id` is not confirmed by the docs (`/clear` replaces `session.id`), so the comparison joins on request id and time, not on session.

### 12.3 Benchmarks plan

All in `bench/`, run by `npm run bench`, results in `bench/results.json` with hardware, OS, Node and tool versions, and copied into the README between `<!-- BENCH:START -->` and `<!-- BENCH:END -->` by a script; CI fails if the block is out of date (as read-receipts does with its study block). Nothing is written in the README before it is run.

1. **Overhead.** Load generator: oha with latency correction, or autocannon; not k6, which does not correct coordinated omission by default ([TechEmpower](https://send-now.techempower.com/posts/wrk-vs-k6-vs-oha.html)). Same host, loopback, mock with fixed TTFT and token rate. Scenarios: non-streaming small request; streaming 500-token response; 150 KB request body (a long agent context). Concurrency 10, 100, 500 streams. Report added TTFB and added total time (gateway minus direct) at p50, p95, p99, plus CPU and RSS per 100 streams. Memory store and Redis store separately.
2. **Budget correctness.** 1,000 concurrent requests against a $1 budget, both stores: final spend, admitted count, maximum overspend. Also with `session-aware`, to show the difference.
3. **Cache economics.** The 40-turn session from conformance test 15 through tokenyard and through the naive proxy, priced at Opus 5.5 list prices. At those prices a 100,000-token prefix costs $0.02 from cache and $0.40 uncached on every turn ([Claude pricing](https://platform.claude.com/docs/en/about-claude/pricing)); the benchmark reports what the whole session costs both ways.
4. **Secret scan.** Time per MB for the last-turn scan and a full-body scan; hits on the false-positive corpus.
5. **Replay throughput.** Records per second on 1 million synthetic records.
6. **Estimator calibration.** Ratio of `inputTokensEst` to actual input on the demo traffic and on one real session.

## 13. README and demo plan

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
4. Point Claude Code at it: the two lines; managed settings; subscription mode (marked experimental, see R2); Codex `config.toml`.
5. What replay can and cannot tell you: the table from 9.3.
6. The policy file: the example from 6.3.
7. Measured: the generated benchmark block.
8. Conformance: the generated matrix with client versions.
9. Budgets: the guarantee in 7.4 and the test that proves it.
10. How it differs: table against LiteLLM, Bifrost and Claude apps gateway, every cell sourced, "planned" never shown as done.
11. Security, privacy and supply chain.
12. Limitations (one bullet per limit, as in why-diff).
13. Development; licence.

## 14. Milestones (12 working days)

| Day | Work | Done when |
|---|---|---|
| 1 | Scaffold (package.json, tsconfig, Vitest, esbuild bundle, CI on Linux and Windows, pack job); mock Anthropic provider with cache simulator and scenarios (TTFT, ping cadence, `overloaded_error` mid-stream, 429 with `retry-after`, 529 before headers, dropped connection); SSE parser and Anthropic usage accumulator | Parser and accumulator unit tests green; mock serves a scripted 40-turn session |
| 2 | Edge server, `/v1/messages` passthrough with tee, abort, header rules, error passthrough, `/v1/models`, `count_tokens`, `HEAD /api/hello`; conformance tests 1 to 16 | Suite green; real Claude Code works through tokenyard against the mock and against the real API with the same cache hit ratio as direct; error display of each own-error type checked by hand |
| 3 | Keys (hash), attribution, billing modes including subscription passthrough, price table and cost, trace writer, minimal `tokenyard report` | Cost per request matches Claude Code's OTel `cost_usd` on a real session; a subscription-login session works and shows API-equivalent cost |
| 4 | Policy schema (Zod), JSON Schema export, semantic validation, compiler, `decide`/`resolve`, route matching, model allowlist, `policy check` | Property tests for determinism; every validation rule has a failing fixture |
| 5 | Loader (file watch, URL with ETag), bundle build, last-known-good, revision metrics, audit mode; chain executor with fallback rules, retry budget, breaker | Swap without restart under load with no failed request; a broken bundle keeps the old revision running |
| 6 | `CounterStore`: memory, Redis Lua (admit, settle, sweep), GCRA, warm-up from traces; budget proof test | 1,000 concurrent on $1 holds on both stores in CI; route-coverage test green |
| 7 | Secret rules, last-turn scan, session taint, block and warn; product redaction and PII rules; false-positive corpus | Zero `block` hits on the corpus; scan time measured |
| 8 | Replay engine: sim store, base and head runs, cost model, session cuts, fidelity check, warm-up; terminal and JSON output | Snapshot tests deterministic; fidelity 100% on the demo traces replayed against their own revision |
| 9 | Markdown renderer, GitHub Action, demo traffic generator, committed demo traces, demo PR | The demo PR carries a real comment posted by the Action |
| 10 | `/v1/responses` passthrough, Responses usage, Codex conformance; `/v1/chat/completions` for product routes (stretch) | Real Codex works through tokenyard with `wire_api = "responses"` |
| 11 | OTel export, `/metrics`, Docker image, `compose.yaml` with profiles, `report --html` | `docker compose up` ends with a replay report; spans visible in the `otel` profile |
| 12 | Benchmarks run, README with generated blocks, GIF and screenshots, security review pass, CHANGELOG 0.1.0, `npm pack` job | Every README number reproducible with `npm run bench`; package installs and runs from the tarball |

**Cut line** if days slip, in this order: `/v1/chat/completions`, `report --html`, PII redaction, audit mode in the gateway (replay stays), the circuit breaker (chain fallback stays), the `redis` compose profile. Never cut: conformance suite, budget proof, replay with fidelity check, the demo PR.

## 15. Deferred

Provider format translation (Bedrock, Vertex, OpenAI-compatible upstreams for Claude-format clients); Codex on a ChatGPT subscription; Presidio sidecar for NER PII; un-redaction; shadow traffic, golden-set evals and LLM judge (designed in 9.6); a randomised exploration slice for unbiased offline evaluation; latency in replay; response caching for idempotent replays; JWS-signed bundles; Postgres or ClickHouse trace sinks; tamper-evident hash-chained traces; SSO with short-lived keys; admin UI; MCP gateway; semantic cache; Helm chart and Kubernetes operator; multi-region; Bun and Workers runtimes; Codex WebSocket transport.

## 16. Risks

- **R1. Protocol churn.** Claude Code adds beta values, fields and headers every release; gateways that validated tool schemas broke on v2.1.265 to 267 and v2.1.275 ([Connect, troubleshooting](https://code.claude.com/docs/en/llm-gateway-connect.md)). Answer: byte passthrough, denylist headers, conformance suite re-run on new client versions, versions recorded in `docs/conformance.md`.
- **R2. Subscription passthrough terms.** Anthropic's docs describe a gateway that keeps the claude.ai OAuth login by setting only `ANTHROPIC_BASE_URL` ([LLM gateway](https://code.claude.com/docs/en/llm-gateway)), so it works technically. Whether Anthropic's Consumer Terms (Pro, Max) and the commercial terms for Team and Enterprise allow routing subscription traffic through a self-hosted proxy run by an employer **has not been verified**. Until it is, the README marks subscription mode as experimental, tells users to check their agreement, and the demo does not depend on it. Remote Control and voice dictation are unavailable behind a gateway credential, Remote Control is disabled with a non-Anthropic `ANTHROPIC_BASE_URL`, and gateway sessions are not eligible for the HIPAA configuration ([Connect](https://code.claude.com/docs/en/llm-gateway-connect.md)); the Limitations section says so.
- **R3. Anthropic closes the gap.** Claude apps gateway could add a dry-run mode, multi-tenancy or a panel. tokenyard's defence is neutrality (Codex, product traffic) and replay, but the gap may narrow.
- **R4. Replay overclaiming.** If the README promises more than "who, where, how much", a technical interviewer will ask about quality and counterfactuals. The exactness table and the fidelity rate are the answer; neither may be softened.
- **R5. Price table churn.** New models and multipliers appear often (0.025 and 0.05 read multipliers, a 100k tier for Haiku 5.5). Missing prices are validation errors, and the table records source and date per entry.
- **R6. Codex protocol from third-party sources.** Headers and the exact `response.completed` usage shape are not confirmed by OpenAI docs found so far. Day 10 pins them with a captured fixture.
- **R7. Node performance unmeasured.** The SLO latency targets are estimates. If measurement misses them, the README says so and the profile goes into an issue; the design does not change to chase microseconds.
- **R8. Worst-case reservations are large.** A 150k-token context with a large `max_tokens` reserves far more than it usually costs, which limits concurrency under small session budgets. That is why session budgets start in audit mode in the example, and why `session-aware` exists with its weaker guarantee stated.
- **R9. Scope.** Translation and dashboards are the easiest places to spill over. The cut line in section 14 is the guard; days 1 and 2 (passthrough with cache intact) gate everything else.
- **R10. Demo realism.** The demo traffic is synthetic. The README says so, and adds one real replay only if Mateusz provides traces from his own public-repo sessions (Q3).

## 17. Open questions for Mateusz

1. **Name.** Approve `tokenyard` (section 18), or pick one of the alternatives.
2. **Live testing spend.** Days 2, 3 and 10 need real Claude Code and Codex sessions through the gateway: on API keys (roughly how many dollars are acceptable) and, for the subscription check on day 3, on his own Claude subscription. Is that acceptable given R2?
3. **Real traces.** May the README include one replay of his own Claude Code sessions on public repos (pseudonymised, metadata only, same allowlist approach as read-receipts), or synthetic only?
4. **Subscription mode in v0.1.** Ship it marked experimental, or keep it behind a flag and out of the README until the terms question in R2 is answered?

## 18. Name

Checked on 2 November 2026 with `npm view <name>` (unscoped and `@mateuszkania-im/<name>`) and `gh search repos <name> --limit 5`:

| Name | npm | `@mateuszkania-im/` | GitHub |
|---|---|---|---|
| **tokenyard** | free | free | one repo, `kaiyy06/TokenYard`: 0 stars, no description |
| yardmaster | free | free | unrelated: a 2018 Hubot plugin for Jenkins (13 stars), a Walmart yard-management app, `blothecap/yardmaster` (17 stars, no description) |
| replaygate | free | free | `bessavagner/replaygate`, "Record/replay regression testing for multi-turn AI agents" (0 stars): same field, likely confusion |

Also checked and rejected: `switchyard` (NVIDIA-NeMo/Switchyard, an LLM router with 3.5k stars), `agentgate` (npm taken; close to agentgateway), `turnout` (npm taken; a routing proxy on GitHub), `drydock`, `tollgate`, `gatecheck`, `waybill`, `policy-replay` (npm free, but generic and crowded by RL repos).

**Recommendation: `tokenyard`.** A rail yard is where traffic is sorted onto tracks by a written plan, which is what the gateway does with tokens; the name is free on npm both scoped and unscoped, has no meaningful GitHub conflict, is short, and reads well as a command (`tokenyard policy replay`). Published as `@mateuszkania-im/tokenyard` to match the siblings; the command is `tokenyard`.
