# Property tests and fuzzing

The V4 phase checks correctness under concurrency and hostile input with fast-check properties and fuzzers. Every
property and fuzzer listed below has a fixed seed, so the generated inputs are the same on every run. For the
in-process ones (the memory store, decide, the fuzzers) that makes the run deterministic, and a failure in CI
reproduces locally with the same command. The properties that drive a real gateway over sockets (`release`,
`replay-fidelity`) and the Redis runs (over a network connection) also depend on timing nobody controls (scheduling,
socket and timer order, the wall clock), so the same seed generates the same batches, but a timing-dependent failure
may not recur on every rerun or shrink the same way. They are part of the default suite (`npx vitest run`) with a
bounded number of runs; `npm run test:fuzz` runs them 20 times longer.

## How to run

| Command | What it runs |
|---|---|
| `npx vitest run` | Every property and fuzzer at its default size (a few seconds in total); Redis properties are skipped without `REDIS_URL` |
| `npm run test:redis` | The Redis store tests, including the two Redis properties below, against a throwaway Redis |
| `npm run test:fuzz` | Every property and fuzzer with 20 times the runs (`TOKENYARD_FUZZ=1`), Redis included, one file at a time; about two minutes |
| `TOKENYARD_FUZZ_SEED=<n> npm run test:fuzz` | The same with every seed replaced by `<n>`, to explore beyond the committed seeds |

Redis comes from `scripts/local-redis.mjs`: a `redis:7` container published on a random 127.0.0.1 port only, with a
random password, removed when the run ends. `REDIS_URL`, when set, is used instead. A failing property prints its
seed, the shrunk counterexample and its path; `TOKENYARD_FUZZ_SEED` with that seed generates the same inputs again
(for the real-gateway properties see the timing caveat above). Helpers:
`test/helpers/fuzz.ts`.

## Properties

| File | Seed | Property |
|---|---|---|
| `test/property/store.property.test.ts` | `0x570e`, `0x570f`, `0x570d` | Random sequences of admits (several budget levels, an audit level, a rate check, a stream slot, a session, taint, duplicate ids) and settles (actual up to the estimate, repeated settles): no enforced level ever has spent plus reserved above its limit; every amount is a non-negative safe integer; spent equals the sum settled on each level; after every reservation is settled nothing is reserved and every stream slot is free; a fractional, negative or unsafe settle throws and changes nothing. With Redis: the memory and Redis stores return the same admissions (retry-after aside) and the same counters for the same sequence. The generators reach every outcome (admitted, budget, rate, streams, taint, sessions, duplicate), asserted |
| `test/property/admit-concurrency.property.test.ts` | `0xc0c1`, `0xc0c2`, `0xc0c3` | Up to 80 admits in flight at once on one key, each with a new or known session (the S-V2-1 churn limit), the GCRA, the stream slot and a budget level: on the memory store and on Redis over one connection every admission equals a sequential model in issue order; settling in random order while a second batch races for the slots frees everything. Two Redis connections racing: never more admitted than the burst, the slots, the session allowance or the budget allow. The R11 latch read during concurrent writes is monotone |
| `test/property/release.property.test.ts` | `0x4e1e` | Batches of requests, each with its own upstream behaviour (answer, stream, stream cut, 5xx or 529 with fallback, reset, headers then cut, no headers before the request deadline, a stream still running at the deadline) and client behaviour (stays, leaves before the body, mid-upload, after the headers, after some bytes or milliseconds), through a real gateway: the V3 invariants (`test/chaos/harness.ts`) hold, so every reservation and slot is released on every outcome. It stops at the first failure without shrinking (`endOnFailure`): each run starts a real gateway, so shrinking would rerun dozens of batches whose timing differs anyway |
| `test/property/replay-fidelity.property.test.ts` | `0xf1de` | Random request mixes (four keys on three teams, allowed, refused and unpriced models, sessions under a churn limit, a secret then the same secret in history, expensive answers against a small team budget, slow answers holding the one stream slot, count_tokens) sent in racing waves through a real gateway that may restart between waves under the same instance id (a new process epoch); replaying the traces under the recording policy reproduces every decision (agreement 1). Every decision kind the policy can make is reached, asserted |
| `test/policy/decide.property.test.ts` | `0xdec1` to `0xdec3` | Same snapshot and input give the same plan and decision; no clock is read; the compiled policy is frozen all the way down (maps refuse writes); decide and resolve on deeply frozen inputs equal the unfrozen run, and their results share nothing mutable with the policy |

## Fuzzers

| File | Seed | Target |
|---|---|---|
| `test/fuzz/sse.fuzz.test.ts` | `0x55e1` to `0x55e3` | SSE parser: any chunk split, byte-at-a-time included, gives the events of the unsplit input, which match a whole-input reference; arbitrary bytes and arbitrary event data never throw, in the parser or the Anthropic and Responses usage accumulators. Long lines: `test/security/s-v4-1-sse-long-line.test.ts` |
| `test/fuzz/safe-yaml.fuzz.test.ts` | `0x9a71` to `0x9a73` | Policy YAML: hostile documents (prototype keys, anchors, aliases, merge keys, tags, directives) and mutations of the example policy give plain data or a `YamlError`, never another error; Object.prototype is never touched; an accepted document holds no alias node; alias bombs of any width and depth are refused fast |
| `test/fuzz/attribution.fuzz.test.ts` | `0xa771`, `0xa772` | Attribution headers: `readAttribution` returns only its fields, each null or printable ASCII of at most 128 characters, for any headers including `__proto__` and `constructor` names; raw HTTP requests with such names and arbitrary bytes through a gateway get a normal answer (or Node's 400) and bounded trace labels |
| `test/fuzz/anonymize.fuzz.test.ts` | `0xa401` to `0xa403` | `traces export --anonymize`: generated secrets, Unix and Windows paths, emails, hostnames, tokens and phrases in the fields a client or key file chooses (the file header lists them; deployment-chosen values and gateway enums are copied and not fuzzed) never survive into the anonymized record, nor any 12-character piece of them; a server tool type no provider documents, letters-only words included, is exported only as a pseudonym or `(invalid)`; pseudonyms are stable within one salt and differ across salts. Ingest side: `test/security/s-v4-3-server-tool-type-allowlist.test.ts` (`0x5a43`) |
| `test/fuzz/scanner.fuzz.test.ts` | `0x5ca1`, `0xb0d1`, `0xe5c1` | Secret scanner: a secret is found with the same rule, value HMAC and place however its characters are escaped (`\uXXXX`, `\/`) and however it is split over the text blocks of one message; body-shape finds a duplicate key at any depth whatever its escaping, and only then; the S-V3-1 escape count matches a reference; a body holding the escape budget in every turn scans within its time bound |

## Other seeded properties

Properties that sit next to the unit tests of their module also take a fixed seed through `fuzz(seed, runs)`, so they
generate the same inputs on every run and `TOKENYARD_FUZZ_SEED` replaces their seed too. They are not in the
`npm run test:fuzz` paths, so they run at their default size there as well.

| File | Seed | Property |
|---|---|---|
| `test/guardrails/scan.test.ts` | `5101` | `keywordsIn` finds exactly the keywords `String.includes` finds (the NUL-joined list collision is an explicit case in `test/guardrails/scan-views.test.ts`) |
| `test/guardrails/scan-differential.test.ts` | `5111` | The optimised scanner returns what the pre-V1 scanner returns |
| `test/limits/gcra.test.ts` | `5121` | Never more than burst plus elapsed over emission requests are allowed |
| `test/limits/estimator.test.ts` | `5131` to `5133` | An unpriced server tool blocks; usage within the bounds costs at most the reservation; the Responses worst case covers cache writes |
| `test/upstream/breaker.test.ts` | `5141`, `5142` | Breaker decisions match a whole-window reference, compaction included |
| `test/surfaces/walker-differential.test.ts` | `5151` to `5153` | The V1 JSON walkers, feature extraction and body-shape refusals match the pre-V1 references |
| `test/limits/budget-proof.test.ts` | `5161` | Memory store admit outcomes equal a sequential model applied in commit order |

## Found and fixed

- S-V4-1 (Medium): the SSE parser was quadratic in the length of a line delivered in small chunks, without a bound on
  a line or an event. Fixed; the cap counts UTF-8 bytes and a capped stream is marked in its trace
  (docs/security-review.md).
- S-V4-2 (Low): anonymized exports kept server tool types shaped like identifiers, so a lowercase token in
  `tools[].type` survived. Fixed, and narrowed by S-V4-3 (docs/security-review.md).
- S-V4-3 (Low, from the V4 review): raw traces kept any identifier-shaped server tool type and exports any lowercase
  word; the fuzz generator filtered exactly the shape the fix kept. Traces and exports now keep only documented types
  (docs/security-review.md).
- S-V4-4 (Medium, from the V4 fix review): exports copied the process epoch, a linkable id, verbatim; it is now
  re-keyed with the export salt (docs/security-review.md).
- Replay fidelity: a stream slot or reservation released in the same millisecond as a later admit of the same instance
  was replayed as released before it, so a recorded `streams` refusal replayed as forwarded. The gateway records
  `outcome.settleSeq` and replay orders settles against the admits of the same process by it (docs/replay-json.md).
  The V4 review found that this held an old release after a restart that reused the instance id; records now carry
  the process epoch `decision.seqEpoch`, and the fidelity property restarts the gateway between waves.

## Boundaries

- Anonymized exports keep values shaped like ids in two fields by design (B1): `features.model` and
  `outcome.upstreamModel` (a lowercase model-id shape) and `outcome.errorClass` and `midStreamError` (an error-code
  shape). The gateway writes a client's unpriced model name as `model-<hex>` at ingest, and error codes come from the
  upstream, so the anonymizer fuzz gives these fields only values outside those shapes.
- Replay orders admits and settles exactly within one process epoch of an instance. Across a restart and across
  instances sharing Redis the order is approximated from the clocks (README, Admit order); the Redis properties use one connection for the exact model and
  two connections only for the bounds.
