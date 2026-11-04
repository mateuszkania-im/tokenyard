# Changelog

## 0.2.0 (2026-11-04)

### Gateway

- `tokenyard serve --workers <n>` runs n gateway processes on one port with `node:cluster` (default 1, the single process as before). The primary serves no traffic: it hands each connection to a worker in turn, replaces a worker that crashes after it was ready, and stops with exit 1 when a worker fails before it is ready or workers crash more than 5 times within a minute. Each worker has its own instance id (`<instance>-w<k>`, new for every fork, so trace files, `traces export` and replay see one instance per process), its own policy loader (a policy change reaches every worker), its own sweeper (the Redis sweep lock keeps it to one sweep per interval) and its own ops listener on `--metrics-port` plus its slot minus one. SIGTERM or SIGINT to the primary drains every worker within `--shutdown-grace-ms` and exits 0. More than one worker needs `--store redis`; `n` must be a whole number from 1 to the CPU count.

### Docs

- docs/usage.md: step-by-step setup (npx demo, install, policy directory, keys, serve, Claude Code and Codex, reports, the CI Action, several processes).
- First release on npm: `npx @mateuszkania-im/tokenyard demo`.

### Benchmarks

- The overhead benchmark adds 500-stream rows on the Redis store with the gateway as 1 to 4 processes on one port, the mock and the load generator in several processes each, and SLO rows for 3 gateway processes (README, Measured; docs/benchmarks.md).

## 0.1.0 (2026-11-04)

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
- Graceful shutdown on SIGTERM and SIGINT: `/readyz` answers 503 while requests and streams in flight finish within `--shutdown-grace-ms` (default 30 s); a second signal stops at once. Startup warnings for enforced budgets on the memory store without `--trace-dir` and for unset provider credential variables.

### Policy as code

- YAML policy with a Zod schema, JSON Schema export (`policy schema`), semantic validation (`policy check`), bundles (`policy build`), hot swap from a directory or an https URL with last-known-good, and an audit-mode candidate policy.
- `policy replay`: base and head policies over a merged trace export, with fidelity check, cost delta, reroutes, blocks, cut sessions and budget hits; terminal, JSON and Markdown output; CI gates.
- GitHub Action (`action.yml`) that posts one sticky pull request comment; a failed gate is also named in the job log. Use it as `mateuszkania-im/tokenyard@v0.1.0`.

### Tooling and evidence

- `tokenyard demo` and `docker compose up` (profiles `redis` and `otel`) on deterministic mock providers; committed synthetic demo traces.
- `tokenyard report` (terminal and self-contained HTML).
- Conformance suite (C1 to C18, R1 to R8), budget proof test on both stores, benchmarks (`npm run bench`) with the generated README block, anonymized results of live Claude Code and Codex sessions (`examples/live/`).

### Security and packaging

- Security review of the gateway (spec section 15): regression suite in `test/security/` (duplicate admit, latch scope, header trust, key handling, trace redaction), all findings fixed before release.
- npm package `@mateuszkania-im/tokenyard`: one bundled file, no runtime dependencies, tarball limited to `bin/`, `action.yml`, `LICENSE`, `README.md` and `package.json`, scanned for secrets; `publishConfig` with public access and provenance.
- CI on Linux and Windows: `npm run check` on Node 20.19, 22 and 24, the suite on 22 and 24 (Vitest 5 needs Node 22.12 or later), the packed bundle on 20.19; coverage thresholds per core module, mutation testing on demand, Redis job (store contract and budget proof), pack smoke test on Linux and Windows (install the tarball, run `--version`, `policy check`, `demo`), README benchmark check, `npm audit signatures`, compose smoke test. Actions in every workflow pinned to commit SHAs (checked by a test), read-only token, no publish job. `publishConfig.provenance` makes a local `npm publish` fail; a hand publish needs `--provenance=false` (see the README, Publishing).

### Not in this release

`/v1/chat/completions`, quality evaluation ([docs/future-quality.md](docs/future-quality.md)), Redis Cluster, Codex WebSocket transport. See the README's Limitations.
