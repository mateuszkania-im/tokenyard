# Chaos and failure tests (V3)

The chaos suite drives the real gateway (`createGateway`, raw `node:http`, undici upstream, the memory or the Redis
counter store) on loopback through scripted mock upstreams and misbehaving clients. No real provider is called.

```sh
npm test                 # includes the fast chaos cases (test/chaos, a few seconds)
npm run test:chaos       # all of test/chaos: the fast cases, a long randomized run, keep-alive under load and the
                         # Redis outages (starts a loopback-only Redis container with scripts/local-redis.mjs; about 2 minutes)
```

`npm run test:chaos` sets `TOKENYARD_CHAOS=1`, which turns on the long cases, and passes `REDIS_URL` and
`REDIS_CONTAINER`, which turn on the Redis cases. `TOKENYARD_CHAOS_SEED` picks the seed of the 120-request mixed case,
`TOKENYARD_CHAOS_KA_SECONDS` the length of each keep-alive load run (default 40).

## Invariants

Every scenario ends with the same check (`checkInvariants` in `test/chaos/harness.ts`):

1. **Exactly one trace line per request the gateway received.** The ids the gateway handed out and the ids of the trace
   lines are the same set, with no duplicate. A request whose client got an answer, or that reached a provider, has
   exactly one line; a client that left before its request reached the gateway has none.
2. **A correct charge.** Every line with a reservation carries `chargedMicroUsd`; settled by the request it equals the
   settled cost, settled by the sweeper it equals the reservation.
3. **Charged at least what the provider billed.** The mock bills the whole generation of every attempt that started
   answering 200, whether or not the client saw it end; the line's charge is never below the sum.
4. **Fallback only before the first byte.** Every attempt but the last answered a retryable status in full; an attempt
   that failed after the body was sent is the last one; the client only ever sees the last attempt's answer.
5. **Nothing held.** No open reservation, deadline entry or stream slot in the store, nothing reserved on any budget key
   (memory store: after settle; Redis: after a sweep).
6. **No unhandled rejection** in the process, and **the gateway still serves** a request afterwards.

The Redis cases check the store with their own client: no `res` key, empty deadline sets, no stream count above zero,
nothing reserved on a budget key, and the budget's spent compared with the trace lines.

## Scenarios and results

All rows pass on the final commit of V3 (macOS, Node 22.14, Redis 7 in Docker Desktop). Findings are in the next
section.

| # | Scenario | File | Result |
|---|---|---|---|
| 1 | Provider 500, 502, 503, 529 before headers | provider.test.ts | fallback to the backup before any byte, settled at the actual cost |
| 1 | Every provider 5xx | provider.test.ts | last 5xx forwarded unchanged, nothing billed or held |
| 1 | Retry budget at the example 10% | provider.test.ts | fallbacks beyond the budget not tried, the 5xx reaches the client |
| 1 | Drop right after 200 headers, streaming and not | provider.test.ts | no fallback, charged at the reservation |
| 1 | Mid-stream drops at 40 random byte offsets | provider.test.ts | client gets exactly the bytes sent, never a second provider, charged at the reservation |
| 1 | Slow headers past the request deadline | provider.test.ts | 504, upstream aborted, charged at the reservation |
| 1 | A stream still running at the request deadline | provider.test.ts | cut, charged at the reservation |
| 1 | Connection refused on the primary | provider.test.ts | free fallback to the backup (2 attempts) |
| 1 | DNS failure (`.invalid` host) on the primary | provider.test.ts | free fallback |
| 1 | Both providers unreachable | provider.test.ts | 502, settled at 0 |
| 1 | TLS-like reset once the request arrived (socket destroyed) | provider.test.ts | 502, no fallback, charged at the reservation |
| 1 | Breaker: 529 past the ratio | provider.test.ts | provider breaker opens; later requests go to the backup without touching the primary |
| 1 | Breaker: spend-cap 429 | provider.test.ts | only that credential's breaker opens; the capped credential is tried once |
| 2 | Client leaves before the body, mid-upload, after headers, mid-stream | client.test.ts | one line each, nothing held, upstream stopped |
| 2 | 120 requests, random client exits and mixed upstream behaviour | client.test.ts | invariants hold (12 seeds tried by hand) |
| 2 | Long: 20 seeds of 300 such requests, with resets (`test:chaos`) | client.test.ts | invariants hold |
| 2 | Slow consumer (paused reader) on a 64 MiB stream | client.test.ts | upstream paused by backpressure (no progress while paused, under 16 MiB written), gateway heap plus buffers grew under 32 MiB, the stream then completes and settles |
| 2 | Slow consumer that leaves while paused | client.test.ts | upstream aborted, charged at the reservation |
| 3 | Redis `docker pause` for 1.2 s under load | redis.test.ts | 177 requests: 120 answered 200, 57 refused 503 (budgets closed); the last ten after unpause all 200; nothing left after a sweep; budget spent equals, reservation by reservation, the actual cost (settled by its request, or a timed-out settle that landed after the unpause: 9 of them) or the estimate (swept: none), so a second charge of 21 micro-USD fails it; R11 latch and session markers still there |
| 3 | Redis connections killed and reconnects refused for 800 ms under load | redis.test.ts | 251 requests: 167 x 200, 84 x 503; 17 reservations left by failed settles swept at their estimate; budget spent equals the sum of the trace charges exactly (no double charge) |
| 4 | Policy file caught mid-write that still validates (budgets not written yet) | reload.test.ts | never activated (finding 2) |
| 4 | Empty policy file | reload.test.ts | old revision serves, one load error |
| 4 | Under load: in-place, empty and atomic writes of the policy directory, 300 requests | reload.test.ts | all 200, one line each, store clean |
| 4 | Under load: policy URL flapping (good, corrupted, 500, connection reset, other good bundle, truncated), 300 requests | reload.test.ts | all 200, the last good policy serves, load errors counted, store clean |
| 5 | Request on an idle keep-alive socket while the gateway is blocked across the idle close | keep-alive.test.ts | answered (finding 1) |
| 5 | Under load: 1.1 MB requests keep the gateway busy, 16 probe connections reuse sockets around the idle close (`test:chaos`, 40 s) | keep-alive.test.ts | separate client workers: 982 requests, 0 resets; one busy client worker (as the V2 soak client): 983 requests, 1 reset on a reused socket (see finding 1); both held to at most 0.5%, resets on reused sockets only |
| 6 | Body cap vs scan time | s-v3-1-scan-budget.test.ts | escape budget (finding 3) |
| 6 | 32 MiB of short strings, bare tokens or dense key matches; last turn and history; both routes | s-v3-3-scan-memory.test.ts | 413 `scan-budget`, nothing sent, loop held under 1 s, peak RSS under 400 MB (finding 4) |
| 6 | Bodies at and just over the value, run and match budgets | s-v3-3-scan-work-budget.test.ts | refused over, served at (finding 4) |

### Redis outage numbers in detail

During `docker pause` the connection stays open and every command waits, so admit times out after the admit deadline
and the request is refused with 503 (`failure.counterStoreDown.budgets: closed`). An admit that lands after its
deadline is released at once (settled at 0). A settle that timed out while paused was still queued on the connection
and runs when Redis comes back, with the actual cost; its trace line says `settledBy: sweeper` and charges the
reservation, because the gateway cannot know the late settle will land. In the run above 9 such lines charged
9,904,168 micro-USD in total while the store holds 2,773: the trace overstates, never understates (warm-up after a
restart would seed the larger number). With refused reconnects commands fail at once, the reservation stays in Redis,
the sweeper settles it at its estimate, and the store and the trace lines agree to the micro-USD.

## Findings

1. **ECONNRESET on reused keep-alive connections (V2's 4 unexplained resets): the gateway's fault, fixed.** Node closes
   an idle keep-alive socket when its timer fires (`keepAliveTimeout` plus Node's own 1 s). Timers run before the
   poll phase reads sockets, and a poll phase busy with other callbacks (the gateway scanning a large body) reads
   nothing that arrived after it fetched its events. A request the client had already sent on the idle socket was
   still unread when the socket was destroyed, and the kernel answered it with RST. Reproduced deterministically (a
   client in a worker thread, the gateway's loop blocked across the idle close: `ECONNRESET`) and under load (30 s:
   34 resets in 764 requests with separate client workers, 39 in 758 with one busy client; deferring the close by one
   turn of the loop only brought that to 29). Fix (`closeIdleWhenQuiet`, src/edge/server.ts): the idle close waits for
   a quiet turn of the event loop (a setImmediate back within 5 ms), retried every 20 ms while the loop is busy and
   forced after 2 s; any byte read since the timer fired cancels it. After: 0 resets in 982 and 999 requests with
   separate clients; with one busy client 0 and 1 in about 1,000 requests. That remaining reset is the client side
   of the HTTP/1.1 keep-alive race: a client whose own loop is busy sends on a socket before reading the server's
   close. No gateway can rule it out; a client that retries a request that failed on a reused connection before any
   response byte avoids it. Server timeouts reviewed: `keepAliveTimeout` 5 s (Node's default, kept; Node acts 1 s
   later), `headersTimeout` 60 s and `requestTimeout` 300 s (Node's defaults, kept: they bound a slow upload or a
   socket that sends a partial request after the idle close was cancelled). `readBody` never destroys a socket under
   the cap; over it the 413 answer closes the connection (`connection: close`) after discarding the rest.
2. **A policy file caught mid-write could become the active policy (Task 11 minor): fixed.** The loader reads the
   policy directory file by file; a prefix of policy.yaml that still validates (the budgets section not written yet)
   was activated and written as last-known-good, so the gateway briefly ran without budgets. A changed directory now
   activates only when a second read one settle interval later (the 250 ms watch debounce) finds the same bundle;
   otherwise another read follows, and a second read that fails (a file caught mid-write after the first read passed)
   counts as one more such pair. At start it retries up to 20 times; later, every 20 unstable pairs in a row count one
   policy load error and report the revision that keeps serving. A writer slower than the settle interval can
   still be caught; write policy files atomically (a temporary file and a rename, as `git checkout` and most editors
   do). Policy URLs are not affected: a bundle carries its own sha256 and a cut one does not parse.
3. **Body cap vs scan time (S-V3-1): escape budget.** Measured on 32 MiB bodies: plain text scans in 0.10 s on a
   coding-agent route and 0.17 s on a product route, but a body made of JSON escapes took 1.0 s (`A`) to 1.6 s
   (`\n`) and 1.9 to 2.9 s, because every escape is decoded on its own (about 0.1 us, 0.2 us on product routes). The
   cap stays at 32 MiB, Anthropic's documented request limit: lowering it would refuse large but ordinary requests
   (images). Instead a body with more than 1,048,576 escapes (counted over the whole body, as the scanner decodes it
   whole whenever a rule blocks) is refused with 413 `scan-budget`, `x-should-retry: false`, before the scan; counting
   stops one past the budget (15 ms on 32 MiB of escapes). JSON-encoded source code holds one escape per 16 to 30
   bytes, so the budget allows 16 to 30 MiB of it, more than any context window. A `\u` escape is now decoded without
   a Buffer allocation. The bound first stated here (at the budget 0.26 s on a coding-agent route, 0.74 s on a product
   route) was wrong: it held for escapes, not for the scan (finding 4).
4. **Scan work budget (S-V3-3, V3 review).** Escapes were one cost driver of several: parsing and the scan cost per
   JSON value and per regex match, not per byte. Without a single escape, 32 MiB of short strings (`"a",`) held the
   event loop for 2.1 to 5.4 s and 32 MiB of AWS-key-shaped values 2.9 to 4.9 s, both answered 200; 32 MiB of bare
   tokens (`1,`) grew the scanner's arrays past V8's limit, a 500 after 1.6 to 2.2 s with RSS 1.5 to 2.0 GB above
   the level before the request; JSON.parse alone took 2.5 s and 1.2 GB on 32 MiB of `{},`. Three budgets now hold,
   each refused with 413 `scan-budget`, `x-should-retry: false`, before any upstream byte:
   - **JSON values** (strings, keys, numbers, literals, objects, arrays): at most 1,048,576 per body, counted before
     JSON.parse, so the parser never allocates more. The bench's 31 MiB coding-agent body holds 76,000.
   - **Decoded runs** (the pieces the scanner joins: one or two per string, token and escape): at most 3,145,728 per
     scan, counted as each run is made. The bench body makes 1.8 Mi, a 1 M token context (about 4 MiB) under 0.6 Mi.
   - **Regex matches**, counted before entropy and checksum checks: at most 65,536 per scan. The false-positive
     corpus matches at most 108 times per file.

   The scanner's views keep their decoded text in one buffer and their runs in a typed array (16 bytes per run, about
   100 before), and the keyword prefilter stops at one hit per keyword (32 MiB of `@` was 32 Mi hits, 0.85 s per
   pass). Measured on 32 MiB minus 4 KiB (Apple silicon, Node 22, gateway and client in one process):

   | Body | Coding agent | Product |
   |---|---|---|
   | short strings, bare tokens (last turn or history) | 413, loop held at most 33 ms | 413, at most 24 ms |
   | AWS-key-shaped values (last turn or history) | 413, at most 0.18 s | 413, at most 0.18 s |
   | 1,048,000 strings `"\na"` (at the value, escape and run budgets) | 200, 0.33 s | 200, 0.57 s |
   | 64,000 distinct AWS keys, or 64,000 emails, in 32 MiB | 400 (secret), 0.36 s | 200, 0.55 to 0.60 s |
   | 1 Mi escapes in 32 MiB of text | 200, 0.23 s | 200, 0.48 s |
   | 32 MiB of whitespace between values | 200, 0.39 s | 200, 0.54 s |
   | 32 MiB of plain text | 200, 0.14 s | 200, 0.26 s |

   Peak RSS above the level before the request: at most 75 MB for every refused body (receiving it: chunks, then one
   Buffer) and at most 190 MB for any body within the budgets, against 1.5 to 2.2 GB before (short strings, bare tokens).

No other scenario found a fault: settlement, fallback, breaker scope, backpressure and fail-closed store handling held
under every case above.
