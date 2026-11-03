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
| 3 | Redis `docker pause` for 1.2 s under load | redis.test.ts | 171 requests: 116 answered 200, 55 refused 503 (budgets closed); the last ten after unpause all 200; nothing left after a sweep; R11 latch and session markers still there |
| 3 | Redis connections killed and reconnects refused for 800 ms under load | redis.test.ts | 251 requests: 167 x 200, 84 x 503; 17 reservations left by failed settles swept at their estimate; budget spent equals the sum of the trace charges exactly (no double charge) |
| 4 | Policy file caught mid-write that still validates (budgets not written yet) | reload.test.ts | never activated (finding 2) |
| 4 | Empty policy file | reload.test.ts | old revision serves, one load error |
| 4 | Under load: in-place, empty and atomic writes of the policy directory, 300 requests | reload.test.ts | all 200, one line each, store clean |
| 4 | Under load: policy URL flapping (good, corrupted, 500, connection reset, other good bundle, truncated), 300 requests | reload.test.ts | all 200, the last good policy serves, load errors counted, store clean |
| 5 | Request on an idle keep-alive socket while the gateway is blocked across the idle close | keep-alive.test.ts | answered (finding 1) |
| 5 | Under load: 1.1 MB requests keep the gateway busy, 16 probe connections reuse sockets around the idle close (`test:chaos`, 40 s) | keep-alive.test.ts | separate client workers: 982 requests, 0 resets; one busy client worker (as the V2 soak client): 983 requests, 1 reset on a reused socket (see finding 1) |
| 6 | Body cap vs scan time | s-v3-1-scan-budget.test.ts | escape budget (finding 3) |

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
   otherwise another read follows. At start it retries up to 20 times. A writer slower than the settle interval can
   still be caught; write policy files atomically (a temporary file and a rename, as `git checkout` and most editors
   do). Policy URLs are not affected: a bundle carries its own sha256 and a cut one does not parse.
3. **Body cap vs scan time (S-V3-1): escape budget.** Measured on 32 MiB bodies: plain text scans in 0.10 s on a
   coding-agent route and 0.17 s on a product route, but a body made of JSON escapes took 1.0 s (`A`) to 1.6 s
   (`\n`) and 1.9 to 2.9 s, because every escape is decoded on its own (about 0.1 us, 0.2 us on product routes). The
   cap stays at 32 MiB, Anthropic's documented request limit: lowering it would refuse large but ordinary requests
   (images). Instead a body with more than 1,048,576 escapes (counted over the whole body, as the scanner decodes it
   whole whenever a rule blocks) is refused with 413 `scan-budget`, `x-should-retry: false`, before the scan; counting
   stops one past the budget (15 ms on 32 MiB of escapes). At the budget a 32 MiB body scans in at most 0.26 s
   (coding agent) and 0.74 s (product), wherever the escapes sit (last turn, history, or spread over 2,000 turns).
   JSON-encoded source code holds one escape per 16 to 30 bytes, so the budget allows 16 to 30 MiB of it, more than
   any context window. A `\u` escape is now decoded without a Buffer allocation.

No other scenario found a fault: settlement, fallback, breaker scope, backpressure and fail-closed store handling held
under every case above.
