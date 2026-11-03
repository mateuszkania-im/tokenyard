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
- **SLO verdict.** An added TTFB row is met only when both the gateway-measured value and the client-side TTFB outside the provider through the gateway are under the target. The client-side value is an upper bound on what the gateway adds and includes queueing before handling, which the gateway's own measure cannot see. The SLO table uses the 10, 100 and 500 stream rows (about 2,200 scheduled requests each); the table of every level in the README applies the same rule to each row (`addedTtfbMet` in `bench/results.json`), with its own n, which is about 300 at 1, 16, 64 and 256 streams.
- **Throughput.** Answered (2xx) requests per second and output tokens per second of each run, for both paths, from the run's first scheduled send to its last answer. Direct, every answer carries the mock's fixed 500 output tokens; through the gateway, the output tokens are the ones its traces settled, so the two columns also cross-check the gateway's usage accounting. The load is open loop at a fixed rate per stream, so throughput follows the offered load (streams times rate) until a path saturates; then the run drains past its window and throughput falls below the offered load.
- **CPU and RSS.** CPU is the gateway process's user plus system time over the run's wall time (100% is one core). RSS growth is the peak during the run above the size just before it. "Per 100 streams" is the slope between 100 and 500 streams, flagged when the gateway was saturated at 500.
- **Gateway configuration.** `examples/policy` with every budget level enforced at a limit the load never reaches, no rate limits, guardrails on, traces written and metrics kept.
- **n** is the number of samples behind each percentile; errors count non-2xx answers and socket errors; scheduled requests that could not be sent within the drain time are listed as dropped in `bench/results.json`.

### Profiling and hot-spot fixes (V1)

Profiles come from the overhead benchmark itself: `BENCH_CPU_PROF=<dir>` runs the gateway child with `node --cpu-prof`, and `scripts/cpuprofile-top.mjs` lists the functions with the most self time. A gateway child writes two profiles (its main thread and the tsx loader thread); the larger one is the main thread. A profile covers the whole child run, including the direct run and the warm-up, so the shares below are of busy (non-idle) main-thread time.

```sh
BENCH_CPU_PROF=/tmp/ty-prof BENCH_SCENARIOS=body-150kb BENCH_CONCURRENCY=100 npx tsx bench/overhead.ts > /dev/null
node scripts/cpuprofile-top.mjs "$(ls -S /tmp/ty-prof/*.cpuprofile | head -1)" 30
npx tsx bench/hot-path.ts          # per-call CPU of the synchronous steps on the 150 KB body
```

Top self time before the fixes (commit 5ad6f31), share of busy main-thread time:

| Scenario | Top functions |
|---|---|
| 150 KB body, 100 streams, memory (16.3 s busy) | keyword prefilter in the guardrail scan (`String.includes` per keyword per view) 23%, `topLevelValueRanges` 10%, `arrayElementRanges` 7%, scan view building 7%, socket `writev` 5%, garbage collector 5%, body-shape scan 4% |
| Non-streaming, 500 streams, memory (10.2 s busy) | `Breaker.record` 18% (every outcome refiltered the whole 30 s window, 75,000 outcomes at this load), garbage collector 10%, `runChain` 5%, `writev` 4% |
| Streaming 500 tokens, 500 streams, memory (9.2 s busy) | `writev` 26%, `nextTick` 8%, SSE usage accumulator (`JSON.parse` per event) 6%, SSE parser 5%, `Breaker.record` 2% |

The fixes, each with a test that holds its behaviour to the previous code:

| Commit | Change | Test | `bench/hot-path.ts`, before / after (ms per call) |
|---|---|---|---|
| 34b34e2 | Breaker window: outcomes in time order expire from the front with a running failure count (the whole window is still filtered after the clock steps back) | property test against the whole-window reference; timing test (30,000 outcomes in one window under 250 ms) | one outcome with 75,000 in the window: 0.4976 / 0.0002 |
| b67f06d, 9c9bef3 | Guardrail scan: one alternation pass finds the keywords of a view; messages with a single piece stay out of the joined view (it only reports matches that cross pieces); runs are slices of one latin1 copy | `keywordsIn` property test against `String.includes`; differential property test (hits, spans, segments, raw bodies) against a frozen copy of the previous scanner, `test/guardrails/scan-reference.ts` | scan of the 150 KB body: 2.8772 / 0.8233 |
| 371bf58 | JSON walkers: strings end at the next quote preceded by an even run of backslashes (indexOf); the messages ranges are walked once; `duplicateTopLevelKey` checks several keys in one walk; the body-shape scan uses the same string skip | differential property tests (walkers, feature extraction on both surfaces, model rewrite, output cap, shape refusals, broken bodies) against frozen copies in `test/surfaces/reference/` | feature extraction: 1.4028 / 0.2424; body-shape check: 0.2953 / 0.0526 |

No rule, region or refusal was dropped: every rule still runs on every region it ran on, and the security suite (`test/security`) is unchanged and green. After the fixes the same 150 KB profile has 8.8 s busy (from 16.3 s for the same requests), led by `writev` 17% and scan view building 7%; at 500 non-streaming streams `Breaker.record` is gone from the list and busy time fell from 10.2 s to 7.4 s. The streaming profile at 500 streams is unchanged: it is per-chunk forwarding (`writev`, stream callbacks, the SSE usage tap), one socket write per upstream chunk, which the gateway does not batch so as not to delay tokens. The secret scan benchmark below moved from 85.7 to 168.6 MiB/s on the last-turn scan and from 45.4 to 56.2 MiB/s on the full-body scan.

Before and after per overhead row: the "before" run is `node scripts/local-redis.mjs npx tsx bench/overhead.ts` in a worktree of 5ad6f31 on the same laptop in the same session; the "after" run is the committed `bench/results.json`. A row is met when the gateway-measured added TTFB and the client-side TTFB outside the provider are both under 5 ms p50 and 25 ms p99. Rows met: 19 of 42 before, 25 of 42 after; of the 18 SLO rows (10, 100 and 500 streams), 8 before and 11 after.

| Scenario | Store | Streams | Before: added / client outside (ms) | After: added / client outside (ms) | Before | After | Gateway CPU before / after |
|---|---|---:|---|---|---|---|---:|
| non-streaming | memory | 1 | 1.21 / 2.1; 6.17 / 11.83 | 0.91 / 2.74; 6.42 / 14.81 | missed | missed | 4.8% / 3.7% |
| non-streaming | redis | 1 | 3.97 / 5.86; 9.48 / 12.29 | 3.12 / 5.3; 7.15 / 12.4 | missed | missed | 5.4% / 4.9% |
| non-streaming | memory | 10 | 0.62 / 2.03; 3.48 / 12.81 | 0.68 / 1.54; 4.13 / 11.66 | met | met | 26.3% / 25.3% |
| non-streaming | redis | 10 | 2.13 / 6.6; 4.6 / 12.22 | 2.49 / 8.98; 5.93 / 16.32 | met | missed | 28.4% / 26.7% |
| non-streaming | memory | 16 | 0.42 / 2.43; 3.38 / 99.72 | 0.53 / 1.51; 3.95 / 8.96 | missed | met | 25.9% / 27.6% |
| non-streaming | redis | 16 | 1.91 / 5.08; 3.97 / 8.65 | 2.02 / 5.96; 4.74 / 12.97 | met | met | 33.9% / 31.6% |
| non-streaming | memory | 64 | 0.15 / 0.56; 0.95 / 6.47 | 0.18 / 0.82; 1.35 / 7.82 | met | met | 59.9% / 60.2% |
| non-streaming | redis | 64 | 1.13 / 4.01; 2.03 / 7.61 | 1.3 / 6.36; 2.56 / 12.02 | met | met | 58.4% / 59% |
| non-streaming | memory | 100 | 0.11 / 0.44; 0.76 / 5.85 | 0.14 / 0.63; 0.93 / 8.28 | met | met | 58.1% / 61.5% |
| non-streaming | redis | 100 | 0.93 / 4.24; 1.57 / 8.58 | 1.07 / 4.87; 1.96 / 9.69 | met | met | 58.3% / 63.6% |
| non-streaming | memory | 256 | 0.06 / 0.15; 0.5 / 5.15 | 0.08 / 0.16; 0.68 / 5.27 | met | met | 85.2% / 80.7% |
| non-streaming | redis | 256 | 0.6 / 2.7; 0.82 / 4.61 | 0.58 / 2.68; 0.9 / 4.99 | met | met | 75.6% / 78.3% |
| non-streaming | memory | 500 | 0.04 / 0.1; 33.51 / 1250.22 | 0.05 / 0.1; 0.66 / 7.58 | missed | met | 101.2% / 94% |
| non-streaming | redis | 500 | 5.69 / 118.13; 23.87 / 1552.63 | 0.7 / 4.34; 1.24 / 9.26 | missed | met | 99.3% / 106.9% |
| streaming-500 | memory | 1 | 1.25 / 1.89; 8.69 / 72.34 | 0.72 / 1.25; 6.33 / 55.39 | missed | missed | 5.1% / 4.6% |
| streaming-500 | redis | 1 | 3.4 / 4.94; 9.55 / 83.95 | 4.27 / 7.79; 10.56 / 90.29 | missed | missed | 6.1% / 5.4% |
| streaming-500 | memory | 10 | 0.59 / 1.24; 2.21 / 7.13 | 0.52 / 1.82; 2.05 / 7.71 | met | met | 19.6% / 15.9% |
| streaming-500 | redis | 10 | 2.87 / 6.33; 4.53 / 10.12 | 2.5 / 6.91; 4.07 / 10.31 | met | met | 23.4% / 17.5% |
| streaming-500 | memory | 16 | 0.53 / 1.32; 1.8 / 4.3 | 0.49 / 1.44; 1.78 / 6.37 | met | met | 29.1% / 21.9% |
| streaming-500 | redis | 16 | 2.82 / 7.35; 4.53 / 9.27 | 2.24 / 8.26; 3.68 / 10.69 | met | met | 32.6% / 23.4% |
| streaming-500 | memory | 64 | 0.17 / 0.87; 1.05 / 5.83 | 0.26 / 0.92; 1.3 / 8.28 | met | met | 49.8% / 52.4% |
| streaming-500 | redis | 64 | 1.91 / 5.09; 3.03 / 9.26 | 1.71 / 5.61; 2.87 / 11.75 | met | met | 52.5% / 57.6% |
| streaming-500 | memory | 100 | 0.12 / 0.48; 0.8 / 5.34 | 0.17 / 0.44; 0.95 / 5.46 | met | met | 57.1% / 64.2% |
| streaming-500 | redis | 100 | 1.6 / 4.25; 2.31 / 6.5 | 1.45 / 5.36; 2.08 / 10.15 | met | met | 55.9% / 63.6% |
| streaming-500 | memory | 256 | 0.06 / 0.34; 0.63 / 5.46 | 0.07 / 0.35; 0.5 / 6.96 | met | met | 74.1% / 77.1% |
| streaming-500 | redis | 256 | 1.24 / 9.32; 1.59 / 9.48 | 1.34 / 4.82; 1.86 / 11.28 | met | met | 71.9% / 80% |
| streaming-500 | memory | 500 | 0.06 / 0.15; 10.69 / 20.22 | 0.06 / 0.2; 12.99 / 22.47 | missed | missed | 108.9% / 109.3% |
| streaming-500 | redis | 500 | 4.82 / 12.2; 16.37 / 29.46 | 6.5 / 14; 21.54 / 33.62 | missed | missed | 110.1% / 109.7% |
| body-150kb | memory | 1 | 18.88 / 28.85; 24.63 / 40.09 | 4.11 / 7.44; 9.37 / 15.09 | missed | missed | 7.9% / 5% |
| body-150kb | redis | 1 | 21.4 / 29.89; 26.07 / 41.67 | 6.22 / 10.4; 10.48 / 24.97 | missed | missed | 8.8% / 5% |
| body-150kb | memory | 10 | 11.35 / 20.42; 18.78 / 41.17 | 3.57 / 8.83; 5.9 / 16.41 | missed | missed | 28% / 20.2% |
| body-150kb | redis | 10 | 12.55 / 32.35; 15.29 / 37.91 | 5.62 / 11.71; 8.16 / 16.74 | missed | missed | 29.2% / 21.4% |
| body-150kb | memory | 16 | 9.45 / 20.14; 11.65 / 25.72 | 3.46 / 7.98; 5.75 / 15.51 | missed | missed | 37.9% / 29.4% |
| body-150kb | redis | 16 | 12.46 / 43.32; 17.62 / 52.62 | 6.45 / 19.05; 10.45 / 48.05 | missed | missed | 35.9% / 30.2% |
| body-150kb | memory | 64 | 4.45 / 7.93; 7.36 / 29.28 | 1.71 / 4.01; 2.81 / 12.4 | missed | met | 64% / 57% |
| body-150kb | redis | 64 | 5.89 / 26.13; 11.78 / 43.78 | 2.99 / 10.85; 4.64 / 24.62 | missed | met | 61.8% / 54% |
| body-150kb | memory | 100 | 4.33 / 5.67; 12.34 / 33.46 | 1.21 / 2.26; 2.03 / 9.08 | missed | met | 90.5% / 63.8% |
| body-150kb | redis | 100 | 10.37 / 37.95; 25.55 / 89.8 | 2.39 / 7.71; 3.57 / 11.31 | missed | met | 92.3% / 63.8% |
| body-150kb | memory | 256 | 4.32 / 6.48; 2236.41 / 3587.34 | 1.08 / 3.03; 11.19 / 44.38 | missed | missed | 111.6% / 116.9% |
| body-150kb | redis | 256 | 387.16 / 1077.24; 2849.22 / 5470.94 | 6.45 / 25.2; 19.4 / 64.9 | missed | missed | 99.3% / 107.4% |
| body-150kb | memory | 500 | 4.28 / 6.44; 12750.03 / 22074.71 | 1.05 / 3.58; 1988.55 / 4444.03 | missed | missed | 109.4% / 110.6% |
| body-150kb | redis | 500 | 559.92 / 1099.31; 4051.31 / 20802.69 | 223.98 / 556.88; 4106.65 / 9152.51 | missed | missed | 110.1% / 94.1% |

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
# without TOKENYARD_EXPORT_SALT or --salt-file, --anonymize uses a fresh random salt, never stored
node bin/tokenyard.mjs traces export --since 30d --trace-dir .live/traces --anonymize --out examples/live/live.ndjson.gz
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
