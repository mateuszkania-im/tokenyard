# Benchmarks

Every number in the README's [Measured](../README.md#measured) block comes from one run of `npm run bench`, which writes `bench/results.json`; `node scripts/bench-to-readme.mjs --write README.md` renders that file into the block between the `BENCH:START` and `BENCH:END` markers, and `npm run bench:check` (CI) fails when the block differs from what the results render to. Nothing in the block is typed by hand. The numbers in the README's [Real sessions](../README.md#real-sessions) section come from `examples/live/` (below), and a test (`test/docs/readme.test.ts`) fails when a number in the hand-written parts of the Measured, Real sessions and Budgets sections appears in neither `bench/results.json` nor `examples/live/`.

## Reproduce

```sh
npm ci
npm run bench                                   # writes bench/results.json
node scripts/bench-to-readme.mjs --write README.md
npm run bench:check
```

- **Hardware and versions.** `bench/results.json` records the CPU, core count, memory, OS, Node, tsx and Redis versions and the commit it ran at; the README block prints them on its first line. The committed results were measured on an Apple M2 Pro laptop (12 cores, 16 GB) on Node 22.14. Expect different absolute numbers on other machines; the comparisons between direct and gateway paths and between stores are what carry over.
- **Redis.** The overhead and budget benchmarks run on both stores. With `REDIS_URL` unset, the runner starts a throwaway Redis container (`redis:7`, published on a random 127.0.0.1 port with a random password, removed at the end; `scripts/local-redis.mjs`). With `REDIS_URL` set it uses that server, but only a loopback one, because the budget benchmark flushes it (`BENCH_ALLOW_FLUSH=1` overrides). Without Docker and without `REDIS_URL`, the Redis rows say "not measured".
- **No real provider is called.** Every request goes to the deterministic mock provider (`src/mock/`) on loopback, and the gateway's provider key is a placeholder.
- **Development runs.** `BENCH_QUICK=1 npm run bench` shortens the overhead runs; its results are not for committing. `BENCH_SCENARIOS` (`non-streaming`, `streaming-500`, `body-150kb`, comma-separated) and `BENCH_CONCURRENCY` (for example `10,100`) narrow the overhead benchmark when it runs alone: `npx tsx bench/overhead.ts`.

## What each benchmark measures

### Gateway overhead (`bench/overhead.ts`)

Three scenarios: a non-streaming request with a small body, a streaming request with a 500-token answer, and a streaming request with a 150 KB body (a long agent context). Each runs at 1, 10, 16, 64, 100, 256 and 500 streams (10, 100 and 500 are the levels the SLO rows use), on the memory store and on the Redis store. The mock and the gateway each run in their own child process, so the gateway's CPU and RSS are its own; the load generator runs in the benchmark process.

- **Load.** Open loop: each stream is one keep-alive connection opened before the run, with its own evenly spaced send schedule (5 requests per second non-streaming, 1.25 streaming) starting at a seeded random phase, so connections do not fire together. A request still running at its next scheduled time delays the next one, and client-side latency counts from the scheduled time, so coordinated omission is included rather than hidden.
- **Mock.** A fixed 100 ms time to first token, then 500 tokens at 2,000 tokens per second.
- **Added TTFB (gateway-measured).** The gateway's own per-request measure from its traces (`addedTtfbMs`, from the start of request handling to forwarding upstream, with a sub-millisecond clock in the benchmark). It is paired per request by construction. It does not include time a request waits before the gateway starts handling it, nor the response path.
- **Client-side TTFB outside the provider.** Each request's client-side TTFB minus the mock's own wait for that request (the `x-mock-wait-ms` response header), paired per request so the mock's timer jitter drops out. Direct and through-the-gateway values are shown side by side as absolute percentiles and never subtracted from each other.
- **SLO verdict.** An added TTFB row is met only when both the gateway-measured value and the client-side TTFB outside the provider through the gateway are under the target. The client-side value is an upper bound on what the gateway adds and includes queueing before handling, which the gateway's own measure cannot see.
- **CPU and RSS.** CPU is the gateway process's user plus system time over the run's wall time (100% is one core). RSS growth is the peak during the run above the size just before it. "Per 100 streams" is the slope between 100 and 500 streams, flagged when the gateway was saturated at 500.
- **Gateway configuration.** `examples/policy` with every budget level enforced at a limit the load never reaches, no rate limits, guardrails on, traces written and metrics kept.
- **n** is the number of samples behind each percentile; errors count non-2xx answers and socket errors; scheduled requests that could not be sent within the drain time are listed as dropped in `bench/results.json`.

### Budget correctness (`bench/budget.ts`)

The G4 scenario of the design spec (section 7.4) through the whole gateway: 1,000 requests, each on its own connection opened beforehand, sent at the same moment against one enforced $1 budget, with each actual cost drawn (seeded) between 0 and that request's limits by the mock. Run on both stores and both estimators. It records how many admit calls the store decided before the first settle, the most open reservations, admitted and rejected counts, final spend, the highest spent plus reserved after any admit, the largest overspend, final spend minus the sum of settled costs (lost updates) and the reservation left at the end.

The concurrency trade-off rows send 40 copies of one 150,000-byte turn with `max_tokens` 32,000 on Opus 5.5 at once in one session under an enforced $25 session budget, while the mock holds every stream open, and count how many were admitted in flight with each estimator.

The unit form of the proof (`test/limits/budget-proof.test.ts`) runs in `npm test` on the memory store and in `npm run test:redis` on Redis.

### Cache economics (`bench/cache.ts`)

The 40-turn Claude Code shaped session of conformance test C15, sent straight to the mock, through tokenyard, and through a deliberately naive proxy that flattens `system` into a string (`test/helpers/`), each priced at Opus 5.5 list prices from `examples/policy/prices.yaml`. The mock simulates prompt caching from `cache_control` breakpoints. The cache hit ratio is cache reads over all input tokens (input, cache reads and cache writes).

### Secret scan (`bench/scan.ts`)

Throughput of the last-turn scan (every rule) and the full-body scan on a synthetic coding-agent body of about 4 MiB (source-like text in tool results), and block hits on the false-positive corpus: real source trees and lockfiles sent as tool results. The corpus is assembled from this repository and the sibling projects listed in `test/fixtures/fp-corpus/README.md`, so its file count depends on which of them are checked out next to this one. Alone: `npx tsx bench/scan.ts [megabytes]`.

### Replay throughput (`bench/replay.ts`)

1,000,000 synthetic trace records: the committed demo week (`examples/traces/demo.ndjson.gz`) repeated week after week with fresh ids and sessions, written as one gzipped export. The timed part is what `tokenyard policy replay` does with such a file: read, parse, simulate the base and the head policy, with the fidelity check. Alone: `npx tsx bench/replay.ts [records]`. The SLO says "on a CI runner"; the committed number is from the laptop above, and the README says so.

### Estimator calibration (`bench/calibration.ts`)

For every request with usage, the input token bound it was admitted with against the input the provider billed, and its reservation against its actual cost, on the demo traces and on the local live traces (`.live/traces`, gitignored, present only on the machine that ran the live tests). Only aggregates are written. Any request whose billed input is above its bound fails the run (R11 in the design spec). Alone: `npx tsx bench/calibration.ts`. Without `.live/traces` the live rows are left out and the note says so.

## Live results (`examples/live/`)

The live sessions run only through `npm run live` (design spec, section 14.1), on the maintainer's machine, against the real APIs under a hard cap enforced by tokenyard's own budget. Their raw traces stay in `.live/traces/` (gitignored). What is committed is derived from an anonymized export only:

```sh
# a fresh random salt each time, never stored
node bin/tokenyard.mjs traces export --since 30d --trace-dir .live/traces --anonymize --salt "$(node -e 'console.log(require("crypto").randomBytes(24).toString("base64url"))')" --out examples/live/live.ndjson.gz
node bin/tokenyard.mjs report --traces examples/live/live.ndjson.gz --since 2026-11-01T00:00:00Z --until 2026-11-04T00:00:00Z --by session --html examples/live/report.html
npx tsx bench/live-summary.ts                   # examples/live/summary.json (and .live/raw-names.json, local only)
```

`--anonymize` replaces tenant, team, key, repo, branch, ticket and feature with salted pseudonyms, drops the client version, and re-keys every linkable id with the same salt: record ids become their position in the export, instance ids, the session, agent and prompt HMACs, the prefix hash and guardrail value HMACs are replaced consistently within the export (so sessions, subagent joins, the cache-breaker list and taint still work) and match nothing in the raw traces. Dates in `summary.json` and the README are UTC.

The screenshots `examples/live/report-light.png` and `report-dark.png` are that HTML report rendered by headless Chrome with the light and the dark color scheme (`--blink-settings=preferredColorScheme=1` and `=0`, `--force-device-scale-factor=2`). `summary.json` holds the aggregates the README quotes; the per-session cost Claude Code printed is not in any trace and is copied from `test/live/claude-code.live.md`, and the client versions (dropped by `--anonymize`) from the two live logs.

`.live/raw-names.json` lists the raw tenant, team, key, repo, branch, ticket and feature values of the raw traces and every linkable id in them (record, instance, session, agent and prompt ids, prefix hashes, guardrail value HMACs); the local-only tests in `test/docs/readme.test.ts` check that none of them appears in `examples/live/`. It is skipped in CI, where the raw traces do not exist.

## Demo comment image

`docs/demo-comment-light.png` and `docs/demo-comment-dark.png` are a local render of the Markdown the GitHub Action posts (`renderMarkdown` on the replay of `examples/traces/demo.ndjson.gz` with `examples/policy` as base and `examples/policy-head` as head), converted to HTML with GitHub-like styles and captured with headless Chrome in both color schemes. No network service is involved:

```sh
npx tsx scripts/render-demo-png.ts      # CHROME=<path> overrides the macOS Chrome location
```
 They will be replaced by a recording of the real demo pull request's bot comment once that pull request is open.
