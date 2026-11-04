# Benchmarks

Every number in the [Measured](#measured) section below comes from one run of `npm run bench`, which writes `bench/results.json`; `node scripts/bench-to-readme.mjs --write docs/benchmarks.md` renders that file into the block between the `BENCH:START` and `BENCH:END` markers, and `npm run bench:check` (CI) fails when the block differs from what the results render to. Nothing in the block is typed by hand. The numbers in [Real sessions](real-sessions.md) come from `examples/live/` (below), and a test (`test/docs/readme.test.ts`) fails when a number in the hand-written parts of the Measured section, [Real sessions](real-sessions.md) and [Budgets](budgets.md) appears in neither `bench/results.json` nor `examples/live/`.

## Measured

Every number below is produced by `npm run bench` into `bench/results.json` and copied into this block by a script; CI fails when the block and the results differ. [Reproduce](#reproduce) and [What each benchmark measures](#what-each-benchmark-measures) below have the commands to reproduce each one and what each measures. Every request goes to the local mock provider, so the absolute times say how the gateway behaves on this machine and nothing about a real provider.

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

How to read it. With one gateway process the added TTFB targets are met for small non-streaming requests at every SLO level on the memory store and at 10 and 100 streams on Redis, and for streaming 500 tokens at 10 and 100 streams on both stores. The misses at the SLO levels are listed row by row at the end of the overhead tables above. At 500 streams one process saturates a core: streaming passes every chunk through one event loop (the mock streams many times faster than a real provider), so requests queue before it handles them, and with Redis each admit reply also waits a full event-loop pass ([below](#why-the-redis-store-misses-the-added-ttfb-target-at-500-streams-measured-2026-11-04)). In the single-process 150 KB row at 500 streams the load generator and the mock saturated too (the direct path's own TTFB outside the provider is above a second), so that row is an upper bound on the machine, not on the gateway alone. The 150 KB body also misses at 10 streams on Redis and at 100 streams on the client-side p99. The multi-worker table (`serve --workers`) puts the mock and the load generator in several processes, so the direct path stays fast, and runs the gateway as 1 to 4 processes: small non-streaming requests at 500 streams on Redis meet the targets with 2 and with 4 processes; streaming at 500 streams does not with any count in this run, and the 150 KB body goes from seconds to tens of milliseconds on the client side but still misses. On this laptop the gateway, the mock, the load generator, Redis and the desktop share the cores, and adding a fourth gateway process made the rows worse; [With several gateway processes](#with-several-gateway-processes-serve---workers-measured-2026-11-04) below has the numbers and the development runs in which streaming at 500 streams met the targets with 2 and 3 processes. The Redis rows run against a container behind Docker Desktop's network on macOS. Streaming totals vary from run to run by more than the gateway adds. The cache row shows that the naive proxy's damage depends on where the breakpoints are: on this session the flattened system block costs almost nothing, and conformance test C15b still fails it on the changed usage.

## Reproduce

```sh
npm ci
npm run bench                                   # writes bench/results.json
node scripts/bench-to-readme.mjs --write docs/benchmarks.md
npm run bench:check
```

- **Hardware and versions.** `bench/results.json` records the CPU, core count, memory, OS, Node, tsx and Redis versions and the commit it ran at (the soak: the commit at its start, dirty when the benchmark inputs had uncommitted changes at its start or end or HEAD moved during the run); the Measured block prints them on its first line. The committed results were measured on an Apple M2 Pro laptop (12 cores, 16 GB) on Node 22.14. Expect different absolute numbers on other machines; the comparisons between direct and gateway paths and between stores are what carry over.
- **Redis.** The overhead and budget benchmarks run on both stores. With `REDIS_URL` unset, the runner starts a throwaway Redis container (`redis:7`, published on a random 127.0.0.1 port with a random password, removed at the end; `scripts/local-redis.mjs`). With `REDIS_URL` set it uses that server, but only a loopback one, because the budget benchmark flushes it (`BENCH_ALLOW_FLUSH=1` overrides). Without Docker and without `REDIS_URL`, the Redis rows say "not measured".
- **No real provider is called.** Every request goes to the deterministic mock provider (`src/mock/`) on loopback, and the gateway's provider key is a placeholder.
- **Soak (V2).** `npm run soak -- memory` (one gateway on the memory store) and `npm run soak -- redis` (two gateways sharing one Redis, from `REDIS_URL` or a throwaway container as above) each run 45 minutes and write their own row under `soak` in `bench/results.json`; `npm run bench` keeps that section. Then `node scripts/bench-to-readme.mjs --write docs/benchmarks.md`. `SOAK_MINUTES` and `SOAK_RATE` (requests per second per gateway, default 80) change the run; a run shorter than 15 minutes cannot pass the memory checks. Not part of `npm test`.
- **Development runs.** `BENCH_QUICK=1 npm run bench` shortens the overhead runs; its results are not for committing. `BENCH_SCENARIOS` (`non-streaming`, `streaming-500`, `body-150kb`, comma-separated) and `BENCH_CONCURRENCY` (for example `10,100`) narrow the overhead benchmark when it runs alone: `npx tsx bench/overhead.ts`. With `BENCH_WORKERS` (for example `1,3`) and `REDIS_URL` set it runs only the multi-worker rows, with `BENCH_MOCK_PROCS` and `BENCH_LOAD_PROCS` (default 3 each) mock and load processes: `BENCH_WORKERS=1,3 node scripts/local-redis.mjs npx tsx bench/overhead.ts`.

## What each benchmark measures

### Gateway overhead (`bench/overhead.ts`)

Three scenarios: a non-streaming request with a small body, a streaming request with a 500-token answer, and a streaming request with a 150 KB body (a long agent context). Each runs at 1, 10, 16, 64, 100, 256 and 500 streams (10, 100 and 500 are the levels the SLO rows use), on the memory store and on the Redis store. The mock and the gateway each run in their own child process, so the gateway's CPU and RSS are its own; the load generator runs in the benchmark process.

- **Load.** Open loop: each stream is one keep-alive connection opened before the run, with its own evenly spaced send schedule (5 requests per second non-streaming, 1.25 streaming) starting at a seeded random phase, so connections do not fire together. A request still running at its next scheduled time delays the next one, and client-side latency counts from the scheduled time, so coordinated omission is included rather than hidden.
- **Mock.** A fixed 100 ms time to first token, then 500 tokens at 2,000 tokens per second.
- **Added TTFB (gateway-measured).** The gateway's own per-request measure from its traces (`addedTtfbMs`, from the start of request handling to forwarding upstream, with a sub-millisecond clock in the benchmark). It is paired per request by construction. It does not include time a request waits before the gateway starts handling it, nor the response path.
- **Client-side TTFB outside the provider.** Each request's client-side TTFB minus the mock's own wait for that request (the `x-mock-wait-ms` response header), paired per request so the mock's timer jitter drops out. Direct and through-the-gateway values are shown side by side as absolute percentiles and never subtracted from each other.
- **SLO verdict.** An added TTFB row is met only when both the gateway-measured value and the client-side TTFB outside the provider through the gateway are under the target. The client-side value is an upper bound on what the gateway adds and includes queueing before handling, which the gateway's own measure cannot see. The SLO table uses the 10, 100 and 500 stream rows (about 2,200 scheduled requests each); the table of every level in Measured applies the same rule to each row (`addedTtfbMet` in `bench/results.json`), with its own n, which is about 300 at 1, 16, 64 and 256 streams.
- **Throughput.** Answered (2xx) requests per second and output tokens per second of each run, for both paths, from the run's first scheduled send to its last answer. Direct, every answer carries the mock's fixed 500 output tokens; through the gateway, the output tokens are the ones its traces settled, so the two columns also cross-check the gateway's usage accounting. The load is open loop at a fixed rate per stream, so throughput follows the offered load (streams times rate) until a path saturates; then the run drains past its window and throughput falls below the offered load.
- **CPU and RSS.** CPU is the gateway process's user plus system time over the run's wall time (100% is one core). RSS growth is the peak during the run above the size just before it. "Per 100 streams" is the slope between 100 and 500 streams, flagged when the gateway could not keep up at 500: a full core, fewer than 90% of the offered requests answered per second, or a drain more than 20% past the window (`saturated` per row in `bench/results.json`).
- **Gateway configuration.** `examples/policy` with every budget level enforced at a limit the load never reaches, no rate limits, guardrails on, traces written and metrics kept.
- **n** is the number of samples behind each percentile; errors count non-2xx answers and socket errors; scheduled requests that could not be sent within the drain time are listed as dropped in `bench/results.json`.

**Several gateway processes (`serve --workers`).** The 500-stream rows run again on the Redis store with the bench gateway as 1, 2, 3 and 4 processes sharing one port through `node:cluster`, as `tokenyard serve --workers` runs it: a primary that serves no traffic hands each connection to a worker in turn (round robin), and every worker builds the same gateway as the single-process child, with its own instance id, trace writer and Redis connection. For these rows the harness is several processes too, because in the single-process rows the mock (about 93% CPU at 150 KB and 500 streams, sampled with `ps` on 2026-11-04) and the load generator saturate first: the mock runs as 3 processes on one port and the load generator as 3 processes, each opening its share of the connections before the run and starting at one moment given as an epoch time (`performance.timeOrigin` plus `performance.now()`), with every latency still taken within one process. The direct path runs through the same mock and load processes. Mock and load CPU are recorded per process for both paths (`mockCpuPct`, `loadCpuPct` in `overhead.workers.rows`), so a saturated harness would show in the results. Gateway CPU is the sum over the workers and the primary, `perProcessCpuPct` gives each worker, and a row is saturated when any one worker reaches 95%. The row with 1 process is the control: the same harness, one gateway process. The SLO table uses the rows with 3 processes; that count was chosen from development runs on this laptop before the committed run, and every count is in the table.

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

Before and after per overhead row: the "before" run is `node scripts/local-redis.mjs npx tsx bench/overhead.ts` in a worktree of 5ad6f31 on the same laptop in the same session; the "after" run is the committed `bench/results.json`. A row is met when the gateway-measured added TTFB and the client-side TTFB outside the provider are both under 5 ms p50 and 25 ms p99. Rows met: 19 of 42 before, 25 of 42 after; of the 18 SLO rows (10, 100 and 500 streams), 8 before and 11 after. Each side is one run, so only some flips are significant. Non-streaming at 500 streams (both stores) and the 150 KB body at 64 and 100 streams (both stores) changed far beyond run-to-run variance, as the profiles above explain. The other flips are not significant: the Redis non-streaming row at 10 streams (met before, missed after) sits near the 5 ms p50 target on both runs, the memory non-streaming row at 16 streams was missed before on one p99 outlier of 400 samples, and the Redis 150 KB row at 64 streams is met after at 24.62 ms against the 25 ms p99 target. Rows at 1 stream rest on 25 (streaming) or 100 (non-streaming) samples and are labelled low n in Measured; their percentiles, p99 above all, are not comparable with the SLO rows.

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

### Why the Redis store misses the added-TTFB target at 500 streams (measured 2026-11-04)

The missed rows at 500 concurrent streams are a saturated process, not extra work on the Redis path. Timings from an instrumented copy of the request path, after the soak, on the machine in Measured:

- At 500 streams with 150 KB bodies the gateway runs at 95 to 108% CPU and one event-loop pass takes about 65 ms, most of it other requests' body scans. Admit waits 189 ms p50 / 506 ms p99: node-redis holds every write until the end of the current pass (`setImmediate`), 67 ms p50 before the command is even sent, and the reply then waits for the next pass.
- The memory store looks fine on this row only because its admit is synchronous, so the wait happens before the gateway starts timing the request. By the bench's own verdict (gateway and client-side measures both under target) memory misses the same rows: client-side p50 about 2 s at 150 KB / 500.
- Ruled out by measurement: extra Redis round trips (exactly two per request, admit before and settle after the response), argument serialisation (0.07 to 0.26 ms), the scan before admit (about 1 ms; admit needs its taint hashes, so it cannot overlap), and a single shared connection (replies already pipeline; the wait is the event-loop pass).
- A node-redis copy patched to write immediately cut added TTFB to 71 / 386 ms at 150 KB / 500, still far over target, so it was not adopted: any async store pays one event-loop pass under saturation.
- At 10 streams the borderline 150 KB row is about 2.3 ms of scan plus about 2 ms of Docker Desktop networking waking up after idle gaps (a Redis PING is 0.26 ms back to back, 1.3 to 2.4 ms after an idle gap); the Lua script itself runs 135 to 217 microseconds inside Redis.

Meeting the target at 500 streams needs less CPU per event-loop pass on the main thread: more gateway instances behind the shared Redis (see [Running several instances](scaling.md)), or moving the secret scan of large bodies to worker threads. The 45-minute soak with two gateways on one Redis passes every check at 80 requests per second per gateway.

### With several gateway processes (`serve --workers`, measured 2026-11-04)

`tokenyard serve --workers <n>` was added for this, and the overhead benchmark measures it (the multi-worker rows in the Measured block, `overhead.workers` in `bench/results.json`). The committed run, with the gateway-measured added TTFB and the client-side TTFB outside the provider, p50 / p99 in ms, at 500 streams on Redis (the mock and the load generator in 3 processes each, so the direct path stays at 0.11 / 8.4 ms or better):

| Scenario | 1 process (control) | 2 processes | 3 processes (SLO row) | 4 processes |
|---|---|---|---|---|
| Non-streaming | 0.71 / 78.28; 1.36 / 218.99, missed | 0.63 / 3.98; 0.93 / 8.6, met | 0.76 / 12.28; 1.14 / 34.33, missed | 0.93 / 10.07; 1.48 / 21.82, met |
| Streaming, 500 tokens | 5.76 / 19.11; 16.95 / 42.91, missed | 2.15 / 16.33; 5.76 / 37.58, missed | 5.56 / 76.48; 26.18 / 128.23, missed | 19.48 / 112.3; 72.84 / 235.65, missed |
| Streaming, 150 KB body | 188.37 / 499.46; 1,413.79 / 3,596.34, missed | 10.83 / 79.31; 38.23 / 189.77, missed | 5.83 / 38.87; 18.09 / 98.03, missed | 23.98 / 215.4; 201.02 / 1,008.74, missed |

What this shows, and what it does not:

- **More processes remove the single-process wall.** The 150 KB row goes from 188 / 499 ms added TTFB with one process to 5.83 / 38.87 ms with three, and the client-side p50 from 1.4 s to 18 ms; small non-streaming requests meet the target from 2 processes. The mechanism the section above names is confirmed: with the scan and forwarding spread over processes, a Redis reply no longer waits behind a 65 ms event-loop pass.
- **On this laptop the target is not met reliably at 500 streams for streaming.** Neither streaming row meets it with any process count in the committed run. In three development runs the same harness met the streaming 500-token row with 3 processes every time (best 1.26 / 5.72 ms gateway-measured, 2.06 / 11.27 ms client-side) and with 2 processes in all three (worst client-side p99 21.07 ms); the committed run did not. The 150 KB row was missed in every run with every count; its best result in any run was 4.61 / 16.97 ms gateway-measured (met) with 12.18 / 41.96 ms client-side (missed), with 3 processes.
- **Why: the machine, not one event loop.** At 150 KB and 625 requests per second the gateway needs about 3.7 cores (373.5% with 3 processes, each worker at 119 to 130%, the main thread full plus GC threads) and the harness about 2.6 more (mock 3 × 55 to 59%, load 3 × 31%), beside Redis in Docker Desktop's VM and the laptop's own load (load average about 7 with the benchmark stopped: browser, editors and other containers). That is close to the 8 performance cores of the M2 Pro; a fourth process makes it worse, not better (4 processes at 70 to 75% CPU each, none saturated, and 24 / 215 ms), which is processes waiting for a core rather than for their own loop. CPU per 150 KB request also rises as processes are added: about 2.4 ms in one saturated process (114.7% for 467 answered per second), about 6 ms in three (373.5% for 604 per second), because a busy loop batches socket reads and writes that an idle one handles one chunk at a time.
- **Run-to-run variance at 500 streams is larger than the targets.** The first full run of the day (not kept: its multi-worker rows ran last, after 35 minutes of load, with macOS throttling, `kernel_task` at 73% CPU) gave 3 processes 1.06 / 32.91 ms on non-streaming and 17.01 / 166.51 ms on streaming 500 tokens; the multi-worker rows now run before the single-process sweep. Each row is one 10 s window, about 6,250 requests streaming and 25,000 non-streaming, so its p99 rests on 60 to 250 samples.

So `--workers` is the right remedy and moves the 500-stream rows by one to two orders of magnitude, but this benchmark on one laptop that also runs the mock, the load generator and Redis cannot show the SLO met at 500 streams for streaming. A fair test needs the gateway on its own machine (or cores) with the load generator, the mock and Redis elsewhere; that has not been run.

### Budget correctness (`bench/budget.ts`)

The G4 scenario of the design spec (section 7.4) through the whole gateway: 1,000 requests, each on its own connection opened beforehand, sent at the same moment against one enforced $1 budget, with each actual cost drawn (seeded) between 0 and that request's limits by the mock. Run on both stores and both estimators. It records how many admit calls the store decided before the first settle, the most open reservations, admitted and rejected counts, final spend, the highest spent plus reserved after any admit, the largest overspend, final spend minus the sum of settled costs (lost updates) and the reservation left at the end.

The concurrency trade-off rows send 40 copies of one 150,000-byte turn with `max_tokens` 32,000 on Opus 5.5 at once in one session under an enforced $25 session budget, while the mock holds every stream open, and count how many were admitted in flight with each estimator.

The unit form of the proof (`test/limits/budget-proof.test.ts`) runs in `npm test` on the memory store and in `npm run test:redis` on Redis.

### Cache economics (`bench/cache.ts`)

The 40-turn Claude Code shaped session of conformance test C15, sent straight to the mock, through tokenyard, and through a deliberately naive proxy that flattens `system` into a string (`test/helpers/`), each priced at Opus 5.5 list prices from `examples/policy/prices.yaml`. The mock simulates prompt caching from `cache_control` breakpoints. The cache hit ratio is cache reads over all input tokens (input, cache reads and cache writes).

### Secret scan (`bench/scan.ts`)

Throughput of the last-turn scan (every rule) and the full-body scan on a synthetic coding-agent body of about 4 MiB (source-like text in tool results), and block hits on the false-positive corpus: real source trees and lockfiles sent as tool results. The corpus is assembled from this repository and the sibling projects listed in `test/fixtures/fp-corpus/README.md`, so its file count depends on which of them are checked out next to this one. Alone: `npx tsx bench/scan.ts [megabytes]`.

### Replay throughput (`bench/replay.ts`)

1,000,000 synthetic trace records: the committed demo week (`examples/traces/demo.ndjson.gz`) repeated week after week with fresh ids and sessions, written as one gzipped export. The timed part is what `tokenyard policy replay` does with such a file: read, parse, simulate the base and the head policy, with the fidelity check. Alone: `npx tsx bench/replay.ts [records]`. The SLO says "on a CI runner"; the committed number is from the laptop above, and the Measured block says so.

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
| RSS, and heap used after a full GC (the committed runs) | after a 5 minute warm-up, both the least-squares trend over the rest of the run (projected over it) and the last 5 minutes against the first 5 stay under 10% |
| From the next run: heap used after a full GC plus external memory (the primary memory check) | the same trend and window rule, under 10% (`memoryGrowthPct`) |
| From the next run: RSS beyond a control process | the gateway's RSS minus the mock provider's RSS at the same samples: trend and last 5 minutes against first 5, each under 10% of the gateway's mean RSS (`rssBeyondControlPct`); no control samples is a failure |
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

**Memory criteria changed for the next run (V2 follow-up).** The Redis rerun after S-V2-1 failed RSS on both gateways while heap and external memory were flat, because RSS on this macOS laptop moved with system memory pressure for every process at once (the mock provider stepped at the same sample). From the next run the primary memory check is heap used after a full GC plus external memory, and RSS is judged against the mock provider as a control process sampled at the same moments. Both are in `SOAK_THRESHOLDS` and `judge()` now, with failing-signal tests (`test/bench/soak.test.ts`: a heap leak and a Buffer leak fail the primary check; an RSS step in the gateway alone fails, the same step in the control does not; no control samples fails). The Redis row was judged with the earlier criteria and is not re-judged; the memory-store row was rerun with the new criteria in V5 (below). In the Soak table a cell judged with the new criteria says so: "minus control" for RSS beyond the control process, "plus external" for heap after GC plus external memory.

**Results.** The Soak table in Measured renders `soak` in `bench/results.json`; every check, its threshold and its measured value are in `soak.runs[].verdicts`, and a sample every 5 minutes in `perGateway[].every5min`.

- **Memory store, one gateway, new memory criteria (V5)** (45 minutes from 18:21 UTC on 2026-11-03, gateway bundle and harness of `6d47066`; the results carry the commit at the end of the run, `7da19cb`, whose changes since then touch tests, scripts, the CLI version import and the policy loader's error count, none of them on the soak's path; its `dirty: false` is that end-of-run reading, and the published memory soak ran on the `6d47066` gateway bundle. The harness now records the commit at the start and marks a run dirty when HEAD moved during it, `bench/lib.ts` `runGit`): 224,306 requests (83.1 per second with the bursts), gateway CPU 40.5% on average; all 15 checks passed. Heap used after a full GC plus external memory 44.33 MB in the first 5 minutes after warm-up and 41.35 MB in the last 5 (trend -1.26%, -0.84 MB per hour). RSS beyond the control process (the gateway's RSS minus the mock provider's at the same samples) 11.34 MB and 14.29 MB (trend 3.81%, windows 1.81% of the gateway's mean RSS of 162.98 MB); the gateway's own RSS moved between about 150 and 200 MB without a trend, the mock's from 140 to 117 MB. Open descriptors 58 to 122 under load (trend 3.8) and 10 idle before and after; TCP sockets 3 and 3; handles 5 and 5. 67 metric series after warm-up, 68 at the end. Event loop delay p99 at most 2.19 ms. No reservation left open or swept, no trace record dropped, exit 0 on SIGTERM, no stray stderr line; client total time p50 of the auxiliary requests 81.52 to 81.39 ms. After the load all 40 keys admitted 8 requests at once and refused a ninth, and the session taint held. Traces about 472 MB per hour of load. The refusals in the mix: 129 budget (heavy bursts), 1,979 rate and 176 concurrent-request (noisy key), 4,681 secret and 8,982 model.
- **Memory store, one gateway, earlier criteria** (45 minutes from 09:00 UTC, harness at `07fd573`; replaced in `bench/results.json` by the run above): 224,305 requests (83.1 per second with the bursts), gateway CPU 47.1% on average; all 14 checks passed. RSS after warm-up 124.53 MB in the first 5 minutes and 116.64 MB in the last 5 (trend -4.02%); heap used after a full GC 29.04 and 29.61 MB (trend 1.96%, 0.88 MB per hour). Open descriptors 58 to 97 under load and 10 idle before and after; TCP sockets 3 and 3; handles 5 and 5. 67 metric series after warm-up and at the end, although every hostile request carried new values on every attribution header. Event loop delay p99 at most 5.33 ms. No reservation left open or swept, no trace record dropped, exit 0 on SIGTERM, no stray stderr line. After the load all 40 keys admitted 8 requests at once and refused a ninth. Traces rotated into a new hourly file per tenant (two hours per instance), about 458 MB per hour of load. The refusals in the mix: 133 budget (heavy bursts), 1,965 rate and 176 concurrent-request (noisy key), 4,563 secret and 8,941 model.
- **Redis store, two gateways sharing one Redis, after S-V2-1** (45 minutes from 13:52 UTC, gateway and harness at `44e3563`, Redis 7.4.12 in a local container): 439,960 requests (163 per second, alternating between the two gateways), gateway CPU 31.5% and 30.5%; 27 of 29 checks passed. Failed: RSS on both gateways, 114.32 to 139.34 MB and 114.51 to 138.3 MB (first and last 5 minutes after warm-up; trend 26.91% and 29.33%). The rise is one step at about 26 minutes, at the same sample in both gateways and in the mock provider (a separate process whose code and load did not change: about 100 MB before, about 145 MB after), and RSS then moves between 126 and 151 MB without a trend; in the same run heap used after a full GC went from 30.54 to 31.07 MB and from 30.59 to 31.05 MB (trend 1.79% and 1.61%) and external memory stayed between 6 and 13 MB. A step shared by three unrelated processes points at the operating system's memory management (macOS compresses and pages out memory under pressure, and RSS counts it again once it is touched), not at the gateway; this is an explanation, not a measurement, and the check stays failed in `bench/results.json`. In the two passing Redis runs before the fix RSS fell over the run (for example 112.39 to 104.13 MB). Everything else passed: open descriptors 11 idle before and after on both, TCP sockets 4 and 4, handles 6 and 6; 67 and 68 metric series; event loop delay p99 at most 5.38 ms; no reservation open or swept; no trace record dropped. Redis held 4,228 keys after the load (1,889 session budget levels, 2,089 session markers, 201 taint sets, 48 window levels, the sweep lock), within what the load could create, at 2.28 MB of `used_memory` (about 170 bytes per key); no reservation, deadline or open stream count was left, nothing was reserved, and on all 1,937 enforced budget keys spent was within the limit after settlements from both processes. Across the two processes: the heavy bursts, alternating between gateways on one session, got 165 budget refusals with no key over its limit; every key's concurrent request limit of 8 held across both gateways after the load (320 of 320 admitted, 40 of 40 extra refused); and a secret sent through one gateway tainted the session on the other (the clean follow-up through the second gateway was refused with the taint answer). The R11 latch across processes is not exercised by the soak; `test/security/a9-r11-latch-scope.test.ts` covers it in `npm run test:redis`. The run's trace files are kept (a failed run keeps them).
- **The Redis run before S-V2-1** (45 minutes from 12:30 UTC, harness at `7ef3ca7`): 439,968 requests (163 per second, alternating between the two gateways), gateway CPU 33.2% and 34.3%; all 27 checks passed. Per gateway: RSS after warm-up 112.39 to 104.13 MB and 111.35 to 104.71 MB (first and last 5 minutes); heap used after a full GC 30.49 to 31.1 MB and 30.46 to 31.14 MB (trend 2.32% and 2.46%, about 1.1 MB per hour); open descriptors 11 idle before and after on both, TCP sockets 4 and 4, handles 6 and 6; 69 metric series each; event loop delay p99 at most 14.76 ms. Redis held 2,137 keys after the load (1,888 session budget levels, 200 taint sets, 48 window levels, the sweep lock), within what the load could create, at 1.97 MB of `used_memory` (about 175 bytes per key); no reservation, deadline or open stream count was left and nothing was reserved on any budget key. The heavy bursts, alternating between gateways on one session, got 165 budget refusals, and every key's concurrent request limit of 8 held across both gateways after the load (320 of 320 admitted, 40 of 40 extra refused). That run did not yet read spent on each budget key or check taint across gateways.
- **An earlier Redis run (harness at `4d32cf0`) failed one check:** 4 `ECONNRESET` on the 1.1 MB heavy requests (out of 528), sent on pooled keep-alive connections; everything else in that run passed, including no open or swept reservation, a clean Redis and a clean stderr on both gateways. The cause is not known. The gateway destroys a client socket only after a fault once the answer has started (handler.ts, the internal error path, which also writes a trace line), never while reading a body under the 32 MiB cap; and two experiments did not reproduce it: a 1.1 MB request on a pooled socket after 3.8 to 5.3 s idle (61 tries) and 31 bursts of 24 concurrent 1.1 MB requests on one pool with 4.7 to 5.3 s pauses (744 requests) succeeded every time, against a plain Node server and against the gateway alike. The rerun above sent those requests on new connections (`7ef3ca7`) and had none; the harness is back on the pool (`22bd69a`) and labels a reset on a reused socket, so the next run shows whether it is the keep-alive race. A run before that (`fb17f22`) failed the key bound check because the harness counted session ids rather than (tenant, session) pairs, which is what counter keys are; and the first memory run was replaced because its $25 session budget refused a third of the load after half an hour.

**Leaks found and fixed.**

- `TraceWriter` remembered every trace file it had opened, one entry per tenant and hour for the life of the process. It now forgets files older than the previous hour (`d34cfe6`; RED: 144 entries after 72 hours of two tenants, GREEN: at most 4).
- `tokenyard mock` (the compose demo's provider) kept every request it received, body included, so its memory grew with every request; the prompt cache simulator kept expired entries; the OpenAI mock kept one prompt cache entry per `prompt_cache_key` forever. The CLI mock now keeps no requests, expired cache entries are dropped once a minute, and the OpenAI mock keeps the 10,000 most recently used cache keys (`61555f6`; RED: 5 of 5 requests kept with a cap of 2, 1,000 of 1,000 expired entries kept).
- None in the gateway's request path: heap after GC, descriptors, sockets, handles, series, reservations and slots stayed within the stated thresholds in every 45 minute run (heap at most 2.46% over the 40 measured minutes, levelling off).
- S-V2-1 (below) is not a leak but unbounded state by design, fixed in `ba909f9`.

**Per-session counter state (S-V2-1, fixed in `ba909f9`).** Before the fix every distinct session id kept a session budget key for 30 days after its last admit, audit-mode levels included, so an authenticated client sending a new id on every request grew the store at its rate limit for a month: at the example's 120 requests per minute up to 172,800 keys a day, about 5.2 million in 30 days, roughly 0.8 to 1 GB of Redis per such key (arithmetic from the measured 150 to 190 bytes per key, not measured). Now session keys expire `sessions.idleTtlHours` (default 24) after their last admit, and one key may start at most `sessions.newPerKeyPerHour` (default 1,000; service keys `sessions.newPerServiceKeyPerHour`, default 10,000; or the key's own `maxNewSessionsPerHour`) new sessions an hour, a GCRA checked inside admit before anything is written; over it the request gets a 429 `session-churn` with `x-should-retry: false`. Each admitted session costs a marker and a session budget level (about 170 bytes each in the last Redis run), so one key can hold at most about 1,000 times 24 sessions at once: about 48,000 keys, roughly 8 MB of Redis, at the defaults (arithmetic). `test/security/s-v2-1-session-churn.test.ts` sends a new session id on every request through the gateway, on the memory store and on Redis: past the allowance every request is refused and the key count does not move over a thousand more, while another key with three sessions is unaffected.

### Chaos and failure tests (`test/chaos/`, V3)

Provider failures, client disconnects, slow consumers, Redis outages, hot reload under load, keep-alive reuse under
load and the body cap against scan time, each checked against the same invariants (one trace line per request, a
correct charge at least what the provider billed, fallback only before the first byte, nothing left in the store, no
unhandled rejection). Scenarios, results and the three findings fixed: [docs/chaos.md](chaos.md). Reproduce with
`npm run test:chaos` (Docker for the Redis cases).

## Live results (`examples/live/`)

The live sessions run only through `npm run live` (design spec, section 14.1), on the maintainer's machine, against the real APIs under a hard cap enforced by tokenyard's own budget. Their raw traces stay in `.live/traces/` (gitignored). What is committed is derived from an anonymized export only:

```sh
# without TOKENYARD_EXPORT_SALT or --salt-file, --anonymize uses a fresh random salt, never stored
node bin/tokenyard.mjs traces export --since 30d --trace-dir .live/traces --anonymize --out examples/live/live.ndjson.gz
node bin/tokenyard.mjs report --traces examples/live/live.ndjson.gz --since 2026-11-01T00:00:00Z --until 2026-11-04T00:00:00Z --by session --html examples/live/report.html
npx tsx bench/live-summary.ts                   # examples/live/summary.json (and .live/raw-names.json, local only)
```

`--anonymize` replaces tenant, team, key, repo, branch, ticket and feature with salted pseudonyms, drops the client version, and re-keys every linkable id with the same salt: record ids become their position in the export, instance ids, the session, agent and prompt HMACs, the prefix hash and guardrail value HMACs are replaced consistently within the export (so sessions, subagent joins, the cache-breaker list and taint still work) and match nothing in the raw traces. Dates in `summary.json` and [Real sessions](real-sessions.md) are UTC.

The screenshots `examples/live/report-light.png` and `report-dark.png` are that HTML report rendered by headless Chrome with the light and the dark color scheme (`--blink-settings=preferredColorScheme=1` and `=0`, `--force-device-scale-factor=2`). `summary.json` holds the aggregates [Real sessions](real-sessions.md) quotes; the per-session cost Claude Code printed is not in any trace and is copied from `test/live/claude-code.live.md`, and the client versions (dropped by `--anonymize`) from the two live logs.

`.live/raw-names.json` lists the raw tenant, team, key, repo, branch, ticket and feature values of the raw traces and every linkable id in them (record, instance, session, agent and prompt ids, prefix hashes, guardrail value HMACs); the local-only tests in `test/docs/readme.test.ts` check that none of them appears in `examples/live/`. It is skipped in CI, where the raw traces do not exist.

## Demo comment image

`docs/demo-comment-light.png` and `docs/demo-comment-dark.png` are a local render of the Markdown the GitHub Action posts (`renderMarkdown` on the replay of `examples/traces/demo.ndjson.gz` with `examples/policy` as base and `examples/policy-head` as head), converted to HTML with GitHub-like styles and captured with headless Chrome in both color schemes. No network service is involved:

```sh
npx tsx scripts/render-demo-png.ts      # CHROME=<path> overrides the macOS Chrome location
```
 They will be replaced by a recording of the real demo pull request's bot comment once that pull request is open.
