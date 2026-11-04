# Development

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
npm run bench            # writes bench/results.json; then node scripts/bench-to-readme.mjs --write docs/benchmarks.md
npm run bench:check      # fails when the docs/benchmarks.md block differs from bench/results.json
```

TypeScript strict, ESM, Vitest, raw `node:http`, `undici` upstream, Node 20.19 or later (CI on Linux and Windows: the suite on Node 22 and 24, the packed bundle on Node 20.19; quality gates in [docs/quality-gates.md](quality-gates.md)). The design is in [docs/superpowers/specs/2026-11-02-gateway-design.md](superpowers/specs/2026-11-02-gateway-design.md); designed but not built: [quality evaluation](future-quality.md). Changes: [CHANGELOG.md](../CHANGELOG.md).

## How it is tested

[docs/conformance.md](conformance.md) is generated from the test names in `test/conformance/`: rules C1 to C18 for Anthropic Messages (Claude Code) and R1 to R8 for OpenAI Responses (Codex), each a test that sends recorded or synthetic traffic through the gateway in front of a mock and compares what the provider received and what the client got back, each linked to the documentation it comes from. They run in CI on every push. Among them: body bytes upstream equal the client's bytes for every fixture (C1), headers including `anthropic-beta` forwarded verbatim (C2), no buffering of SSE (C6), truncated streams reach the client truncated and are settled from the usage seen (C8), client aborts close the upstream within 100 ms (C9), upstream errors forwarded unchanged (C10), and a 40-turn session with identical usage through tokenyard and direct (C15), with a deliberately naive proxy failing the same tests (C1b, C15b) to show they can fail.

Failure behaviour is tested the same way, against mocks: provider 5xx and 529, drops mid-stream, slow headers, refused and reset connections, clients that leave at any point or stop reading, Redis paused or unreachable under load, policy files caught mid-write and a flapping policy URL. After each scenario every request has exactly one trace line, is charged at least what the provider billed, fell back only before the first byte, and leaves nothing reserved. Scenarios, results and the fixes they led to: [docs/chaos.md](chaos.md) (`npm run test:chaos`).

Invariants that must hold for any input are property tests and fuzzers with fixed seeds: budgets never above their limit and always released, the memory and Redis stores agreeing on the same operations, concurrent admits on one key matching a sequential model, replay reproducing every recorded decision of random request mixes, and the SSE parser, policy YAML loader, attribution headers, anonymizer and secret scanner under hostile input. List, seeds and findings: [docs/testing.md](testing.md) (`npm run test:fuzz`).

Client versions checked by hand: Claude Code 2.1.316 (against the mock, then the [live sessions](real-sessions.md)) and 2.1.317 (live), and Codex 0.166.0 (live, one task in each run). Every new client release can add fields, headers and beta values; the suite is re-run on new versions and the versions are recorded in that file.

## Publishing

The package sets `publishConfig.provenance: true`, so a local `npm publish` fails outside a supported CI provider (npm cannot sign provenance from a laptop). A hand publish needs `npm publish --provenance=false`; a provenance-signed release needs a later trusted publish job with `id-token: write`, which CI does not have yet.
