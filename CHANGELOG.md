# Changelog

## 0.1.0 (unreleased)

First release.

### Gateway

- Byte-for-byte passthrough for Claude Code on `/v1/messages` (streaming and not, `?beta=true` kept), `/v1/messages/count_tokens`, `GET /v1/models` and `HEAD /api/hello`, and for Codex on `/v1/responses` and `/responses`. Denylist header forwarding, upstream errors forwarded unchanged, tokenyard's own errors in each surface's envelope, `x-should-retry: false` on refusals that waiting cannot clear.
- Keys stored as SHA-256 hashes (`tokenyard keys create`), attribution per tenant, team, key, repo, branch, ticket, session, subagent, request class and prompt; `tokenyard env` for repo, branch and ticket headers.
- Budgets with reserve then settle in one atomic admit, on an in-memory store or Redis (Lua): worst-case and session-aware estimators, audit and enforce modes, GCRA rate limits, per-key concurrent stream caps, sweeper for abandoned reservations, warm-up from traces.
- Secret guardrail (block or warn on coding-agent traffic, redact on product traffic) with session taint inside admit; regex PII redaction on product routes.
- Provider chains with fallback before the first byte, retry budget and circuit breakers.
- Price table with source and date per entry, cost in integer micro-USD.
- NDJSON decision traces per instance with HMAC-pseudonymised ids, `traces export` (merged, with a manifest; `--anonymize`), `traces prune`.
- OTel GenAI spans (opt-in OTLP), Prometheus `/metrics` on a separate ops listener, `/healthz` and `/readyz`.

### Policy as code

- YAML policy with a Zod schema, JSON Schema export (`policy schema`), semantic validation (`policy check`), bundles (`policy build`), hot swap from a directory or an https URL with last-known-good, and an audit-mode candidate policy.
- `policy replay`: base and head policies over a merged trace export, with fidelity check, cost delta, reroutes, blocks, cut sessions and budget hits; terminal, JSON and Markdown output; CI gates.
- GitHub Action (`action.yml`) that posts one sticky pull request comment.

### Tooling and evidence

- `tokenyard demo` and `docker compose up` (profiles `redis` and `otel`) on deterministic mock providers; committed synthetic demo traces.
- `tokenyard report` (terminal and self-contained HTML).
- Conformance suite (C1 to C18, R1 to R8), budget proof test on both stores, benchmarks (`npm run bench`) with the generated README block, anonymized results of live Claude Code and Codex sessions (`examples/live/`).

### Security and packaging

- Security review of the gateway (spec section 15): regression suite in `test/security/` (duplicate admit, latch scope, header trust, key handling, trace redaction), all findings fixed before release.
- npm package `@mateuszkania-im/tokenyard`: one bundled file, no runtime dependencies, tarball limited to `bin/`, `action.yml`, `LICENSE`, `README.md` and `package.json`, scanned for secrets; `publishConfig` with public access and provenance.
- CI: Node 20.19, 22 and 24 on Linux and Node 22 on Windows, Redis job (store contract and budget proof), pack smoke test on Linux and Windows (install the tarball, run `--version`, `policy check`, `demo`), README benchmark check, `npm audit signatures`, compose smoke test. Actions pinned to commit SHAs, read-only token, no publish job.

### Not in this release

`/v1/chat/completions`, quality evaluation ([docs/future-quality.md](docs/future-quality.md)), Redis Cluster, Codex WebSocket transport. See the README's Limitations.
