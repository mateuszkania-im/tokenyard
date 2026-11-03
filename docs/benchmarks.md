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
- **Soak (V2).** `npm run soak -- memory` (one gateway on the memory store) and `npm run soak -- redis` (two gateways sharing one Redis, from `REDIS_URL` or a throwaway container as above) each run 45 minutes and write their own row under `soak` in `bench/results.json`; `npm run bench` keeps that section. Then `node scripts/bench-to-readme.mjs --write README.md`. `SOAK_MINUTES` and `SOAK_RATE` (requests per second per gateway, default 80) change the run; a run shorter than 15 minutes cannot pass the memory checks. Not part of `npm test`.
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

### Soak (`bench/soak.ts`)

A leak hunt rather than a latency benchmark: the shipped bundle (`bin/tokenyard.mjs serve --policy <dir> --trace-dir <dir>`, ops listener on) under a moderate, mixed load for 45 minutes, sampled every 30 s.

- **Load.** Open loop, Poisson arrivals, 80 requests per second per gateway: about 45% of a core on this mix (a trial at 100 per second used about 54%, so one gateway saturates near 185 per second), the 30 to 50% of the sustainable rate V2 asks for. The mix: Claude Code main turns (streaming, growing cached context, Opus and Sonnet), subagents, auxiliary and compaction calls, Codex Responses (streaming and not), product traffic with an email address (PII redaction), client aborts 0 to 200 ms after the first byte, secrets in the last turn (blocked, session tainted), refused models, hostile attribution headers (every header the gateway reads, up to 900 characters of quotes, backslashes, braces, percent signs, tabs and Latin-1, new on every request), unpriced model names, upstream 500, 529, mid-stream errors and dropped connections. On top: every minute the noisy key opens 12 slow streams (limit 8) and later sends 160 quick requests six at a time (burst 100, 10 per second); every two minutes 24 requests with a 1.1 MB body and `max_tokens` 128,000 on Opus (about $10.6 reserved each) go at once on one session, three from each of eight keys, under the enforced $200 session budget, so some are refused. Every budget level is enforced. The client records which of tokenyard's refusals each 4xx was (budget, rate, concurrent requests, secret, model) from its error message.
- **Session ids.** Each distinct session id keeps counter state until it has been idle for `sessions.idleTtlHours` (24 h by default; 30 days before S-V2-1): the session budget level, the session marker, and a taint set after a secret. With endless new ids that state grows for the whole run and would hide a leak, so new sessions cycle through a fixed set of ids per key and pool (12; Claude Code and Codex sessions are separate pools), the hostile session values through 300 and the secret sessions through 100. The state levels off after about 15 minutes, not within the warm-up: in the last Redis run 3,175 keys at 5 minutes, 3,682 at 15 and between 3,647 and 3,684 from then on. The Redis key check bounds it by what the load sent. Because a session id then collects spend for the whole run, the session budget is $200 rather than the example's $25 (with $25, a third of the requests were refused after half an hour of a first run, which thinned the load; that run is not kept). The per-session cost is reported separately (Redis keys and bytes per key below).
- **Probe.** `bench/soak-probe.mjs` is preloaded with `node --expose-gc --import` (the bundle is unchanged, no debug endpoint ships). On each sample it reports the event loop delay since the previous sample (beyond the monitor's 10 ms tick), then RSS and heap used right after a full GC, and active handles; it adds no exception or rejection handler (only `uncaughtExceptionMonitor`), so a crash still crashes. CPU excludes the probe's own GCs. `lsof` counts open descriptors and TCP sockets; `/metrics` gives the series count (a histogram counts once per label set), open reservations, swept reservations and dropped trace records; the trace directory gives files, bytes and hours; Redis gives keys by class (`SCAN`) and `used_memory`.
- **Phases.** 20 s priming at a tenth of the rate, 10 s idle, the idle "before" sample; 45 minutes of load; drain; the stream slot check; 40 s idle (past a sweeper tick, the R11 latch re-read and every keep-alive timeout); the idle "after" sample; the Redis checks; SIGTERM and the exit code.

**Thresholds, fixed before the runs** (`SOAK_THRESHOLDS` in `bench/soak-lib.ts`, tested in `test/bench/soak.test.ts`):

| Check | Passes when |
|---|---|
| RSS, and heap used after a full GC | after a 5 minute warm-up, both the least-squares trend over the rest of the run (projected over it) and the last 5 minutes against the first 5 stay under 10% |
| Open descriptors during the load | trend over the measured span under 16 |
| Open descriptors, TCP sockets, active handles | idle after the run at most 16, 8 and 16 above idle before it |
| Metric series | at most 10 new after warm-up, under 1,000 in all |
| Event loop delay | p99 under 100 ms in every sample after warm-up |
| Client latency | p50 of the auxiliary (small, non-streaming) requests in the last 5 minutes within 25% of the first 5 after warm-up |
| Reservations | none open after the load on any gateway, and none settled by the sweeper during the run |
| Stream slots | after the load every one of the 40 developer keys admits its full limit of 8 concurrent requests at once, and a ninth is refused |
| Redis | no reservation, deadline or open stream count left, nothing reserved on any budget key, and each key class at most what the load could create (session levels at most the session ids sent, window levels per key, team and tenant, one rate and one stream counter per key, one taint set per secret session, no R11 latch) |
| Process health | no crash, exit 0 on SIGTERM, no uncaught exception, no stderr line besides the startup notices |
| Traces | no record dropped |
| Client socket errors | none outside the deliberate aborts and upstream faults |

**Results.** The README's Soak table renders `soak` in `bench/results.json`; every check, its threshold and its measured value are in `soak.runs[].verdicts`, and a sample every 5 minutes in `perGateway[].every5min`.

- **Memory store, one gateway** (45 minutes from 09:00 UTC, harness at `07fd573`): 224,305 requests (83.1 per second with the bursts), gateway CPU 47.1% on average; all 14 checks passed. RSS after warm-up 124.53 MB in the first 5 minutes and 116.64 MB in the last 5 (trend -4.02%); heap used after a full GC 29.04 and 29.61 MB (trend 1.96%, 0.88 MB per hour). Open descriptors 58 to 97 under load and 10 idle before and after; TCP sockets 3 and 3; handles 5 and 5. 67 metric series after warm-up and at the end, although every hostile request carried new values on every attribution header. Event loop delay p99 at most 5.33 ms. No reservation left open or swept, no trace record dropped, exit 0 on SIGTERM, no stray stderr line. After the load all 40 keys admitted 8 requests at once and refused a ninth. Traces rotated into a new hourly file per tenant (two hours per instance), about 458 MB per hour of load. The refusals in the mix: 133 budget (heavy bursts), 1,965 rate and 176 concurrent-request (noisy key), 4,563 secret and 8,941 model.
- **Redis store, two gateways sharing one Redis, after S-V2-1** (45 minutes from 13:52 UTC, gateway and harness at `44e3563`, Redis 7.4.12 in a local container): 439,960 requests (163 per second, alternating between the two gateways), gateway CPU 31.5% and 30.5%; 27 of 29 checks passed. Failed: RSS on both gateways, 114.32 to 139.34 MB and 114.51 to 138.3 MB (first and last 5 minutes after warm-up; trend 26.91% and 29.33%). The rise is one step at about 26 minutes, at the same sample in both gateways and in the mock provider (a separate process whose code and load did not change: about 100 MB before, about 145 MB after), and RSS then moves between 126 and 151 MB without a trend; in the same run heap used after a full GC went from 30.54 to 31.07 MB and from 30.59 to 31.05 MB (trend 1.79% and 1.61%) and external memory stayed between 6 and 13 MB. A step shared by three unrelated processes points at the operating system's memory management (macOS compresses and pages out memory under pressure, and RSS counts it again once it is touched), not at the gateway; this is an explanation, not a measurement, and the check stays failed in `bench/results.json`. In the two passing Redis runs before the fix RSS fell over the run (for example 112.39 to 104.13 MB). Everything else passed: open descriptors 11 idle before and after on both, TCP sockets 4 and 4, handles 6 and 6; 67 and 68 metric series; event loop delay p99 at most 5.38 ms; no reservation open or swept; no trace record dropped. Redis held 4,228 keys after the load (1,889 session budget levels, 2,089 session markers, 201 taint sets, 48 window levels, the sweep lock), within what the load could create, at 2.28 MB of `used_memory` (about 170 bytes per key); no reservation, deadline or open stream count was left, nothing was reserved, and on all 1,937 enforced budget keys spent was within the limit after settlements from both processes. Across the two processes: the heavy bursts, alternating between gateways on one session, got 165 budget refusals with no key over its limit; every key's concurrent request limit of 8 held across both gateways after the load (320 of 320 admitted, 40 of 40 extra refused); and a secret sent through one gateway tainted the session on the other (the clean follow-up through the second gateway was refused with the taint answer). The R11 latch across processes is not exercised by the soak; `test/security/a9-r11-latch-scope.test.ts` covers it in `npm run test:redis`. The run's trace files are kept (a failed run keeps them).
- **The Redis run before S-V2-1** (45 minutes from 12:30 UTC, harness at `7ef3ca7`): 439,968 requests (163 per second, alternating between the two gateways), gateway CPU 33.2% and 34.3%; all 27 checks passed. Per gateway: RSS after warm-up 112.39 to 104.13 MB and 111.35 to 104.71 MB (first and last 5 minutes); heap used after a full GC 30.49 to 31.1 MB and 30.46 to 31.14 MB (trend 2.32% and 2.46%, about 1.1 MB per hour); open descriptors 11 idle before and after on both, TCP sockets 4 and 4, handles 6 and 6; 69 metric series each; event loop delay p99 at most 14.76 ms. Redis held 2,137 keys after the load (1,888 session budget levels, 200 taint sets, 48 window levels, the sweep lock), within what the load could create, at 1.97 MB of `used_memory` (about 175 bytes per key); no reservation, deadline or open stream count was left and nothing was reserved on any budget key. The heavy bursts, alternating between gateways on one session, got 165 budget refusals, and every key's concurrent request limit of 8 held across both gateways after the load (320 of 320 admitted, 40 of 40 extra refused). That run did not yet read spent on each budget key or check taint across gateways.
- **An earlier Redis run (harness at `4d32cf0`) failed one check:** 4 `ECONNRESET` on the 1.1 MB heavy requests (out of 528), sent on pooled keep-alive connections; everything else in that run passed, including no open or swept reservation, a clean Redis and a clean stderr on both gateways. The cause is not known. The gateway destroys a client socket only after a fault once the answer has started (handler.ts, the internal error path, which also writes a trace line), never while reading a body under the 32 MiB cap; and two experiments did not reproduce it: a 1.1 MB request on a pooled socket after 3.8 to 5.3 s idle (61 tries) and 31 bursts of 24 concurrent 1.1 MB requests on one pool with 4.7 to 5.3 s pauses (744 requests) succeeded every time, against a plain Node server and against the gateway alike. The rerun above sent those requests on new connections (`7ef3ca7`) and had none; the harness is back on the pool (`22bd69a`) and labels a reset on a reused socket, so the next run shows whether it is the keep-alive race. A run before that (`fb17f22`) failed the key bound check because the harness counted session ids rather than (tenant, session) pairs, which is what counter keys are; and the first memory run was replaced because its $25 session budget refused a third of the load after half an hour.

**Leaks found and fixed.**

- `TraceWriter` remembered every trace file it had opened, one entry per tenant and hour for the life of the process. It now forgets files older than the previous hour (`d34cfe6`; RED: 144 entries after 72 hours of two tenants, GREEN: at most 4).
- `tokenyard mock` (the compose demo's provider) kept every request it received, body included, so its memory grew with every request; the prompt cache simulator kept expired entries; the OpenAI mock kept one prompt cache entry per `prompt_cache_key` forever. The CLI mock now keeps no requests, expired cache entries are dropped once a minute, and the OpenAI mock keeps the 10,000 most recently used cache keys (`61555f6`; RED: 5 of 5 requests kept with a cap of 2, 1,000 of 1,000 expired entries kept).
- None in the gateway's request path: heap after GC, descriptors, sockets, handles, series, reservations and slots stayed within the stated thresholds in every 45 minute run (heap at most 2.46% over the 40 measured minutes, levelling off).
- S-V2-1 (below) is not a leak but unbounded state by design, fixed in `ba909f9`.

**Per-session counter state (S-V2-1, fixed in `ba909f9`).** Before the fix every distinct session id kept a session budget key for 30 days after its last admit, audit-mode levels included, so an authenticated client sending a new id on every request grew the store at its rate limit for a month: at the example's 120 requests per minute up to 172,800 keys a day, about 5.2 million in 30 days, roughly 0.8 to 1 GB of Redis per such key (arithmetic from the measured 150 to 190 bytes per key, not measured). Now session keys expire `sessions.idleTtlHours` (default 24) after their last admit, and one key may start at most `sessions.newPerKeyPerHour` (default 1,000; service keys `sessions.newPerServiceKeyPerHour`, default 10,000; or the key's own `maxNewSessionsPerHour`) new sessions an hour, a GCRA checked inside admit before anything is written; over it the request gets a 429 `session-churn` with `x-should-retry: false`. Each admitted session costs a marker and a session budget level (about 170 bytes each in the last Redis run), so one key can hold at most about 1,000 times 24 sessions at once: about 48,000 keys, roughly 8 MB of Redis, at the defaults (arithmetic). `test/security/s-v2-1-session-churn.test.ts` sends a new session id on every request through the gateway, on the memory store and on Redis: past the allowance every request is refused and the key count does not move over a thousand more, while another key with three sessions is unaffected.

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
