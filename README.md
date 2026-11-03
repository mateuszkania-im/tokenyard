<!-- BENCH:START -->
Measured by `npm run bench` on Apple M2 Pro (12 cores, 16 GB, arm64), darwin 27.0.0, Node v22.14.0; autocannon 8.0.0, tsx 4.23.15, redis 7.4.12; commit `f6fb6cc`, run 2026-11-03T01:32:41.887Z. Every request goes to the mock provider on loopback; no real provider is called.

#### SLO targets (spec 12.1)

| SLI | Target | Measured | Result |
|---|---|---|---|
| Added TTFB p50 / p99, non-streaming, 10 streams, memory store | under 5 ms / under 25 ms | 7.31 ms / 69.24 ms | missed |
| Added TTFB p50 / p99, non-streaming, 100 streams, memory store | under 5 ms / under 25 ms | 7.91 ms / 23.98 ms | missed |
| Added TTFB p50 / p99, non-streaming, 500 streams, memory store | under 5 ms / under 25 ms | 19.07 ms / 44.86 ms | missed |
| Added TTFB p50 / p99, streaming 500 tokens, 10 streams, memory store | under 5 ms / under 25 ms | 5.49 ms / 20.8 ms | missed |
| Added TTFB p50 / p99, streaming 500 tokens, 100 streams, memory store | under 5 ms / under 25 ms | 10.99 ms / 12.53 ms | missed |
| Added TTFB p50 / p99, streaming 500 tokens, 500 streams, memory store | under 5 ms / under 25 ms | 9.47 ms / 144.66 ms | missed |
| Added TTFB p50 / p99, streaming 150 KB body, 10 streams, memory store | under 5 ms / under 25 ms | 59.76 ms / 59.35 ms | missed |
| Added TTFB p50 / p99, streaming 150 KB body, 100 streams, memory store | under 5 ms / under 25 ms | 267.71 ms / 383.31 ms | missed |
| Added TTFB p50 / p99, streaming 150 KB body, 500 streams, memory store | under 5 ms / under 25 ms | 1168.37 ms / 2129.25 ms | missed |
| Added TTFB p50 / p99, non-streaming, 10 streams, redis store | under 5 ms / under 25 ms | 10.24 ms / 13.05 ms | missed |
| Added TTFB p50 / p99, non-streaming, 100 streams, redis store | under 5 ms / under 25 ms | 15.57 ms / 32.76 ms | missed |
| Added TTFB p50 / p99, non-streaming, 500 streams, redis store | under 5 ms / under 25 ms | 32.35 ms / 81.91 ms | missed |
| Added TTFB p50 / p99, streaming 500 tokens, 10 streams, redis store | under 5 ms / under 25 ms | 7.36 ms / 9.69 ms | missed |
| Added TTFB p50 / p99, streaming 500 tokens, 100 streams, redis store | under 5 ms / under 25 ms | 12.98 ms / 15.67 ms | missed |
| Added TTFB p50 / p99, streaming 500 tokens, 500 streams, redis store | under 5 ms / under 25 ms | 15.24 ms / 135.03 ms | missed |
| Added TTFB p50 / p99, streaming 150 KB body, 10 streams, redis store | under 5 ms / under 25 ms | 64.21 ms / 64.14 ms | missed |
| Added TTFB p50 / p99, streaming 150 KB body, 100 streams, redis store | under 5 ms / under 25 ms | 283.83 ms / 341.31 ms | missed |
| Added TTFB p50 / p99, streaming 150 KB body, 500 streams, redis store | under 5 ms / under 25 ms | 661.7 ms / 2684.8 ms | missed |
| Gateway-attributable error rate | under 0.1% per month | not measured (a production SLI); overhead runs: 207021 errors beside 54313 answered requests through the gateway | not measured |
| Policy propagation, merge to all instances, p99 | under 60 s | not measured | not measured |
| Admitted spend above an enforced budget (worst-case estimator) | zero | $0 over 2 run(s) of 1,000 concurrent requests (memory, redis) | met |
| Conformance suite on the pinned Claude Code and Codex versions | 100% | not measured by the benchmark (docs/conformance.md) | not measured |
| Cache hit ratio through tokenyard versus direct, same session on the mock | equal | 95.65% versus 95.65% | met |
| Replay of 1,000,000 trace records | under 60 s on a CI runner | 42.5 s on the machine above (not a CI runner) | met |

#### Gateway overhead

autocannon drives each scenario at the mock provider directly and through the gateway (both in their own processes, loopback); the mock answers after a fixed 100 ms time to first token and streams 500 tokens at 1000 tokens/s. Each connection is one stream with a fixed request rate below what it can complete directly; latencies are corrected for coordinated omission with that intended interval. Added time is the gateway percentile minus the direct percentile; CPU and RSS are the gateway process's; RSS per 100 streams is its peak growth during the run above its size just before it, scaled to 100 streams. The gateway runs examples/policy with every budget level enforced at a limit the load never reaches, no rate limits, guardrails on, traces written and metrics kept.

Errors count non-2xx answers and socket errors. autocannon reconnects at once after a connection reset, so a saturated server shows many socket errors per stream.

Memory store:

| Scenario | Streams | Added TTFB p50 / p95 / p99 (ms) | Added total p50 / p95 / p99 (ms) | Gateway CPU per 100 streams | Gateway RSS per 100 streams | Errors (direct / gateway) |
|---|---:|---|---|---:|---:|---:|
| Non-streaming, small body | 10 | 7.31 / 15.08 / 69.24 | 7.45 / 15.10 / 69.34 | 104.8% | 48.1 MB | 0 / 0 |
| Non-streaming, small body | 100 | 7.91 / 19.44 / 23.98 | 7.95 / 19.49 / 24.02 | 28.8% | 5.6 MB | 0 / 0 |
| Non-streaming, small body | 500 | 19.07 / 33.88 / 44.86 | 19.10 / 33.91 / 45.14 | 15.4% | 36.3 MB | 0 / 0 |
| Streaming, 500 tokens | 10 | 5.49 / 9.40 / 20.80 | 2.62 / 10.36 / 25.81 | 130.4% | 145.9 MB | 0 / 0 |
| Streaming, 500 tokens | 100 | 10.99 / 12.75 / 12.53 | -50.02 / -62.00 / -61.21 | 34.6% | 9.2 MB | 0 / 0 |
| Streaming, 500 tokens | 500 | 9.47 / 15.75 / 144.66 | -34.22 / -32.05 / 75.79 | 15.8% | 15.9 MB | 0 / 0 |
| Streaming, 150 KB body | 10 | 59.76 / 59.01 / 59.35 | 45.31 / 58.59 / 51.36 | 187.6% | 445.3 MB | 0 / 0 |
| Streaming, 150 KB body | 100 | 267.71 / 298.64 / 383.31 | 248.59 / 432.40 / 486.28 | 80.0% | 152.5 MB | 0 / 0 |
| Streaming, 150 KB body | 500 | 1,168.37 / 2,152.17 / 2,129.25 | 926.80 / 1,937.23 / 1,936.81 | 21.9% | 27.8 MB | 1,395 / 24,613 |

Redis store:

| Scenario | Streams | Added TTFB p50 / p95 / p99 (ms) | Added total p50 / p95 / p99 (ms) | Gateway CPU per 100 streams | Gateway RSS per 100 streams | Errors (direct / gateway) |
|---|---:|---|---|---:|---:|---:|
| Non-streaming, small body | 10 | 10.24 / 12.72 / 13.05 | 10.40 / 12.83 / 13.70 | 97.5% | 153.4 MB | 0 / 0 |
| Non-streaming, small body | 100 | 15.57 / 23.49 / 32.76 | 15.60 / 23.54 / 32.81 | 29.6% | 21.2 MB | 0 / 0 |
| Non-streaming, small body | 500 | 32.35 / 77.03 / 81.91 | 32.37 / 77.06 / 81.94 | 15.8% | 34.3 MB | 0 / 0 |
| Streaming, 500 tokens | 10 | 7.36 / 8.97 / 9.69 | 11.85 / 5.22 / 9.52 | 130.0% | 73.3 MB | 0 / 0 |
| Streaming, 500 tokens | 100 | 12.98 / 14.17 / 15.67 | -47.01 / -58.80 / -58.90 | 35.6% | 3.2 MB | 0 / 0 |
| Streaming, 500 tokens | 500 | 15.24 / 23.36 / 135.03 | -19.98 / -21.86 / 71.14 | 17.8% | 24.7 MB | 0 / 0 |
| Streaming, 150 KB body | 10 | 64.21 / 63.08 / 64.14 | 49.95 / 53.99 / 49.93 | 195.3% | 313.8 MB | 0 / 0 |
| Streaming, 150 KB body | 100 | 283.83 / 336.21 / 341.31 | 353.41 / 408.70 / 436.42 | 71.9% | 8.5 MB | 0 / 0 |
| Streaming, 150 KB body | 500 | 661.70 / 2,319.75 / 2,684.80 | 349.99 / 1,983.65 / 2,708.73 | 21.8% | 18.7 MB | 1,395 / 145,918 |

<details><summary>Every concurrency level, with absolute latencies</summary>

| Store | Scenario | Streams | Rate per stream (req/s) | Requests (direct / gateway) | Direct TTFB p50 / p95 / p99 (ms) | Gateway TTFB p50 / p95 / p99 (ms) | Direct total p50 / p95 / p99 (ms) | Gateway total p50 / p95 / p99 (ms) | Gateway CPU | Gateway RSS |
|---|---|---:|---:|---:|---|---|---|---|---:|---:|
| memory | Non-streaming, small body | 1 | 4.00 | 80 / 80 | 103.45 / 105.04 / 108.16 | 106.06 / 107.58 / 109.00 | 103.50 / 105.11 / 108.23 | 106.57 / 108.54 / 110.01 | 3.0% | 123.2 MB |
| redis | Non-streaming, small body | 1 | 4.00 | 80 / 80 | 103.45 / 105.04 / 108.16 | 107.15 / 110.94 / 113.08 | 103.50 / 105.11 / 108.23 | 107.71 / 111.53 / 113.67 | 3.5% | 136.1 MB |
| memory | Non-streaming, small body | 10 | 4.00 | 320 / 320 | 103.97 / 105.76 / 106.89 | 111.28 / 120.84 / 176.13 | 104.00 / 105.77 / 106.94 | 111.45 / 120.87 / 176.28 | 10.5% | 128.0 MB |
| redis | Non-streaming, small body | 10 | 4.00 | 320 / 320 | 103.97 / 105.76 / 106.89 | 114.21 / 118.48 / 119.94 | 104.00 / 105.77 / 106.94 | 114.40 / 118.60 / 120.64 | 9.8% | 140.8 MB |
| memory | Non-streaming, small body | 16 | 4.00 | 320 / 320 | 103.86 / 106.24 / 106.85 | 112.04 / 119.77 / 121.84 | 103.88 / 106.25 / 106.86 | 112.16 / 119.85 / 121.92 | 13.4% | 132.7 MB |
| redis | Non-streaming, small body | 16 | 4.00 | 320 / 320 | 103.86 / 106.24 / 106.85 | 115.97 / 120.99 / 122.22 | 103.88 / 106.25 / 106.86 | 116.05 / 121.16 / 122.44 | 12.6% | 146.9 MB |
| memory | Non-streaming, small body | 64 | 4.00 | 1,280 / 1,280 | 104.47 / 117.42 / 124.38 | 119.20 / 130.81 / 136.56 | 104.48 / 117.43 / 124.38 | 119.25 / 130.89 / 136.61 | 20.3% | 161.0 MB |
| redis | Non-streaming, small body | 64 | 4.00 | 1,280 / 1,280 | 104.47 / 117.42 / 124.38 | 129.23 / 187.42 / 209.21 | 104.48 / 117.43 / 124.38 | 129.31 / 187.54 / 209.22 | 23.5% | 170.0 MB |
| memory | Non-streaming, small body | 100 | 4.00 | 2,000 / 2,000 | 104.09 / 107.43 / 108.70 | 112.00 / 126.87 / 132.68 | 104.10 / 107.44 / 108.71 | 112.05 / 126.93 / 132.73 | 28.8% | 166.6 MB |
| redis | Non-streaming, small body | 100 | 4.00 | 2,000 / 2,000 | 104.09 / 107.43 / 108.70 | 119.66 / 130.92 / 141.46 | 104.10 / 107.44 / 108.71 | 119.70 / 130.98 / 141.52 | 29.6% | 189.5 MB |
| memory | Non-streaming, small body | 256 | 4.00 | 5,376 / 5,376 | 104.65 / 110.45 / 114.45 | 117.06 / 131.05 / 138.66 | 104.65 / 110.46 / 114.45 | 117.07 / 131.10 / 138.66 | 40.1% | 298.5 MB |
| redis | Non-streaming, small body | 256 | 4.00 | 5,376 / 5,120 | 104.65 / 110.45 / 114.45 | 123.57 / 137.88 / 166.87 | 104.65 / 110.46 / 114.45 | 123.61 / 137.92 / 166.89 | 52.7% | 253.6 MB |
| memory | Non-streaming, small body | 500 | 4.00 | 10,512 / 10,000 | 105.14 / 111.82 / 114.52 | 124.21 / 145.70 / 159.38 | 105.14 / 111.82 / 114.52 | 124.24 / 145.73 / 159.66 | 77.2% | 290.9 MB |
| redis | Non-streaming, small body | 500 | 4.00 | 10,512 / 10,000 | 105.14 / 111.82 / 114.52 | 137.49 / 188.85 / 196.43 | 105.14 / 111.82 / 114.52 | 137.51 / 188.88 / 196.46 | 78.8% | 321.1 MB |
| memory | Streaming, 500 tokens | 1 | 1.00 | 20 / 20 | 103.41 / 104.30 / 104.63 | 107.17 / 116.28 / 121.43 | 726.93 / 739.25 / 745.36 | 732.84 / 782.82 / 809.42 | 4.6% | 117.2 MB |
| redis | Streaming, 500 tokens | 1 | 1.00 | 20 / 20 | 103.41 / 104.30 / 104.63 | 108.86 / 118.35 / 122.49 | 726.93 / 739.25 / 745.36 | 733.91 / 747.58 / 750.41 | 4.5% | 127.3 MB |
| memory | Streaming, 500 tokens | 10 | 1.00 | 200 / 200 | 103.69 / 105.13 / 106.39 | 109.18 / 114.53 / 127.19 | 725.38 / 739.33 / 740.49 | 728.00 / 749.69 / 766.30 | 13.0% | 131.8 MB |
| redis | Streaming, 500 tokens | 10 | 1.00 | 200 / 200 | 103.69 / 105.13 / 106.39 | 111.05 / 114.10 / 116.08 | 725.38 / 739.33 / 740.49 | 737.23 / 744.55 / 750.01 | 13.0% | 134.6 MB |
| memory | Streaming, 500 tokens | 16 | 1.00 | 304 / 304 | 103.70 / 105.49 / 106.39 | 110.04 / 114.12 / 115.11 | 716.54 / 791.82 / 798.03 | 722.63 / 740.71 / 747.04 | 18.4% | 130.6 MB |
| redis | Streaming, 500 tokens | 16 | 1.00 | 304 / 304 | 103.70 / 105.49 / 106.39 | 112.48 / 115.70 / 116.12 | 716.54 / 791.82 / 798.03 | 724.56 / 745.21 / 745.90 | 18.0% | 137.8 MB |
| memory | Streaming, 500 tokens | 64 | 1.00 | 320 / 320 | 105.76 / 109.60 / 109.96 | 120.59 / 126.73 / 128.42 | 722.40 / 728.41 / 729.14 | 717.28 / 762.12 / 762.35 | 30.3% | 145.9 MB |
| redis | Streaming, 500 tokens | 64 | 1.00 | 320 / 320 | 105.76 / 109.60 / 109.96 | 121.57 / 128.61 / 129.47 | 722.40 / 728.41 / 729.14 | 714.11 / 730.56 / 730.96 | 31.7% | 155.8 MB |
| memory | Streaming, 500 tokens | 100 | 1.00 | 500 / 500 | 105.28 / 109.65 / 110.38 | 116.27 / 122.40 / 122.91 | 737.81 / 757.20 / 758.98 | 687.79 / 695.20 / 697.77 | 34.6% | 155.1 MB |
| redis | Streaming, 500 tokens | 100 | 1.00 | 500 / 500 | 105.28 / 109.65 / 110.38 | 118.26 / 123.82 / 126.05 | 737.81 / 757.20 / 758.98 | 690.80 / 698.40 / 700.08 | 35.6% | 159.0 MB |
| memory | Streaming, 500 tokens | 256 | 1.00 | 1,280 / 1,280 | 106.42 / 113.87 / 116.40 | 114.97 / 125.00 / 129.96 | 749.72 / 757.42 / 758.56 | 677.39 / 685.82 / 689.21 | 62.0% | 174.1 MB |
| redis | Streaming, 500 tokens | 256 | 1.00 | 1,280 / 1,344 | 106.42 / 113.87 / 116.40 | 118.72 / 126.23 / 131.20 | 749.72 / 757.42 / 758.56 | 682.27 / 704.09 / 750.85 | 55.7% | 178.4 MB |
| memory | Streaming, 500 tokens | 500 | 1.00 | 2,616 / 2,564 | 104.79 / 115.56 / 124.98 | 114.26 / 131.31 / 269.64 | 764.55 / 780.01 / 786.89 | 730.33 / 747.96 / 862.68 | 79.0% | 253.5 MB |
| redis | Streaming, 500 tokens | 500 | 1.00 | 2,616 / 2,564 | 104.79 / 115.56 / 124.98 | 120.03 / 138.92 / 260.01 | 764.55 / 780.01 / 786.89 | 744.57 / 758.15 / 858.03 | 89.2% | 240.0 MB |
| memory | Streaming, 150 KB body | 1 | 1.00 | 20 / 20 | 105.56 / 109.07 / 119.09 | 118.09 / 122.43 / 122.62 | 735.29 / 751.57 / 768.35 | 743.38 / 748.88 / 750.67 | 5.8% | 138.6 MB |
| redis | Streaming, 150 KB body | 1 | 1.00 | 20 / 20 | 105.56 / 109.07 / 119.09 | 121.93 / 125.83 / 125.84 | 735.29 / 751.57 / 768.35 | 748.82 / 762.43 / 772.08 | 6.0% | 133.7 MB |
| memory | Streaming, 150 KB body | 10 | 1.00 | 200 / 200 | 111.74 / 118.80 / 120.39 | 171.50 / 177.81 / 179.74 | 731.87 / 747.52 / 755.69 | 777.18 / 806.11 / 807.05 | 18.8% | 163.6 MB |
| redis | Streaming, 150 KB body | 10 | 1.00 | 200 / 200 | 111.74 / 118.80 / 120.39 | 175.95 / 181.88 / 184.53 | 731.87 / 747.52 / 755.69 | 781.82 / 801.51 / 805.62 | 19.5% | 158.9 MB |
| memory | Streaming, 150 KB body | 16 | 1.00 | 304 / 304 | 114.65 / 124.58 / 126.63 | 200.07 / 205.37 / 206.64 | 726.84 / 755.72 / 768.51 | 781.29 / 823.04 / 826.91 | 25.9% | 167.9 MB |
| redis | Streaming, 150 KB body | 16 | 1.00 | 304 / 304 | 114.65 / 124.58 / 126.63 | 203.96 / 214.51 / 217.44 | 726.84 / 755.72 / 768.51 | 804.91 / 829.28 / 836.73 | 26.5% | 178.1 MB |
| memory | Streaming, 150 KB body | 64 | 1.00 | 320 / 283 | 133.38 / 164.61 / 171.72 | 305.23 / 402.13 / 415.75 | 728.59 / 765.51 / 779.80 | 896.07 / 1,062.36 / 1,134.30 | 58.1% | 237.5 MB |
| redis | Streaming, 150 KB body | 64 | 1.00 | 320 / 308 | 133.38 / 164.61 / 171.72 | 362.70 / 434.61 / 443.31 | 728.59 / 765.51 / 779.80 | 965.22 / 1,102.95 / 1,242.95 | 58.9% | 259.8 MB |
| memory | Streaming, 150 KB body | 100 | 1.00 | 500 / 434 | 137.75 / 164.29 / 171.31 | 405.46 / 462.93 / 554.62 | 713.08 / 739.01 / 745.61 | 961.67 / 1,171.41 / 1,231.89 | 80.0% | 334.4 MB |
| redis | Streaming, 150 KB body | 100 | 1.00 | 500 / 415 | 137.75 / 164.29 / 171.31 | 421.58 / 500.50 / 512.62 | 713.08 / 739.01 / 745.61 | 1,066.49 / 1,147.71 / 1,182.03 | 71.9% | 267.2 MB |
| memory | Streaming, 150 KB body | 256 | 1.00 | 1,272 / 770 | 154.87 / 181.37 / 183.42 | 884.56 / 1,096.81 / 1,146.76 | 791.12 / 855.87 / 859.15 | 1,335.50 / 1,725.55 / 1,751.68 | 112.2% | 318.8 MB |
| redis | Streaming, 150 KB body | 256 | 1.00 | 1,272 / 656 | 154.87 / 181.37 / 183.42 | 1,081.87 / 1,250.50 / 1,258.49 | 791.12 / 855.87 / 859.15 | 1,650.47 / 1,962.61 / 2,011.08 | 100.9% | 392.8 MB |
| memory | Streaming, 150 KB body | 500 | 1.00 | 1,968 / 752 | 133.15 / 204.73 / 230.34 | 1,301.52 / 2,356.90 / 2,359.59 | 1,024.26 / 1,119.05 / 1,173.58 | 1,951.06 / 3,056.28 / 3,110.39 | 109.5% | 412.8 MB |
| redis | Streaming, 150 KB body | 500 | 1.00 | 1,968 / 711 | 133.15 / 204.73 / 230.34 | 794.85 / 2,524.48 / 2,915.14 | 1,024.26 / 1,119.05 / 1,173.58 | 1,374.25 / 3,102.70 / 3,882.31 | 108.9% | 375.6 MB |

</details>

#### Budget correctness

The G4 proof scenario of spec 7.4: concurrent requests through the gateway against one enforced budget, each with an actual cost drawn (seeded) between 0 and its limits.

| Store | Estimator | Budget | Concurrent requests | Admitted | Rejected | Final spend | Max spent + reserved after any admit | Max overspend | Final spend minus settled costs | Reserved left |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| memory | worst-case | $1.00 | 1,000 | 85 | 915 | $0.958430 | $0.999652 | $0.000000 | 0 micro-USD | 0 micro-USD |
| redis | worst-case | $1.00 | 1,000 | 82 | 918 | $0.939482 | $0.999394 | $0.000000 | 0 micro-USD | 0 micro-USD |
| memory | session-aware | $1.00 | 1,000 | 91 | 909 | $0.958889 | $0.998857 | $0.000000 | 0 micro-USD | 0 micro-USD |
| redis | session-aware | $1.00 | 1,000 | 80 | 920 | $0.818798 | $0.999790 | $0.000000 | 0 micro-USD | 0 micro-USD |

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

Default rules on a 4.1 MiB synthetic coding-agent body: last-turn scan 89.1 MiB/s, full-body scan 48.1 MiB/s. False-positive corpus (source trees and lockfiles sent as tool results): 683 files, 6.7 MB, 0 block hits.

#### Replay throughput

1,000,000 synthetic trace records (the demo week repeated, 100.4 MB gzipped export) read, parsed and replayed against the demo's base and head policies in 42.5 s (23,555 records/s, fidelity 100.0%).

#### Estimator calibration

| Traces | Requests with usage | Bounds (bytes / context-window) | Bytes bound to billed input, min / median / max | Reservation to actual cost, min / median / max | Billed input above bound |
|---|---:|---:|---|---|---:|
| Demo traffic (mock provider, 4 bytes per token) | 3,647 | 3,647 / 0 | 4.04 / 5.44 / 66.37 | 12.70 / 32.55 / 544.76 | 0 |
| Live Claude Code 2.1.316, 2026-11-02 | 18 | 16 / 2 | 2.88 / 2.91 / 2.95 | 22.52 / 230.85 / 1,448.02 | 0 |
| Live Codex 0.166.0, 2026-11-02 | 3 | 1 / 2 | 5.03 / 5.03 / 5.03 | 68.07 / 493.65 / 719.10 | 0 |

Live rows come from the local live runs through tokenyard (spec 14.1) and are aggregates only.
<!-- BENCH:END -->
