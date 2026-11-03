<!-- BENCH:START -->
Measured by `npm run bench` on Apple M2 Pro (12 cores, 16 GB, arm64), darwin 27.0.0, Node v22.14.0; autocannon 8.0.0, tsx 4.23.15, redis 7.4.12; commit `6800f88`, run 2026-11-03T01:19:05.365Z. Every request goes to the mock provider on loopback; no real provider is called.

#### SLO targets (spec 12.1)

| SLI | Target | Measured | Result |
|---|---|---|---|
| Added TTFB p50 / p99, non-streaming, 10 streams, memory store | under 5 ms / under 25 ms | 5.14 ms / 11.63 ms | missed |
| Added TTFB p50 / p99, non-streaming, 100 streams, memory store | under 5 ms / under 25 ms | 7 ms / 21.25 ms | missed |
| Added TTFB p50 / p99, non-streaming, 500 streams, memory store | under 5 ms / under 25 ms | 16.41 ms / 39.4 ms | missed |
| Added TTFB p50 / p99, streaming 500 tokens, 10 streams, memory store | under 5 ms / under 25 ms | 4.4 ms / 9.05 ms | met |
| Added TTFB p50 / p99, streaming 500 tokens, 100 streams, memory store | under 5 ms / under 25 ms | 11.39 ms / 13.11 ms | missed |
| Added TTFB p50 / p99, streaming 500 tokens, 500 streams, memory store | under 5 ms / under 25 ms | 9.34 ms / 176.98 ms | missed |
| Added TTFB p50 / p99, streaming 150 KB body, 10 streams, memory store | under 5 ms / under 25 ms | 60 ms / 56.06 ms | missed |
| Added TTFB p50 / p99, streaming 150 KB body, 100 streams, memory store | under 5 ms / under 25 ms | 269.99 ms / 386.51 ms | missed |
| Added TTFB p50 / p99, streaming 150 KB body, 500 streams, memory store | under 5 ms / under 25 ms | 1228.11 ms / 2121.3 ms | missed |
| Added TTFB p50 / p99, non-streaming, 10 streams, redis store | under 5 ms / under 25 ms | 10.19 ms / 13 ms | missed |
| Added TTFB p50 / p99, non-streaming, 100 streams, redis store | under 5 ms / under 25 ms | 14.26 ms / 25.29 ms | missed |
| Added TTFB p50 / p99, non-streaming, 500 streams, redis store | under 5 ms / under 25 ms | 33.82 ms / 83.58 ms | missed |
| Added TTFB p50 / p99, streaming 500 tokens, 10 streams, redis store | under 5 ms / under 25 ms | 6.97 ms / 9.55 ms | missed |
| Added TTFB p50 / p99, streaming 500 tokens, 100 streams, redis store | under 5 ms / under 25 ms | 12.9 ms / 14.66 ms | missed |
| Added TTFB p50 / p99, streaming 500 tokens, 500 streams, redis store | under 5 ms / under 25 ms | 14.23 ms / 189.56 ms | missed |
| Added TTFB p50 / p99, streaming 150 KB body, 10 streams, redis store | under 5 ms / under 25 ms | 65.01 ms / 61.47 ms | missed |
| Added TTFB p50 / p99, streaming 150 KB body, 100 streams, redis store | under 5 ms / under 25 ms | 260.98 ms / 398.04 ms | missed |
| Added TTFB p50 / p99, streaming 150 KB body, 500 streams, redis store | under 5 ms / under 25 ms | 677.42 ms / 2629.52 ms | missed |
| Gateway-attributable error rate | under 0.1% per month | not measured (a production SLI); overhead runs: 208230 errors beside 54289 answered requests through the gateway | not measured |
| Policy propagation, merge to all instances, p99 | under 60 s | not measured | not measured |
| Admitted spend above an enforced budget (worst-case estimator) | zero | $0 over 2 run(s) of 1,000 concurrent requests (memory, redis) | met |
| Conformance suite on the pinned Claude Code and Codex versions | 100% | not measured by the benchmark (docs/conformance.md) | not measured |
| Cache hit ratio through tokenyard versus direct, same session on the mock | equal | 95.65% versus 95.65% | met |
| Replay of 1,000,000 trace records | under 60 s on a CI runner | 44.5 s on the machine above (not a CI runner) | met |

#### Gateway overhead

autocannon drives each scenario at the mock provider directly and through the gateway (both in their own processes, loopback); the mock answers after a fixed 100 ms time to first token and streams 500 tokens at 1000 tokens/s. Each connection is one stream with a fixed request rate below what it can complete directly; latencies are corrected for coordinated omission with that intended interval. Added time is the gateway percentile minus the direct percentile; CPU and RSS are the gateway process's, RSS above its idle size. The gateway runs examples/policy with every budget level enforced at a limit the load never reaches, no rate limits, guardrails on, traces written and metrics kept.

Errors count non-2xx answers and socket errors. autocannon reconnects at once after a connection reset, so a saturated server shows many socket errors per stream.

Memory store:

| Scenario | Streams | Added TTFB p50 / p95 / p99 (ms) | Added total p50 / p95 / p99 (ms) | Gateway CPU per 100 streams | Gateway RSS per 100 streams | Errors (direct / gateway) |
|---|---:|---|---|---:|---:|---:|
| Non-streaming, small body | 10 | 5.14 / 9.01 / 11.63 | 5.42 / 9.19 / 11.83 | 97.7% | 0.0 MB | 0 / 0 |
| Non-streaming, small body | 100 | 7.00 / 18.40 / 21.25 | 7.03 / 18.42 / 21.27 | 29.9% | 32.8 MB | 0 / 0 |
| Non-streaming, small body | 500 | 16.41 / 22.06 / 39.40 | 16.42 / 22.09 / 39.41 | 15.3% | 24.5 MB | 0 / 0 |
| Streaming, 500 tokens | 10 | 4.40 / 6.83 / 9.05 | 2.42 / -0.66 / -1.56 | 128.7% | 161.4 MB | 0 / 0 |
| Streaming, 500 tokens | 100 | 11.39 / 12.62 / 13.11 | -35.02 / -41.62 / -44.16 | 34.3% | 17.0 MB | 0 / 0 |
| Streaming, 500 tokens | 500 | 9.34 / 13.70 / 176.98 | -16.83 / -20.60 / 80.39 | 17.2% | 7.3 MB | 0 / 0 |
| Streaming, 150 KB body | 10 | 60.00 / 57.07 / 56.06 | 57.33 / 58.60 / 56.41 | 181.1% | 576.6 MB | 0 / 0 |
| Streaming, 150 KB body | 100 | 269.99 / 310.65 / 386.51 | 255.82 / 432.09 / 445.04 | 75.5% | 98.3 MB | 0 / 0 |
| Streaming, 150 KB body | 500 | 1,228.11 / 2,195.50 / 2,121.30 | 914.72 / 2,056.01 / 2,030.61 | 22.2% | 58.8 MB | 286 / 25,255 |

Redis store:

| Scenario | Streams | Added TTFB p50 / p95 / p99 (ms) | Added total p50 / p95 / p99 (ms) | Gateway CPU per 100 streams | Gateway RSS per 100 streams | Errors (direct / gateway) |
|---|---:|---|---|---:|---:|---:|
| Non-streaming, small body | 10 | 10.19 / 12.91 / 13.00 | 10.35 / 13.04 / 13.35 | 102.1% | 0.0 MB | 0 / 0 |
| Non-streaming, small body | 100 | 14.26 / 25.10 / 25.29 | 14.30 / 25.12 / 25.33 | 27.0% | 23.0 MB | 0 / 0 |
| Non-streaming, small body | 500 | 33.82 / 70.70 / 83.58 | 33.83 / 70.74 / 83.60 | 16.4% | 28.3 MB | 0 / 0 |
| Streaming, 500 tokens | 10 | 6.97 / 8.09 / 9.55 | 5.44 / 1.38 / 10.81 | 133.1% | 0.0 MB | 0 / 0 |
| Streaming, 500 tokens | 100 | 12.90 / 13.10 / 14.66 | -34.49 / -34.88 / -34.60 | 35.2% | 0.0 MB | 0 / 0 |
| Streaming, 500 tokens | 500 | 14.23 / 21.00 / 189.56 | -20.09 / -11.53 / 99.74 | 18.0% | 14.5 MB | 0 / 0 |
| Streaming, 150 KB body | 10 | 65.01 / 61.87 / 61.47 | 65.51 / 72.01 / 134.19 | 196.0% | 0.0 MB | 0 / 0 |
| Streaming, 150 KB body | 100 | 260.98 / 378.44 / 398.04 | 297.93 / 395.21 / 477.27 | 74.1% | 132.7 MB | 0 / 0 |
| Streaming, 150 KB body | 500 | 677.42 / 2,360.72 / 2,629.52 | 367.00 / 2,018.38 / 2,284.93 | 22.4% | 40.3 MB | 286 / 148,862 |

<details><summary>Every concurrency level, with absolute latencies</summary>

| Store | Scenario | Streams | Rate per stream (req/s) | Requests (direct / gateway) | Direct TTFB p50 / p95 / p99 (ms) | Gateway TTFB p50 / p95 / p99 (ms) | Direct total p50 / p95 / p99 (ms) | Gateway total p50 / p95 / p99 (ms) | Gateway CPU | Gateway RSS |
|---|---|---:|---:|---:|---|---|---|---|---:|---:|
| memory | Non-streaming, small body | 1 | 4.00 | 80 / 80 | 103.00 / 104.66 / 105.11 | 105.55 / 107.88 / 108.65 | 103.05 / 104.75 / 105.16 | 106.06 / 108.33 / 110.96 | 2.7% | 123.9 MB |
| redis | Non-streaming, small body | 1 | 4.00 | 80 / 80 | 103.00 / 104.66 / 105.11 | 106.78 / 109.86 / 110.48 | 103.05 / 104.75 / 105.16 | 107.29 / 110.44 / 111.20 | 3.0% | 136.5 MB |
| memory | Non-streaming, small body | 10 | 4.00 | 320 / 320 | 103.66 / 105.25 / 106.03 | 108.80 / 114.26 / 117.66 | 103.68 / 105.27 / 106.11 | 109.10 / 114.46 / 117.94 | 9.8% | 127.6 MB |
| redis | Non-streaming, small body | 10 | 4.00 | 320 / 320 | 103.66 / 105.25 / 106.03 | 113.85 / 118.16 / 119.03 | 103.68 / 105.27 / 106.11 | 114.03 / 118.31 / 119.46 | 10.2% | 146.0 MB |
| memory | Non-streaming, small body | 16 | 4.00 | 320 / 320 | 103.84 / 105.03 / 105.20 | 108.35 / 114.58 / 117.15 | 103.86 / 105.04 / 105.22 | 108.53 / 114.64 / 117.19 | 10.7% | 131.8 MB |
| redis | Non-streaming, small body | 16 | 4.00 | 320 / 320 | 103.84 / 105.03 / 105.20 | 115.69 / 119.92 / 121.27 | 103.86 / 105.04 / 105.22 | 115.79 / 120.06 / 121.33 | 12.3% | 155.3 MB |
| memory | Non-streaming, small body | 64 | 4.00 | 1,280 / 1,280 | 104.32 / 112.40 / 115.11 | 121.33 / 130.88 / 135.35 | 104.33 / 112.41 / 115.12 | 121.39 / 130.94 / 135.39 | 21.0% | 159.4 MB |
| redis | Non-streaming, small body | 64 | 4.00 | 1,280 / 1,280 | 104.32 / 112.40 / 115.11 | 127.30 / 135.67 / 139.91 | 104.33 / 112.41 / 115.12 | 127.38 / 135.73 / 139.96 | 22.7% | 177.4 MB |
| memory | Non-streaming, small body | 100 | 4.00 | 2,000 / 2,000 | 104.20 / 107.67 / 109.73 | 111.20 / 126.07 / 130.98 | 104.20 / 107.68 / 109.74 | 111.23 / 126.10 / 131.01 | 29.9% | 166.9 MB |
| redis | Non-streaming, small body | 100 | 4.00 | 2,000 / 2,000 | 104.20 / 107.67 / 109.73 | 118.46 / 132.77 / 135.02 | 104.20 / 107.68 / 109.74 | 118.50 / 132.80 / 135.07 | 27.0% | 198.8 MB |
| memory | Non-streaming, small body | 256 | 4.00 | 5,120 / 5,120 | 104.80 / 110.66 / 116.64 | 116.76 / 132.70 / 155.82 | 104.80 / 110.66 / 116.64 | 116.78 / 132.73 / 155.85 | 51.0% | 286.2 MB |
| redis | Non-streaming, small body | 256 | 4.00 | 5,120 / 5,120 | 104.80 / 110.66 / 116.64 | 125.90 / 138.56 / 147.13 | 104.80 / 110.66 / 116.64 | 125.92 / 138.59 / 147.17 | 43.8% | 291.2 MB |
| memory | Non-streaming, small body | 500 | 4.00 | 10,256 / 10,000 | 103.81 / 113.60 / 116.89 | 120.22 / 135.66 / 156.29 | 103.82 / 113.60 / 116.89 | 120.24 / 135.69 / 156.30 | 76.4% | 256.5 MB |
| redis | Non-streaming, small body | 500 | 4.00 | 10,256 / 10,000 | 103.81 / 113.60 / 116.89 | 137.63 / 184.30 / 200.47 | 103.82 / 113.60 / 116.89 | 137.65 / 184.34 / 200.49 | 82.1% | 317.3 MB |
| memory | Streaming, 500 tokens | 1 | 1.00 | 20 / 20 | 103.26 / 104.24 / 104.56 | 107.06 / 115.20 / 122.91 | 728.09 / 738.57 / 739.70 | 733.03 / 741.36 / 745.11 | 4.3% | 182.9 MB |
| redis | Streaming, 500 tokens | 1 | 1.00 | 20 / 20 | 103.26 / 104.24 / 104.56 | 108.48 / 115.00 / 133.03 | 728.09 / 738.57 / 739.70 | 731.75 / 745.43 / 754.88 | 4.3% | 122.6 MB |
| memory | Streaming, 500 tokens | 10 | 1.00 | 200 / 200 | 103.72 / 104.75 / 104.85 | 108.12 / 111.58 / 113.90 | 725.63 / 741.24 / 743.17 | 728.05 / 740.58 / 741.61 | 12.9% | 150.2 MB |
| redis | Streaming, 500 tokens | 10 | 1.00 | 200 / 200 | 103.72 / 104.75 / 104.85 | 110.69 / 112.84 / 114.40 | 725.63 / 741.24 / 743.17 | 731.07 / 742.62 / 753.98 | 13.3% | 136.4 MB |
| memory | Streaming, 500 tokens | 16 | 1.00 | 304 / 304 | 103.82 / 105.05 / 105.43 | 109.86 / 113.23 / 113.98 | 715.50 / 757.56 / 761.53 | 708.98 / 744.63 / 751.53 | 17.3% | 145.5 MB |
| redis | Streaming, 500 tokens | 16 | 1.00 | 304 / 304 | 103.82 / 105.05 / 105.43 | 111.83 / 114.61 / 116.29 | 715.50 / 757.56 / 761.53 | 714.21 / 740.92 / 744.31 | 18.1% | 134.2 MB |
| memory | Streaming, 500 tokens | 64 | 1.00 | 320 / 320 | 105.38 / 111.30 / 111.39 | 121.24 / 128.27 / 130.13 | 716.23 / 734.77 / 735.96 | 721.34 / 756.60 / 757.65 | 30.8% | 154.5 MB |
| redis | Streaming, 500 tokens | 64 | 1.00 | 320 / 320 | 105.38 / 111.30 / 111.39 | 122.67 / 128.26 / 129.45 | 716.23 / 734.77 / 735.96 | 741.64 / 759.10 / 759.66 | 29.3% | 149.1 MB |
| memory | Streaming, 500 tokens | 100 | 1.00 | 500 / 500 | 104.90 / 110.48 / 111.40 | 116.29 / 123.10 / 124.51 | 728.35 / 741.84 / 744.94 | 693.33 / 700.22 / 700.78 | 34.3% | 151.0 MB |
| redis | Streaming, 500 tokens | 100 | 1.00 | 500 / 500 | 104.90 / 110.48 / 111.40 | 117.80 / 123.58 / 126.06 | 728.35 / 741.84 / 744.94 | 693.86 / 706.96 / 710.34 | 35.2% | 153.5 MB |
| memory | Streaming, 500 tokens | 256 | 1.00 | 1,344 / 1,280 | 105.37 / 116.16 / 116.67 | 113.86 / 128.14 / 132.03 | 742.93 / 754.30 / 756.64 | 675.26 / 690.89 / 695.93 | 61.5% | 154.2 MB |
| redis | Streaming, 500 tokens | 256 | 1.00 | 1,344 / 1,280 | 105.37 / 116.16 / 116.67 | 120.20 / 136.62 / 136.95 | 742.93 / 754.30 / 756.64 | 681.57 / 696.68 / 700.50 | 60.3% | 167.0 MB |
| memory | Streaming, 500 tokens | 500 | 1.00 | 2,616 / 2,564 | 104.72 / 113.42 / 116.67 | 114.06 / 127.12 / 293.65 | 758.98 / 782.26 / 787.24 | 742.15 / 761.66 / 867.63 | 86.1% | 170.5 MB |
| redis | Streaming, 500 tokens | 500 | 1.00 | 2,616 / 2,692 | 104.72 / 113.42 / 116.67 | 118.95 / 134.42 / 306.23 | 758.98 / 782.26 / 787.24 | 738.89 / 770.73 / 886.98 | 89.9% | 248.3 MB |
| memory | Streaming, 150 KB body | 1 | 1.00 | 20 / 20 | 107.08 / 108.50 / 108.57 | 117.92 / 120.69 / 121.50 | 731.00 / 735.44 / 738.31 | 742.29 / 752.44 / 756.23 | 4.4% | 184.7 MB |
| redis | Streaming, 150 KB body | 1 | 1.00 | 20 / 20 | 107.08 / 108.50 / 108.57 | 121.21 / 123.27 / 124.10 | 731.00 / 735.44 / 738.31 | 745.23 / 751.01 / 755.92 | 5.7% | 134.0 MB |
| memory | Streaming, 150 KB body | 10 | 1.00 | 200 / 200 | 111.28 / 118.82 / 120.79 | 171.28 / 175.89 / 176.85 | 721.67 / 736.46 / 741.58 | 779.00 / 795.06 / 797.99 | 18.1% | 191.7 MB |
| redis | Streaming, 150 KB body | 10 | 1.00 | 200 / 200 | 111.28 / 118.82 / 120.79 | 176.29 / 180.69 / 182.26 | 721.67 / 736.46 / 741.58 | 787.18 / 808.47 / 875.77 | 19.6% | 165.1 MB |
| memory | Streaming, 150 KB body | 16 | 1.00 | 304 / 304 | 112.98 / 123.41 / 125.32 | 201.61 / 209.59 / 210.89 | 707.31 / 742.24 / 746.39 | 795.19 / 832.09 / 850.44 | 25.9% | 192.0 MB |
| redis | Streaming, 150 KB body | 16 | 1.00 | 304 / 304 | 112.98 / 123.41 / 125.32 | 203.18 / 210.34 / 212.30 | 707.31 / 742.24 / 746.39 | 801.09 / 819.93 / 822.53 | 26.1% | 170.8 MB |
| memory | Streaming, 150 KB body | 64 | 1.00 | 320 / 320 | 139.16 / 164.92 / 171.03 | 318.68 / 405.53 / 421.35 | 736.65 / 768.55 / 777.64 | 904.44 / 1,109.83 / 1,160.64 | 57.0% | 234.3 MB |
| redis | Streaming, 150 KB body | 64 | 1.00 | 320 / 281 | 139.16 / 164.92 / 171.03 | 381.29 / 425.05 / 434.71 | 736.65 / 768.55 / 777.64 | 996.33 / 1,076.05 / 1,122.49 | 58.1% | 211.7 MB |
| memory | Streaming, 150 KB body | 100 | 1.00 | 500 / 457 | 138.07 / 162.87 / 169.53 | 408.06 / 473.52 / 556.04 | 710.07 / 746.81 / 753.94 | 965.89 / 1,178.90 / 1,198.98 | 75.5% | 232.3 MB |
| redis | Streaming, 150 KB body | 100 | 1.00 | 500 / 443 | 138.07 / 162.87 / 169.53 | 399.05 / 541.31 / 567.57 | 710.07 / 746.81 / 753.94 | 1,008.00 / 1,142.02 / 1,231.21 | 74.1% | 308.4 MB |
| memory | Streaming, 150 KB body | 256 | 1.00 | 1,243 / 810 | 158.43 / 192.12 / 193.43 | 529.47 / 1,776.76 / 2,700.46 | 796.10 / 866.74 / 870.44 | 1,089.86 / 2,353.74 / 3,348.26 | 115.9% | 317.5 MB |
| redis | Streaming, 150 KB body | 256 | 1.00 | 1,243 / 729 | 158.43 / 192.12 / 193.43 | 1,029.05 / 1,148.59 / 1,151.54 | 796.10 / 866.74 / 870.44 | 1,678.13 / 1,800.04 / 1,904.16 | 104.5% | 396.2 MB |
| memory | Streaming, 150 KB body | 500 | 1.00 | 2,200 / 745 | 131.03 / 210.99 / 287.78 | 1,359.14 / 2,406.49 / 2,409.08 | 1,003.14 / 1,133.77 / 1,241.25 | 1,917.86 / 3,189.78 / 3,271.86 | 111.0% | 428.2 MB |
| redis | Streaming, 150 KB body | 500 | 1.00 | 2,200 / 712 | 131.03 / 210.99 / 287.78 | 808.45 / 2,571.71 / 2,917.30 | 1,003.14 / 1,133.77 / 1,241.25 | 1,370.14 / 3,152.15 / 3,526.18 | 111.8% | 377.1 MB |

</details>

#### Budget correctness

The G4 proof scenario of spec 7.4: concurrent requests through the gateway against one enforced budget, each with an actual cost drawn (seeded) between 0 and its limits.

| Store | Estimator | Budget | Concurrent requests | Admitted | Rejected | Final spend | Max spent + reserved after any admit | Max overspend | Final spend minus settled costs | Reserved left |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| memory | worst-case | $1.00 | 1,000 | 87 | 913 | $0.954495 | $0.999637 | $0.000000 | 0 micro-USD | 0 micro-USD |
| redis | worst-case | $1.00 | 1,000 | 84 | 916 | $0.912042 | $0.999789 | $0.000000 | 0 micro-USD | 0 micro-USD |
| memory | session-aware | $1.00 | 1,000 | 87 | 913 | $0.952508 | $0.999688 | $0.000000 | 0 micro-USD | 0 micro-USD |
| redis | session-aware | $1.00 | 1,000 | 80 | 920 | $0.849739 | $0.999066 | $0.000000 | 0 micro-USD | 0 micro-USD |

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

#### Secret scan

Default rules on a 4.1 MiB synthetic coding-agent body: last-turn scan 86.7 MiB/s, full-body scan 48.3 MiB/s. False-positive corpus (source trees and lockfiles sent as tool results): 678 files, 6.7 MB, 0 block hits.

#### Replay throughput

1,000,000 synthetic trace records (the demo week repeated, 100.4 MB gzipped export) read, parsed and replayed against the demo's base and head policies in 44.5 s (22,448 records/s, fidelity 100.0%).

#### Estimator calibration

| Traces | Requests with usage | Bounds (bytes / context-window) | Bytes bound to billed input, min / median / max | Reservation to actual cost, min / median / max | Billed input above bound |
|---|---:|---:|---|---|---:|
| Demo traffic (mock provider, 4 bytes per token) | 3,647 | 3,647 / 0 | 4.04 / 5.44 / 66.37 | 12.70 / 32.55 / 544.76 | 0 |
| Live Claude Code 2.1.316, 2026-11-02 | 18 | 16 / 2 | 2.88 / 2.91 / 2.95 | 22.52 / 230.85 / 1,448.02 | 0 |
| Live Codex 0.166.0, 2026-11-02 | 3 | 1 / 2 | 5.03 / 5.03 / 5.03 | 68.07 / 493.65 / 719.10 | 0 |

Live rows come from the local live runs through tokenyard (spec 14.1) and are aggregates only.
<!-- BENCH:END -->
