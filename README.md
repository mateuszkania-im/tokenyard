<!-- BENCH:START -->
Measured by `npm run bench` on Apple M2 Pro (12 cores, 16 GB, arm64), darwin 27.0.0, Node v22.14.0; tsx 4.23.15, redis 7.4.12; commit `5a72e15`, run 2026-11-03T02:03:24.628Z. Every request goes to the mock provider on loopback; no real provider is called.

#### SLO targets (spec 12.1)

| SLI | Target | Measured | Result |
|---|---|---|---|
| Added TTFB p50 / p99, non-streaming, 10 streams, memory store | under 5 ms / under 25 ms | 0.44 ms / 0.82 ms (n = 2,200); client-side TTFB outside the provider, p50 / p99: direct 1.56 / 3.82 ms, through the gateway 3.01 / 7.25 ms | met |
| Added TTFB p50 / p99, non-streaming, 100 streams, memory store | under 5 ms / under 25 ms | 0.1 ms / 0.24 ms (n = 5,000); client-side TTFB outside the provider, p50 / p99: direct 0.26 / 2.35 ms, through the gateway 0.63 / 3.18 ms | met |
| Added TTFB p50 / p99, non-streaming, 500 streams, memory store | under 5 ms / under 25 ms | 0.04 ms / 0.09 ms (n = 25,000); client-side TTFB outside the provider, p50 / p99: direct 0.4 / 4.44 ms, through the gateway 4.71 / 677.02 ms | missed |
| Added TTFB p50 / p99, streaming 500 tokens, 10 streams, memory store | under 5 ms / under 25 ms | 0.48 ms / 1.12 ms (n = 2,200); client-side TTFB outside the provider, p50 / p99: direct 0.43 / 2.15 ms, through the gateway 1.8 / 5.48 ms | met |
| Added TTFB p50 / p99, streaming 500 tokens, 100 streams, memory store | under 5 ms / under 25 ms | 0.08 ms / 0.31 ms (n = 2,252); client-side TTFB outside the provider, p50 / p99: direct 0.24 / 2.75 ms, through the gateway 0.65 / 2.97 ms | met |
| Added TTFB p50 / p99, streaming 500 tokens, 500 streams, memory store | under 5 ms / under 25 ms | 0.05 ms / 0.13 ms (n = 6,261); client-side TTFB outside the provider, p50 / p99: direct 0.52 / 2.83 ms, through the gateway 10.13 / 18.21 ms | missed |
| Added TTFB p50 / p99, streaming 150 KB body, 10 streams, memory store | under 5 ms / under 25 ms | 9.34 ms / 13.92 ms (n = 2,200); client-side TTFB outside the provider, p50 / p99: direct 0.68 / 2.76 ms, through the gateway 11.79 / 31.28 ms | missed |
| Added TTFB p50 / p99, streaming 150 KB body, 100 streams, memory store | under 5 ms / under 25 ms | 4.03 ms / 5.21 ms (n = 2,251); client-side TTFB outside the provider, p50 / p99: direct 0.21 / 2.42 ms, through the gateway 10.32 / 30.53 ms | missed |
| Added TTFB p50 / p99, streaming 150 KB body, 500 streams, memory store | under 5 ms / under 25 ms | 4.02 ms / 6.11 ms (n = 6,233); client-side TTFB outside the provider, p50 / p99: direct 308.71 / 749.52 ms, through the gateway 11518.26 / 19953.45 ms | missed |
| Added TTFB p50 / p99, non-streaming, 10 streams, redis store | under 5 ms / under 25 ms | 1.74 ms / 4.61 ms (n = 2,200); client-side TTFB outside the provider, p50 / p99: direct 1.56 / 3.82 ms, through the gateway 4.24 / 9.38 ms | met |
| Added TTFB p50 / p99, non-streaming, 100 streams, redis store | under 5 ms / under 25 ms | 1.05 ms / 35.3 ms (n = 5,000); client-side TTFB outside the provider, p50 / p99: direct 0.26 / 2.35 ms, through the gateway 1.68 / 37.15 ms | missed |
| Added TTFB p50 / p99, non-streaming, 500 streams, redis store | under 5 ms / under 25 ms | 13.21 ms / 108.53 ms (n = 25,000); client-side TTFB outside the provider, p50 / p99: direct 0.4 / 4.44 ms, through the gateway 84.19 / 1807.58 ms | missed |
| Added TTFB p50 / p99, streaming 500 tokens, 10 streams, redis store | under 5 ms / under 25 ms | 2.41 ms / 4.42 ms (n = 2,200); client-side TTFB outside the provider, p50 / p99: direct 0.43 / 2.15 ms, through the gateway 3.65 / 8.14 ms | met |
| Added TTFB p50 / p99, streaming 500 tokens, 100 streams, redis store | under 5 ms / under 25 ms | 1.15 ms / 3.7 ms (n = 2,250); client-side TTFB outside the provider, p50 / p99: direct 0.24 / 2.75 ms, through the gateway 1.63 / 5.88 ms | met |
| Added TTFB p50 / p99, streaming 500 tokens, 500 streams, redis store | under 5 ms / under 25 ms | 3.89 ms / 9.85 ms (n = 6,240); client-side TTFB outside the provider, p50 / p99: direct 0.52 / 2.83 ms, through the gateway 12.6 / 23.49 ms | missed |
| Added TTFB p50 / p99, streaming 150 KB body, 10 streams, redis store | under 5 ms / under 25 ms | 10.25 ms / 17.96 ms (n = 2,200); client-side TTFB outside the provider, p50 / p99: direct 0.68 / 2.76 ms, through the gateway 12.56 / 22.99 ms | missed |
| Added TTFB p50 / p99, streaming 150 KB body, 100 streams, redis store | under 5 ms / under 25 ms | 9.54 ms / 29.14 ms (n = 2,261); client-side TTFB outside the provider, p50 / p99: direct 0.21 / 2.42 ms, through the gateway 21.73 / 57.46 ms | missed |
| Added TTFB p50 / p99, streaming 150 KB body, 500 streams, redis store | under 5 ms / under 25 ms | 771.97 ms / 1004.49 ms (n = 522); client-side TTFB outside the provider, p50 / p99: direct 308.71 / 749.52 ms, through the gateway 3873.78 / 17802.81 ms | missed |
| Gateway-attributable error rate | under 0.1% per month | not measured (a production SLI); overhead runs: 5730 errors beside 127768 answered requests through the gateway | not measured |
| Policy propagation, merge to all instances, p99 | under 60 s | not measured | not measured |
| Admitted spend above an enforced budget (worst-case estimator) | zero | $0 over 2 run(s) of 1,000 requests sent at once (memory, redis) | met |
| Conformance suite on the pinned Claude Code and Codex versions | 100% | not measured by the benchmark (docs/conformance.md) | not measured |
| Cache hit ratio through tokenyard versus direct, same session on the mock | equal | 95.65% versus 95.65% | met |
| Replay of 1,000,000 trace records | under 60 s on a CI runner | 41.2 s on the machine above (not a CI runner) | met |

#### Gateway overhead

An open-loop load generator in the benchmark process sends each scenario to the mock provider directly and through the gateway (each in its own process, loopback). The mock answers after a fixed 100 ms time to first token and streams 500 tokens at 2000 tokens/s. Each stream is one keep-alive connection, opened before the run, with its own schedule of evenly spaced send times (5 requests/s non-streaming, 1.25 requests/s streaming) starting at a seeded random phase, so connections do not fire together; a request still running at the next scheduled time delays the next one, and client-side latency always counts from the scheduled time (coordinated omission included). Added TTFB is the gateway's own per-request measure from its traces (`addedTtfbMs`: from the start of request handling to forwarding upstream, with a sub-millisecond clock in the benchmark), so it is paired per request; it does not include time a request waits before the gateway starts handling it, nor the response path. The client-side columns are absolute percentiles of each path, never subtracted from each other; "outside the provider" is each request's TTFB minus the mock's own wait for that request (the `x-mock-wait-ms` header), paired per request, so the mock's timer jitter drops out. An added TTFB SLO row is met only when both the gateway-measured value and the client-side TTFB outside the provider through the gateway (an upper bound on what the gateway adds, which includes queueing before handling) are under target. n is the number of samples behind each percentile. CPU is the gateway process's user plus system time over the run's wall time (100% is one core); RSS growth is its peak during the run above its size just before it; per 100 streams is the slope between 100 and 500 streams. The gateway runs examples/policy with every budget level enforced at a limit the load never reaches, no rate limits, guardrails on, traces written and metrics kept.

Errors count non-2xx answers and socket errors; scheduled requests the run could not send within its drain time are listed as dropped in bench/results.json.

Memory store:

| Scenario | Streams | Added TTFB p50 / p95 / p99 (ms), gateway-measured | TTFB outside the provider p50 / p99 (ms), direct | Same, through the gateway | Total time p50 / p99 (ms), direct | Same, through the gateway | Gateway CPU | Gateway RSS growth | Errors (direct / gateway) |
|---|---:|---|---|---|---|---|---:|---:|---:|
| Non-streaming, small body | 10 | 0.44 / 0.72 / 0.82 (n = 2,200) | 1.56 / 3.82 | 3.01 / 7.25 | 102.74 / 106.22 | 104.89 / 109.62 | 21.6% | 31.5 MB | 0 / 0 |
| Non-streaming, small body | 100 | 0.10 / 0.15 / 0.24 (n = 5,000) | 0.26 / 2.35 | 0.63 / 3.18 | 100.69 / 103.72 | 100.97 / 103.92 | 52.3% | 7.8 MB | 0 / 0 |
| Non-streaming, small body | 500 | 0.04 / 0.06 / 0.09 (n = 25,000) | 0.40 / 4.44 | 4.71 / 677.02 | 100.73 / 105.45 | 104.87 / 779.45 | 100.2% | 201.8 MB | 0 / 0 |
| Streaming, 500 tokens | 10 | 0.48 / 0.87 / 1.12 (n = 2,200) | 0.43 / 2.15 | 1.80 / 5.48 | 355.02 / 366.58 | 356.21 / 390.42 | 18.6% | 18.9 MB | 0 / 0 |
| Streaming, 500 tokens | 100 | 0.08 / 0.14 / 0.31 (n = 2,252) | 0.24 / 2.75 | 0.65 / 2.97 | 393.56 / 422.55 | 368.18 / 380.97 | 48.9% | 11.3 MB | 0 / 0 |
| Streaming, 500 tokens | 500 | 0.05 / 0.09 / 0.13 (n = 6,261) | 0.52 / 2.83 | 10.13 / 18.21 | 421.11 / 447.48 | 423.46 / 444.36 | 109.3% | 100.5 MB | 0 / 0 |
| Streaming, 150 KB body | 10 | 9.34 / 12.37 / 13.92 (n = 2,200) | 0.68 / 2.76 | 11.79 / 31.28 | 360.20 / 378.64 | 362.68 / 380.10 | 23.0% | 105.6 MB | 0 / 0 |
| Streaming, 150 KB body | 100 | 4.03 / 4.64 / 5.21 (n = 2,251) | 0.21 / 2.42 | 10.32 / 30.53 | 366.06 / 379.50 | 352.92 / 376.59 | 87.0% | 51.4 MB | 0 / 0 |
| Streaming, 150 KB body | 500 | 4.02 / 5.04 / 6.11 (n = 6,233) | 308.71 / 749.52 | 11,518.26 / 19,953.45 | 1,195.72 / 1,543.82 | 11,620.22 / 20,232.61 | 110.0% | 246.1 MB | 0 / 0 |

Redis store:

| Scenario | Streams | Added TTFB p50 / p95 / p99 (ms), gateway-measured | TTFB outside the provider p50 / p99 (ms), direct | Same, through the gateway | Total time p50 / p99 (ms), direct | Same, through the gateway | Gateway CPU | Gateway RSS growth | Errors (direct / gateway) |
|---|---:|---|---|---|---|---|---:|---:|---:|
| Non-streaming, small body | 10 | 1.74 / 3.50 / 4.61 (n = 2,200) | 1.56 / 3.82 | 4.24 / 9.38 | 102.74 / 106.22 | 105.60 / 110.79 | 23.0% | 30.6 MB | 0 / 0 |
| Non-streaming, small body | 100 | 1.05 / 3.46 / 35.30 (n = 5,000) | 0.26 / 2.35 | 1.68 / 37.15 | 100.69 / 103.72 | 102.01 / 137.14 | 50.5% | 6.5 MB | 0 / 0 |
| Non-streaming, small body | 500 | 13.21 / 40.08 / 108.53 (n = 25,000) | 0.40 / 4.44 | 84.19 / 1,807.58 | 100.73 / 105.45 | 184.66 / 1,910.70 | 94.7% | 241.3 MB | 0 / 0 |
| Streaming, 500 tokens | 10 | 2.41 / 3.61 / 4.42 (n = 2,200) | 0.43 / 2.15 | 3.65 / 8.14 | 355.02 / 366.58 | 357.95 / 372.37 | 20.1% | 71.3 MB | 0 / 0 |
| Streaming, 500 tokens | 100 | 1.15 / 2.50 / 3.70 (n = 2,250) | 0.24 / 2.75 | 1.63 / 5.88 | 393.56 / 422.55 | 363.46 / 375.34 | 48.3% | 7.2 MB | 0 / 0 |
| Streaming, 500 tokens | 500 | 3.89 / 8.32 / 9.85 (n = 6,240) | 0.52 / 2.83 | 12.60 / 23.49 | 421.11 / 447.48 | 422.61 / 441.49 | 109.7% | 131.1 MB | 0 / 0 |
| Streaming, 150 KB body | 10 | 10.25 / 14.06 / 17.96 (n = 2,200) | 0.68 / 2.76 | 12.56 / 22.99 | 360.20 / 378.64 | 363.54 / 382.32 | 24.6% | 102.6 MB | 0 / 0 |
| Streaming, 150 KB body | 100 | 9.54 / 22.52 / 29.14 (n = 2,261) | 0.21 / 2.42 | 21.73 / 57.46 | 366.06 / 379.50 | 367.02 / 405.89 | 89.4% | 130.7 MB | 0 / 0 |
| Streaming, 150 KB body | 500 | 771.97 / 983.73 / 1,004.49 (n = 522) | 308.71 / 749.52 | 3,873.78 / 17,802.81 | 1,195.72 / 1,543.82 | 3,975.99 / 18,177.89 | 109.4% | 638.4 MB | 0 / 5,730 |

Gateway cost per 100 more streams (slope between two levels):

| Store | Scenario | Streams | CPU per 100 streams | RSS growth per 100 streams |
|---|---|---|---:|---:|
| memory | Non-streaming, small body | 100 to 500 | 12.0% (gateway saturated at 500 streams, so this understates it) | 48.5 MB |
| redis | Non-streaming, small body | 100 to 500 | 11.1% | 58.7 MB |
| memory | Streaming, 500 tokens | 100 to 500 | 15.1% (gateway saturated at 500 streams, so this understates it) | 22.3 MB |
| redis | Streaming, 500 tokens | 100 to 500 | 15.4% (gateway saturated at 500 streams, so this understates it) | 31.0 MB |
| memory | Streaming, 150 KB body | 100 to 500 | 5.8% (gateway saturated at 500 streams, so this understates it) | 48.7 MB |
| redis | Streaming, 150 KB body | 100 to 500 | 5.0% (gateway saturated at 500 streams, so this understates it) | 126.9 MB |

<details><summary>Every concurrency level, with client-side TTFB from the scheduled send time</summary>

| Store | Scenario | Streams | Rate per stream (req/s) | Seconds | Answered (direct / gateway) | Added TTFB p50 / p95 / p99 (ms) | TTFB p50 / p95 / p99 (ms), direct | Same, through the gateway | Gateway CPU | Gateway RSS |
|---|---|---:|---:|---:|---:|---|---|---|---:|---:|
| memory | Non-streaming, small body | 1 | 5.00 | 20 | 100 / 100 | 1.10 / 1.43 / 1.57 | 105.59 / 106.90 / 107.98 | 108.20 / 110.16 / 111.00 | 4.2% | 109.8 MB |
| redis | Non-streaming, small body | 1 | 5.00 | 20 | 100 / 100 | 3.11 / 4.25 / 4.85 | 105.59 / 106.90 / 107.98 | 109.65 / 112.61 / 116.71 | 4.5% | 129.3 MB |
| memory | Non-streaming, small body | 10 | 5.00 | 44 | 2,200 / 2,200 | 0.44 / 0.72 / 0.82 | 102.63 / 105.16 / 106.08 | 104.56 / 107.37 / 109.17 | 21.6% | 141.3 MB |
| redis | Non-streaming, small body | 10 | 5.00 | 44 | 2,200 / 2,200 | 1.74 / 3.50 / 4.61 | 102.63 / 105.16 / 106.08 | 105.37 / 108.86 / 110.54 | 23.0% | 159.9 MB |
| memory | Non-streaming, small body | 16 | 5.00 | 5 | 400 / 400 | 0.38 / 0.66 / 0.76 | 102.17 / 104.52 / 105.35 | 103.81 / 107.10 / 112.13 | 22.4% | 138.0 MB |
| redis | Non-streaming, small body | 16 | 5.00 | 5 | 400 / 400 | 1.54 / 2.95 / 4.27 | 102.17 / 104.52 / 105.35 | 104.77 / 108.10 / 109.81 | 29.0% | 157.4 MB |
| memory | Non-streaming, small body | 64 | 5.00 | 5 | 1,600 / 1,600 | 0.12 / 0.24 / 0.47 | 100.82 / 102.65 / 104.14 | 101.30 / 103.82 / 105.33 | 46.5% | 149.6 MB |
| redis | Non-streaming, small body | 64 | 5.00 | 5 | 1,600 / 1,600 | 1.14 / 2.16 / 2.87 | 100.82 / 102.65 / 104.14 | 102.35 / 104.74 / 106.56 | 47.5% | 164.4 MB |
| memory | Non-streaming, small body | 100 | 5.00 | 10 | 5,000 / 5,000 | 0.10 / 0.15 / 0.24 | 100.64 / 102.25 / 103.66 | 100.88 / 102.65 / 103.82 | 52.3% | 157.3 MB |
| redis | Non-streaming, small body | 100 | 5.00 | 10 | 5,000 / 5,000 | 1.05 / 3.46 / 35.30 | 100.64 / 102.25 / 103.66 | 101.94 / 105.84 / 137.12 | 50.5% | 171.1 MB |
| memory | Non-streaming, small body | 256 | 5.00 | 5 | 6,400 / 6,400 | 0.05 / 0.10 / 0.17 | 100.60 / 102.26 / 105.01 | 100.95 / 215.01 / 266.99 | 79.0% | 211.7 MB |
| redis | Non-streaming, small body | 256 | 5.00 | 5 | 6,400 / 6,400 | 0.64 / 1.41 / 2.05 | 100.60 / 102.26 / 105.01 | 101.00 / 102.62 / 103.75 | 75.4% | 254.7 MB |
| memory | Non-streaming, small body | 500 | 5.00 | 10 | 25,000 / 25,000 | 0.04 / 0.06 / 0.09 | 100.70 / 102.91 / 105.41 | 104.82 / 669.87 / 779.43 | 100.2% | 299.9 MB |
| redis | Non-streaming, small body | 500 | 5.00 | 10 | 25,000 / 25,000 | 13.21 / 40.08 / 108.53 | 100.70 / 102.91 / 105.41 | 184.63 / 1,682.74 / 1,910.69 | 94.7% | 355.5 MB |
| memory | Streaming, 500 tokens | 1 | 1.25 | 20 | 25 / 25 | 1.22 / 1.31 / 1.36 | 105.05 / 106.84 / 106.96 | 110.45 / 124.11 / 157.42 | 4.2% | 110.4 MB |
| redis | Streaming, 500 tokens | 1 | 1.25 | 20 | 25 / 25 | 3.61 / 4.74 / 5.75 | 105.05 / 106.84 / 106.96 | 113.51 / 127.71 / 163.90 | 5.3% | 119.2 MB |
| memory | Streaming, 500 tokens | 10 | 1.25 | 176 | 2,200 / 2,200 | 0.48 / 0.87 / 1.12 | 100.93 / 102.28 / 103.17 | 102.31 / 104.55 / 107.34 | 18.6% | 111.6 MB |
| redis | Streaming, 500 tokens | 10 | 1.25 | 176 | 2,200 / 2,200 | 2.41 / 3.61 / 4.42 | 100.93 / 102.28 / 103.17 | 104.08 / 106.35 / 108.51 | 20.1% | 116.4 MB |
| memory | Streaming, 500 tokens | 16 | 1.25 | 15 | 300 / 301 | 0.43 / 0.66 / 0.87 | 100.80 / 101.91 / 102.81 | 101.90 / 103.57 / 107.17 | 25.8% | 93.1 MB |
| redis | Streaming, 500 tokens | 16 | 1.25 | 15 | 300 / 296 | 2.03 / 3.51 / 4.64 | 100.80 / 101.91 / 102.81 | 103.53 / 106.33 / 111.08 | 25.4% | 118.3 MB |
| memory | Streaming, 500 tokens | 64 | 1.25 | 5 | 398 / 394 | 0.13 / 0.36 / 0.60 | 101.21 / 102.98 / 103.69 | 101.20 / 103.08 / 105.49 | 43.2% | 106.2 MB |
| redis | Streaming, 500 tokens | 64 | 1.25 | 5 | 398 / 398 | 1.56 / 3.03 / 4.17 | 101.21 / 102.98 / 103.69 | 102.53 / 104.82 / 109.56 | 45.1% | 127.8 MB |
| memory | Streaming, 500 tokens | 100 | 1.25 | 18 | 2,251 / 2,252 | 0.08 / 0.14 / 0.31 | 101.32 / 103.41 / 104.72 | 101.07 / 102.71 / 103.82 | 48.9% | 116.1 MB |
| redis | Streaming, 500 tokens | 100 | 1.25 | 18 | 2,251 / 2,250 | 1.15 / 2.50 / 3.70 | 101.32 / 103.41 / 104.72 | 102.07 / 104.41 / 106.22 | 48.3% | 126.3 MB |
| memory | Streaming, 500 tokens | 256 | 1.25 | 5 | 1,598 / 1,602 | 0.05 / 0.09 / 0.15 | 101.29 / 102.98 / 103.86 | 101.02 / 102.96 / 104.03 | 71.4% | 126.8 MB |
| redis | Streaming, 500 tokens | 256 | 1.25 | 5 | 1,598 / 1,599 | 1.18 / 2.18 / 3.35 | 101.29 / 102.98 / 103.86 | 101.94 / 104.60 / 106.50 | 72.0% | 148.3 MB |
| memory | Streaming, 500 tokens | 500 | 1.25 | 10 | 6,245 / 6,261 | 0.05 / 0.09 / 0.13 | 102.03 / 104.48 / 105.49 | 111.37 / 116.33 / 119.59 | 109.3% | 177.7 MB |
| redis | Streaming, 500 tokens | 500 | 1.25 | 10 | 6,245 / 6,240 | 3.89 / 8.32 / 9.85 | 102.03 / 104.48 / 105.49 | 113.80 / 121.06 / 124.94 | 109.7% | 218.5 MB |
| memory | Streaming, 150 KB body | 1 | 1.25 | 20 | 25 / 25 | 12.84 / 15.12 / 17.04 | 108.81 / 110.19 / 110.40 | 121.41 / 125.49 / 128.56 | 6.3% | 102.1 MB |
| redis | Streaming, 150 KB body | 1 | 1.25 | 20 | 25 / 25 | 14.09 / 17.35 / 18.57 | 108.81 / 110.19 / 110.40 | 122.28 / 127.96 / 128.22 | 5.9% | 115.4 MB |
| memory | Streaming, 150 KB body | 10 | 1.25 | 176 | 2,200 / 2,200 | 9.34 / 12.37 / 13.92 | 103.68 / 105.66 / 106.59 | 113.63 / 129.81 / 133.43 | 23.0% | 150.8 MB |
| redis | Streaming, 150 KB body | 10 | 1.25 | 176 | 2,200 / 2,200 | 10.25 / 14.06 / 17.96 | 103.68 / 105.66 / 106.59 | 114.23 / 119.91 / 124.36 | 24.6% | 147.5 MB |
| memory | Streaming, 150 KB body | 16 | 1.25 | 15 | 300 / 303 | 7.43 / 11.04 / 13.33 | 103.51 / 105.57 / 107.42 | 110.66 / 120.33 / 122.72 | 30.4% | 138.4 MB |
| redis | Streaming, 150 KB body | 16 | 1.25 | 15 | 300 / 297 | 10.07 / 27.63 / 31.60 | 103.51 / 105.57 / 107.42 | 115.52 / 142.74 / 145.27 | 29.1% | 151.7 MB |
| memory | Streaming, 150 KB body | 64 | 1.25 | 5 | 398 / 405 | 4.70 / 5.41 / 6.12 | 102.73 / 105.38 / 107.24 | 108.53 / 125.39 / 128.07 | 65.1% | 156.6 MB |
| redis | Streaming, 150 KB body | 64 | 1.25 | 5 | 398 / 403 | 6.02 / 16.66 / 20.87 | 102.73 / 105.38 / 107.24 | 113.33 / 131.00 / 136.56 | 62.9% | 179.1 MB |
| memory | Streaming, 150 KB body | 100 | 1.25 | 18 | 2,253 / 2,251 | 4.03 / 4.64 / 5.21 | 101.87 / 103.68 / 104.79 | 111.34 / 124.70 / 131.21 | 87.0% | 193.2 MB |
| redis | Streaming, 150 KB body | 100 | 1.25 | 18 | 2,253 / 2,261 | 9.54 / 22.52 / 29.14 | 101.87 / 103.68 / 104.79 | 122.86 / 145.48 / 157.95 | 89.4% | 245.3 MB |
| memory | Streaming, 150 KB body | 256 | 1.25 | 5 | 1,606 / 1,603 | 3.99 / 5.06 / 6.12 | 101.55 / 103.66 / 104.94 | 2,149.14 / 3,157.59 / 3,296.91 | 111.9% | 365.1 MB |
| redis | Streaming, 150 KB body | 256 | 1.25 | 5 | 1,606 / 1,597 | 292.82 / 765.41 / 866.95 | 101.55 / 103.66 / 104.94 | 2,285.58 / 4,052.59 / 4,252.52 | 99.9% | 423.9 MB |
| memory | Streaming, 150 KB body | 500 | 1.25 | 10 | 6,245 / 6,233 | 4.02 / 5.04 / 6.11 | 415.52 / 828.80 / 856.97 | 11,619.96 / 19,650.55 / 20,053.90 | 110.0% | 487.2 MB |
| redis | Streaming, 150 KB body | 500 | 1.25 | 10 | 6,245 / 522 | 771.97 / 983.73 / 1,004.49 | 415.52 / 828.80 / 856.97 | 3,975.79 / 17,566.07 / 17,903.73 | 109.4% | 791.1 MB |

</details>

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

Default rules on a 4.1 MiB synthetic coding-agent body: last-turn scan 85.7 MiB/s, full-body scan 45.4 MiB/s. False-positive corpus (source trees and lockfiles sent as tool results): 683 files, 6.7 MB, 0 block hits.

#### Replay throughput

1,000,000 synthetic trace records (the demo week repeated, 100.4 MB gzipped export) read, parsed and replayed against the demo's base and head policies in 41.2 s (24,260 records/s, fidelity 100.0%).

#### Estimator calibration

| Traces | Requests with usage | Bounds (bytes / context-window) | Bytes bound to billed input, min / median / max | Reservation to actual cost, min / median / max | Billed input above bound |
|---|---:|---:|---|---|---:|
| Demo traffic (mock provider, 4 bytes per token) | 3,647 | 3,647 / 0 | 4.04 / 5.44 / 66.37 | 12.70 / 32.55 / 544.76 | 0 |
| Live Claude Code 2.1.316, 2026-11-02 | 18 | 16 / 2 | 2.88 / 2.91 / 2.95 | 22.52 / 230.85 / 1,448.02 | 0 |
| Live Codex 0.166.0, 2026-11-02 | 3 | 1 / 2 | 5.03 / 5.03 / 5.03 | 68.07 / 493.65 / 719.10 | 0 |

Live rows come from the local live runs through tokenyard (spec 14.1) and are aggregates only.
<!-- BENCH:END -->
