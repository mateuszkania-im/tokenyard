# Security review (Task 25)

Record of the adversarial review of tokenyard at the end of the build, the findings it produced, the tests that pin
each fix and what is knowingly left open. Date: 2026-11-03. Reviewed tree: branch `mvp` at 9752407; second pass against 90d7337; V7 retest against 266d686 (last section).

## Method

1. **Three independent reviewers**, each with fresh context and no access to the others' notes, each told to break one
   property and to write the attack as a failing test against mock upstreams (canary values only, no real keys):
   - A, budget bypass: any path that forwards without `admit` or settles below the actual bill (abort timings,
     duplicate ids, sweeper races, unknown model, server tools, Responses without `max_output_tokens`, header
     spoofing of session and request class, two instances).
   - B, leaks: provider key, OAuth token, `ty_` key or prompt text reaching a log, trace, error body, metric label,
     span, report, export or the npm tarball.
   - C, policy and CI: a policy pull request that runs code, reads traces or exfiltrates through the Action, a
     passthrough credential sent to a non-official host, YAML tricks, redirects on `--policy-url`, cross-tenant
     counters or traces.
2. **Triage.** The reviewers' probes were handed to one implementer, who ranked them (High, Medium, Low), merged
   duplicates (C4 is A1, C5 is B3, C7 overlaps A5) and kept a failing test for every accepted finding.
3. **Test-first fixes.** Each fix is its own commit, preceded by a failing regression test under `test/security/`
   (RED run recorded in the batch reports), and `bin/tokenyard.mjs` is rebuilt in every commit that changes `src/`.
   Three fix rounds followed independent review of the batches; they found five more issues (S25-1 to S25-5), listed
   below.
4. **Forwarded findings.** Every finding raised by the coordinator during the build (tasks 6 to 23) and every ruling
   attached to it got a dedicated test in `test/security/` in this batch (second table). Eleven of the new tests were
   re-checked by reverting the fix in a scratch worktree; see "Revert checks".
5. **Second pass.** Reviewer A is re-run against the fixes and the result is recorded in the last section.

Severity: High means a client can spend more than its budget allows, or a PR can change what the gate compares;
Medium means a leak of non-secret data, a bypass that needs a lenient provider parser, or a bypass of a control that
has a second layer; Low means hardening or a latent flaw with no current path.

## Findings of the three reviews

| Id | Area | Severity | Description | Regression test | Status | Commit |
|---|---|---|---|---|---|---|
| A1 | budget | High | `reserveOutputTokens` lowered the reservation but `max_tokens` was never capped in the body | `test/security/a1-reserve-output-tokens.test.ts` | fixed: lowers the reservation only when the cap is applied in the body; validation rule for header-selected routes | 2d04d11, a7a3f9f |
| A2 | budget | High | Any unpriced model was admitted on the codex route and charged the envelope estimate | `test/security/a2-unpriced-model.test.ts` | fixed: refused under enforced budgets; codex route lists its models | 98358c8 |
| A3 | budget | High | Client abort before `message_delta` charged `ceil(chars/4)` output tokens (thinking, CJK and server tool blocks bill far more) | `test/security/a3-abort-output-estimate.test.ts` | fixed: a Messages stream without final usage settles at the full reservation | 34ab0cd, 9c56fe3 |
| A4 | budget | High | Compaction iterations never charged (the bill is the sum of `usage.iterations`) | `test/security/a4-compaction-iterations.test.ts` | fixed: iterations summed, threshold compaction reserved for them | fa905fa |
| A5 | budget | Medium | Parser differentials: encoded bodies, BOM, duplicate top-level keys, unparsable bodies under enforced budgets | `test/security/a5-parser-differential.test.ts` | fixed: refused (400) before decide | b4c0e65 |
| A6 | budget | High | Failure after the body was delivered settled at 0, and chain fallback made two providers bill under one reservation | `test/security/a6-post-send-failure.test.ts` | fixed: settle at the reservation, no fallback once the body was sent | 56f8843 |
| A7 | budget | Medium | `inference_geo` taken from the request only; the response's value (1.1x) was ignored | `test/security/a7-inference-geo-response.test.ts` | fixed: settled with the geo the response reports | 37e4464 |
| A8 | budget | Medium | Sweeper freed the stream slot of a stream still running past the reservation deadline | `test/security/a8-request-deadline.test.ts` | fixed: total request deadline (18 min) below the 20 min reservation deadline; 504 before upstream headers | 15bbf11, 8a39c23 |
| A9 | budget | Low | R11 latch (bytes bound switched off after a violation) was per process | `test/security/a9-r11-latch-scope.test.ts` | fixed: latch lives in the counter store | 774adce |
| A10 | budget | Low (latent) | Duplicate admit id returned `admitted: true` without a reservation | `test/security/a10-duplicate-admit.test.ts` | fixed: duplicate id is refused | 9a3b037 |
| A11 | budget | Low | Live harness cap: stale-lock race let two harnesses run; a request in flight at a crash was never counted | `test/security/a11-live-cap.test.ts` | fixed: atomic lock takeover, write-ahead `reserved` lines counted by warm-up | 1f58e21, 1be06df, 4fdd86c, 900c780, 010d88e |
| B1 | leak | Medium | Client body strings (model, tool type, service tier, client version) copied into traces, spans and anonymized exports | `test/security/b1-client-text-in-traces.test.ts`, `b1r-model-pseudonym.test.ts` | fixed: bounded at ingest; an unpriced model name is a salted pseudonym; exports rebuilt field by field | 4f594b8, 43dfee5 |
| B2 | leak | Low | Upstream error bodies forwarded verbatim, including provider key reflection and account headers | `test/security/b2-upstream-echo.test.ts`, `b2r-encoded-error-body.test.ts` | fixed: key echoes redacted, account headers dropped, compressed errors replaced by tokenyard's own | 222c03d, 7a105e0 |
| B3 | leak | Low | Token-less loopback ops listener answered `/metrics` for any Host (DNS rebinding); same as C5 | `test/security/b3-ops-host.test.ts` | fixed: loopback Host only | c5f9332 |
| B4 | leak | Medium | `check:secrets` missed several key shapes, `.gz` and the npm tarball; no pre-commit hook | `test/security/b4-check-secrets.test.ts` | fixed: gateway rules, gunzip and tar walk, CI scans the packed tarball, hook scans staged blobs | 9b4fe33, 6dbf9da, a1c570b, a7d4947, 6986995 |
| B5 | leak | Low | Secret-valued CLI flags on argv | `test/security/b5-argv-secrets.test.ts` | fixed: environment or `--*-file` only | 33dafe7 |
| B6 | leak | Low | Trace files, exports and reports world-readable | `test/security/b6-private-files.test.ts` | fixed: 0600 in 0700 directories | fc18eb5 |
| B7 | leak | Low | `traces export --anonymize` fell back to the trace salt | `test/security/b7-export-salt.test.ts` | fixed: one-off salt, refused when equal to the trace salt | 33dafe7, 7bdf579 |
| B8 | leak | Medium | PII hits traced as an HMAC of the value, enumerable (PESEL recovered) | `test/security/b8-pii-value-hmac.test.ts` | fixed: no value HMAC for PII rules; guardrail salt derived per guardrail | daba176 |
| C1 | CI | Medium | Workflow-command injection from PR policy text into the Action's output | `test/security/c1-action-workflow-commands.test.ts` | fixed: single-line log output, legacy `##[` form broken, run wrapped in `::stop-commands::` | 32d8e4c, bcea1bc, d3ddfde |
| C2 | CI | Medium | Replay traces read from the PR working tree; no decompressed-size cap | `test/security/c2-action-traces-at-base.test.ts` | fixed: workspace traces read at the base commit in a PR, sha256 in the comment, caps of 1 GiB decompressed and 1 MiB per line | 86b6aa6, 9bc8b73 |
| C3 | CI | Low | The PR set its own `ci.failOn` gate | `test/security/c3-action-fail-on.test.ts` | fixed: stricter of base and head, comment says when the PR changes it | fa2d016 |
| C4 | budget | Medium | Same as A1 on a header-selected route | `test/security/a1-reserve-output-tokens.test.ts` | fixed with A1 | 2d04d11 |
| C5 | leak | Low | Same as B3 | `test/security/b3-ops-host.test.ts` | fixed with B3 | c5f9332 |
| C6 | leak | Low | Client `openai-organization` and `openai-project` headers forwarded in API mode | `test/security/b2-upstream-echo.test.ts` (C6 tests) | fixed: dropped | 222c03d |
| C7 | budget | Medium | Duplicate top-level keys: `JSON.parse` last wins, original bytes forwarded | `test/security/a5-parser-differential.test.ts` | fixed with A5 | b4c0e65 |
| C8 | policy | Low | YAML 1.1 directive accepted, key collisions after conversion, quadratic duplicate check | `test/security/c8-yaml-hardening.test.ts` | fixed: only `%YAML 1.2`, only core-schema tags (`!!binary`, `!!timestamp`, `!!set`, `!!omap`, `!!pairs` and custom tags refused), `__proto__` and `<<` checked on every pair, keys compared as property names in linear time, node cap, one parse per load | 0b04d82, e517d35 |
| C9 | CI | Low | Base-side git inherited `GIT_*` environment (replace refs) | `test/security/c9-base-git-env.test.ts` | fixed: environment built from scratch, replace objects off | dfab3f0 |
| C10 | policy | Low | Last-known-good checks its own sha256, which authenticates nothing | `test/security/c10-lkg-integrity-scope.test.ts` | documented: corruption detection only, plus owner and 0600 check; no MAC by ruling | 79f414a |
| C11 | CI | Medium | `policy replay --base main` preferred a directory named `main/` | `test/security/c11-cli-base-ref.test.ts` | fixed: `--base-ref` (git objects) and `--base-dir`; `--base` refuses a value that is both | 9a6bef7 |
| C12 | CI | Medium | Policy-replay workflow skippable through a committed symlink to the trusted path | `test/security/c12-workflow-trusted-checkout.test.ts` | fixed: guard before the trusted checkout, explicit check, no `hashFiles` skip | 111c4e8 |
| S25-1 | budget | Medium | Duplicate `max_tokens` on a capped route could pass the cap (found reviewing batch 25.1) | `test/security/a1-reserve-output-tokens.test.ts` (S25-1) | fixed | df302b9 |
| S25-2 | budget | High | Duplicate keys below the top level (message content, `cache_control`, `tool_choice`, Responses input items) were a parser differential | `test/security/s25-2-nested-duplicate-keys.test.ts` | fixed: linear any-depth scan, depth limit 128 | eb90f2f |
| S25-3 | leak | Medium | Unredacted tail of an upstream error body after the 64 KiB scan window | `test/security/s25-3-error-body-cap.test.ts` | fixed: body capped and fully redacted | ae18942 |
| S25-4 | leak | Medium | Unbounded regex over upstream bytes (ReDoS) | `test/security/s25-3-error-body-cap.test.ts` (S25-4) | fixed: linear masked-key scan | ae18942 |
| S25-5 | policy | Medium | The YAML node cap did not count mappings | `test/security/s25-5-yaml-node-cap-maps.test.ts` | fixed: every node counted (maps, sequences, pairs, scalars, aliases) | f2b52d5 |

## Findings forwarded by the coordinator during the build

Each has a dedicated test file added in Task 25.4 that asserts the specific attack (not a re-run of an older test).

| Id | Task | Area | Severity | Description | Regression test | Status | Commit |
|---|---|---|---|---|---|---|---|
| S6 | 6 | pricing | Medium | Table lookups resolved prototype keys (`__proto__`, `constructor`, `toString`), so cost failed open | `test/security/s6-prototype-key-lookup.test.ts` | fixed: own-property lookups | 2ce9aea |
| S7a | 7 | leak | Medium | `anonymizeRecord` left free-text attribution in clear | `test/security/s7a-anonymize-attribution.test.ts` | fixed: deny by default, rebuilt field by field | 278db3e |
| S7b | 7 | leak | Medium | Report renderers printed client-header attribution verbatim (terminal escapes, Markdown and HTML injection) | `test/security/s7b-renderer-injection.test.ts` | fixed: controls stripped, every renderer escapes | 278db3e, d7f2a17 |
| S10-1 | 10 | budget | Medium | Model rewrite must be byte-faithful and priced at the served model; coding-agent rewrites need `allowBodyRewrite` | `test/security/s10-1-rewrite-model.test.ts` | fixed | 9710e3a |
| S10-2 | 10 | authz | Medium | Header-derived route predicates granted access to models | `test/security/s10-2-header-route-authz.test.ts` | fixed: authorised by the header-free route | 9710e3a |
| S10-3 | 10 | budget | Medium | Server tools allowed unless listed by the route | `test/security/s10-3-server-tools-deny-by-default.test.ts` | fixed: deny by default | 9710e3a |
| S10-3b | 10 | budget | Medium | Tool search unpriced; unpriced server tools allowed under enforced budgets | `test/security/s10-3-server-tools-deny-by-default.test.ts` | fixed: tool search priced (no fee, 10 iterations), unpriced tools refused under enforced budgets | 702e766 |
| S10-4 | 10 | budget | Medium | Omitting the session or repo header dodged an enforced budget scoped to it | `test/security/s10-4-unattributed-budget-scope.test.ts` | fixed: charged to `(unattributed)` | 9710e3a |
| S10-5 | 10 | authz | Medium | A header-matched route's `rewriteModel` was not checked against the authorising route | `test/security/s10-5-rewrite-authz.test.ts` | fixed: both routes must allow the target; `E_REWRITE_NOT_AUTHORIZED` | 702e766 |
| S10-taint | 10 | authz | Low | Taint keys for sessions and keys shared one namespace | `test/security/s10-taint-namespace.test.ts` | held by construction: `s:` and `k:` prefixes, test added | 4072536 |
| S12-1 | 12 | availability | Medium | Breaker keyed by provider only: one tenant's spend-cap 429 opened it for everybody | `test/security/s12-1-per-credential-breaker.test.ts` | fixed: credential-scoped breaker, hash of a forwarded token | ac577a5 |
| S16-1 | 16 | guardrails | Medium | Scanner view missed non-string tokens, split key/value pairs and unparsable bodies | `test/security/s16-1-scanner-differential.test.ts` | fixed | 88abc50 |
| S16-2 | 16 | guardrails | Medium | Malformed body with `\u`-escaped secrets passed the raw-byte fallback | `test/security/s16-2-malformed-body-escapes.test.ts` | fixed: raw and decoded copies scanned | fbabc7f |
| S16-3 | 16 | guardrails | Medium | `quotedOnly` skipped JSON-number card and PESEL values | `test/security/s16-3-bare-numeric-pii.test.ts` | fixed: bare numeric tokens scanned, impossible forms skipped | 39b2f9b |
| S19-1 | 19 | CI | High | Base ref resolved through a path first: a PR directory named like the base ref set the base policy | `test/security/s19-action-base-policy.test.ts` | fixed: base is a git object at the event's base sha | 64aedf9 |
| S19-2 | 19 | CI | Medium | Sticky comment upsert matched any author's marker comment | `test/security/s19-action-base-policy.test.ts` | fixed: only the token identity's comments | 64aedf9 |
| S19-3 | 19 | CI | Medium | Base commit fell back to the ref input; git used cwd discovery (planted repository) | `test/security/s19-action-base-policy.test.ts` | fixed: event base sha only, explicit git directory | d7f2a17 |
| S19-4 | 19 | CI | Medium | Base-side path taken from the realpath of a PR-controlled directory | `test/security/s19-action-base-policy.test.ts` | fixed: configured path normalised, symlinks refused | d7f2a17 |
| S-FS-1 | 19 | filesystem | Medium | Policy directory or its ancestors could be symbolic links | `test/security/s-fs-1-safe-path.test.ts` | fixed: one safe-path helper for every user-controlled path; FIFOs refused | 9a3857d, 812c025 |
| S-FS-2 | 19 | filesystem | Medium | Root-owned link exception trusted link ownership alone | `test/security/s-fs-2-system-links.test.ts` | fixed: full OpenSSH `safe_path` rule | 99cc0e4 |
| S20-1 | 20 | budget | Medium | Non-standard `service_tier` priced as standard | `test/security/s20-1-service-tier.test.ts` | fixed: refused unless the model has tier prices; `auto` reserves at the highest tier; `default` is standard pricing (ledger 369); an absent or null `service_tier`, which OpenAI serves on the project's default tier, is reserved as `auto` (FR-M2, final review) | dbac3f6, `git log --grep FR-M2` |
| S20-2 | 20 | budget | Medium | Responses settlement without terminal usage under-charged | `test/security/s20-2-responses-settle-without-usage.test.ts` | fixed: settles at the reservation | dbac3f6 |
| S21-1 | 21 | leak | Medium | `/metrics` unauthenticated on the API port | `test/security/s21-1-metrics-exposure.test.ts` | fixed: separate ops listener, token off loopback | b3820c1 |
| S21-2 | 21 | leak | Medium | Metric labels from client-controlled values (cardinality, poisoning) | `test/security/s21-2-metric-label-cardinality.test.ts` | fixed: bounded label sets, series cap | b3820c1 |
| S23-1 | 23 | exposure | Medium | Bench Redis published on all interfaces without a password | `test/security/s23-1-local-redis-exposure.test.ts` | fixed: loopback, random port, `--requirepass`, one helper | 2c7e812 |
| S-V2-1 | V2 | availability | Medium | Every new client-chosen session id created a session budget key (audit levels too) living 30 days, with no bound but the rate limit: an authenticated client sending a new session id per request grew Redis (or the memory store's heap) by about 150 to 190 bytes per request for a month | `test/security/s-v2-1-session-churn.test.ts` (memory; Redis in `npm run test:redis`), `test/limits/store-contract.ts`, `test/policy/session-churn.test.ts` | fixed: session keys expire `sessions.idleTtlHours` (default 24) after their last admit; one key may start `sessions.newPerKeyPerHour` (default 1,000; service keys `sessions.newPerServiceKeyPerHour`, default 10,000; a key's own `maxNewSessionsPerHour` in keys.yaml overrides either) new sessions an hour, a GCRA checked inside admit before anything is written (taint sets included); over it 429 `session-churn` naming the limit, `x-should-retry: false`, traced | ba909f9, 152a5c8 |
| S-V3-1 | V3 | availability | Medium | One request could hold the event loop for 1.0 to 2.9 s of secret scan: a body up to the 32 MiB cap made of JSON escapes (`\n`, `\u0041`), each decoded on its own; escapes in earlier turns or outside `messages` counted as much as in the last turn, since history rules decode the whole body whenever a rule blocks | `test/security/s-v3-1-scan-budget.test.ts` | fixed: a body with more than 1,048,576 escapes (whole body) is refused with 413 `scan-budget`, `x-should-retry: false`, before the scan; the 32 MiB cap stays (docs/chaos.md). Corrected in V3 review: this bounded escapes only, not the scan, and the bound first stated here (0.26 s and 0.74 s at the budget) did not hold for bodies without escapes; see S-V3-3 for the scan's bound | 4ff5be1, ed93993 |
| S-V3-2 | V3 (Task 11) | integrity | Low | A policy.yaml caught mid-write that still validated (budgets section not yet written) was activated and stored as last-known-good, so the gateway briefly enforced no budget | `test/chaos/reload.test.ts` | fixed: a changed policy directory activates only when two reads one settle interval apart agree; a writer slower than that can still be caught, so write policy files atomically (README Limitations) | 14bb6b1 |
| S-V3-3 | V3 review | availability | Medium | The S-V3-1 escape budget left the scan's other cost drivers open: parsing and scanning cost per JSON value and per regex match, not per byte. Without one escape, 32 MiB of short strings (`"a",`) held the event loop for 2.1 to 5.4 s (RSS up to 2.2 GB), 32 MiB of AWS-key-shaped values 2.9 to 4.9 s, a product body of `@` 0.85 s per keyword pass, and 32 MiB of bare tokens (`1,`) grew the scanner's arrays past V8's limit: 500 after 1.6 to 2.2 s with RSS at 1.5 to 2.0 GB; JSON.parse alone took 2.5 s and 1.2 GB on 32 MiB of `{},` | `test/security/s-v3-3-scan-work-budget.test.ts`, `test/security/s-v3-3-scan-memory.test.ts`, `test/fuzz/scanner.fuzz.test.ts` | fixed: a body with more than 1,048,576 JSON values is refused before JSON.parse; the scan counts its decoded runs (cap 3,145,728 per scan) and regex matches (cap 65,536 per scan) as it makes them and stops at the first over its cap; each is 413 `scan-budget`, `x-should-retry: false`, nothing sent. The scanner's views hold decoded text in one buffer and runs in a typed array (16 bytes per run, was about 100), and the keyword prefilter stops at one hit per keyword. Measured on 32 MiB bodies (Apple M2 Pro, Node 22): bodies the budgets refuse before or during the scan (413) hold the loop at most 0.18 s and add at most 75 MB of RSS (the body itself); within every budget the cost is linear in the bytes, bounded by the 32 MiB cap (accepted, R-V3-6): the slowest answered bodies take 0.68 s on a coding-agent route and 1.24 s on a product route (one 32 MiB bare number; first stated as 0.39 s and 0.60 s, understated, V3 re-review), and bodies refused only after the scan, with 400 or with 413 when the raw and decoded scan of an unparsable or duplicate-key body reaches a budget, hold it up to 1.11 s on a coding-agent route and 2.19 s on a product route (32 MiB of private key header lines without an end line; 413 rows up to 1.36 s, docs/chaos.md). Peak RSS above the level before the request, measured in V5 for those rows (answered and refused after the scan) with the same 2 ms sampler: at most 142 MB for answered bodies (one 32 MiB bare number) and at most 134 MB for bodies refused after the scan, under the 190 MB stated for bodies within the budgets; the bench's 31 MiB agent body uses 58% of the run budget and 7% of the value budget (docs/chaos.md) | 89750b3 |
| S-V4-1 | V4 | availability | Medium | The SSE parser that reads every upstream stream for usage concatenated the unfinished line with each new chunk and rescanned it from its start: a long line in small chunks held the event loop for quadratic time (1 MiB in 64-byte chunks 20 s, 2 MiB 76 s), and a line or an event's data had no bound; a Responses `response.completed` event carries the whole response on one data line, so a long legitimate answer in small TCP segments was enough; found by the SSE fuzz | `test/security/s-v4-1-sse-long-line.test.ts`, `test/fuzz/sse.fuzz.test.ts` | fixed: each byte is scanned once (2 MiB in 64-byte chunks well under 1 s); a line or an event's data past 16 MiB (UTF-8 bytes) is dropped with its event, so its usage is missing and the request settles at the reservation; the trace marks such a stream `errorClass: sse_event_too_large` and `tokenyard_sse_events_dropped_total` counts the events (V4 review). 16 MiB per event, not the 32 MiB body cap: while an event is parsed a stream holds up to about three times it | d40d106 |
| S-V4-2 | V4 | privacy | Low | `traces export --anonymize` kept every server tool type shaped like an identifier (`[a-z0-9_]{1,64}`, the ingest bound of B1), so a lowercase token or hex secret a client put in `tools[].type` reached the export in clear; found by the anonymizer fuzz | `test/security/s-v4-2-export-tool-type.test.ts`, `test/fuzz/anonymize.fuzz.test.ts` | fixed: exports keep only the shape real tool types have (lowercase words joined by `_`, optionally a date) and pseudonymise the rest (narrowed to the documented types by S-V4-3); replay is unchanged, as an unknown type is unpriced under either name | 1c5ecf7 |
| S-V4-3 | V4 review | privacy | Low | Server tool types are client text: after S-V4-2 exports still kept any lowercase word shape (`jane_doe`, `project_falcon_lookup`), and raw traces kept any `[a-z0-9_]{1,64}` value, against the rule that traces hold no client content; the anonymizer fuzz generator filtered exactly the shape the fix kept, so it could not see this | `test/security/s-v4-3-server-tool-type-allowlist.test.ts`, `test/fuzz/anonymize.fuzz.test.ts` | fixed: a raw trace keeps a type in clear only when a provider documents it (any date suffix) or the recording policy names it (price table entry or route `serverTools`), else writes the placeholder `tool_<16 hex>` (HMAC with the trace salt); exports keep only the documented types and pseudonymise the rest; the fuzz now generates arbitrary words, letters-only names included | `git log --grep S-V4-3` |
| S-V4-4 | V4 fix review | privacy | Medium | `traces export --anonymize` copied `decision.seqEpoch`, the gateway's random process id, verbatim: like the instance id it is a linkable id, so the same value tied two exports to each other and to the raw traces | `test/security/s-v4-4-export-epoch.test.ts` | fixed: exports re-key it with the export salt (pseudonym kind `epoch`), as every other linkable id; equality within one export is kept, so replay from an export orders settles exactly as from the raw traces (restart case included) | `git log --grep S-V4-4` |

Rulings that rest on tests already in the findings table: reserved output below a request's maximum (A1, S25-1),
duplicate keys inside `tools[]` entries (S25-2), codex route without `allowModels` (A2), live cap lost on a crash and
the stale-lock takeover race (A11), PR code execution in the policy-replay workflow (C12), cross-tenant breaker and
retry-budget interference (S12-1), Redis exposure (S23-1), absent scope (S10-4), rewrite authorisation (S10-5).

## Revert checks

For eleven of the new tests the fix was reverted in a throw-away `git worktree` under `/private/tmp/claude-501/` (never
in the main tree) and the test run; every one failed on the reverted code and the worktree was removed.

| Test | Reverted line | Result on the reverted code |
|---|---|---|
| S6 | `Object.hasOwn(t.models, model)` replaced by `true` in `lookupModel` | 3 of 3 failed |
| S10-2 | authorising route check dropped from the model check in `decide` | 5 failed |
| S10-3 | server tool check against the header-free route removed | 3 failed |
| S10-4 | `(unattributed)` fallback returns null | 2 failed |
| S12-1 | credential breaker opened on the provider name | 1 failed |
| S16-3 | bare numeric tokens skipped again | 2 failed |
| S19-2 | author check removed from the comment filter | 1 failed |
| S20-1 | service tier refusal disabled | 1 failed |
| S21-1 | `/metrics` served on the API port | 1 failed |
| S7a | request class passed through | 2 failed |
| S-FS-1 | link check removed from the path walk | 2 failed |
| T25 gitattributes (V7) | `--textconv` added to the base-side `git show` | 1 of 2 failed |
| S6-2 service tier (V7) | tier label passes any value and `serviceTierPrice` drops `Object.hasOwn` | 1 failed |
| T9-e (V7, fix round 2) | the refusal of fast mode without fast prices absent (HEAD before the fix) | 2 failed |
| T10 (V7) | rate limit scope enum widened to `session`, `repo`, `feature`, `agentType` | 4 failed |
| S-V7-1 (V7) | raw id list without the epoch and placeholders (the generator before the fix) | 1 failed |

## Accepted residual risks and known limitations

These are not claimed to be fixed. Each was reported, judged and left, with the reason.

- **Provider billing assumptions.** Thinking blocks are bounded by bytes only if the provider bills at most one token
  per byte; the estimator does not model more. OpenAI stored prompts may carry server-side tools that the request body
  does not show. Client-tool classification uses bare prefixes (`bash_`, `computer_`, ...); a future server tool with
  such a prefix would be treated as a client tool (no provider tool using them was found).
- **Fast mode price sets (task 9).** Under fast mode only the fast rate set counts for the reservation. If a provider
  ever lists fast prices below standard, the reservation is lower than the standard bound; policy validation does not
  yet require `fast >= standard`. A request asking fast mode on a model without a `fast` block is refused as unpriced
  (CL-t9e, T9-e); what is left is a provider that bills fast mode without the request asking for it: such a response
  settles at the reservation, which is priced at the standard rates, so the charge is below the bill whenever the fast
  bill is above that reservation (`test/security/t9-fast-mode-unpriced.test.ts`, T9-residual; ruling progress.md:614).
- **OpenAI service tier served (FR-M2).** An absent `service_tier` is OpenAI's `auto` and is reserved as an explicit
  `auto` is: at the highest tier the model has prices for, standard when it lists none; explicit `default` is
  standard (`test/security/s20-1-service-tier.test.ts`, FR-M2). Settlement uses the tier the response reports, and a
  response that reports none is charged its reservation. What is left: a project whose default tier is priority, on a
  model without `serviceTiers` prices, gets responses reporting `priority`; those cannot be priced and settle at the
  reservation, which was priced at the standard rates, so the charge is below the bill whenever the priority bill is
  above that reservation (the same shape as the fast mode residual above).
- **Policy files caught mid-write (task 11, S-V3-2).** A changed policy directory activates only when two reads one
  settle interval (250 ms by default) apart agree (`test/policy-loader/loader-settle.test.ts`). A writer slower than
  that interval can still be caught with a prefix that validates, and a `--policy-url` source is not re-read. Operators
  should replace policy files atomically (write to a temporary name, then rename).
- **Last-known-good is not authenticated (C10).** Its sha256 detects corruption; anyone who can write the state
  directory can plant a policy. The loader requires gateway-user ownership and mode 0600, nothing more.
- **Error text from the upstream (B2 caveats).** A provider key echoed inside a 2xx SSE `error` event is not redacted
  (only non-2xx bodies are). Account ids inside an upstream error message text are not removed; the account headers
  are. A client abort during the bounded read of an error body is traced with the upstream status.
- **Credentials on argv (B5 caveat).** `--policy-url` and `--otlp-endpoint` may carry credentials in their URL and so
  appear on the command line. Secret-valued flags were removed; these two take URLs the operator may have signed.
- **Existing directories keep their mode (B6 caveat).** Trace, export and report directories created before the fix
  keep their old mode; only new ones are 0700. `chmod 700` them once.
- **The pre-commit hook is opt-in (B4 caveat).** `.githooks/pre-commit` runs only after
  `git config core.hooksPath .githooks`; CI scans the working tree and the packed tarball regardless.
- **Timing bounds in tests.** The S25-4 test bound is 100 ms for 1 MB and the C8 bound is 1000 ms; both could be tight
  on a slow Windows runner. `test/policy-loader/loader.test.ts` ("broken file keeps the old revision") flaked once in a
  parallel run.
- **Action leftovers (C2).** When the Action fails midway, a partly written base-traces file can stay in `RUNNER_TEMP`
  (a runner-local temp directory). `Policy check failed: 0 errors` can print when the failure is a load error, not a
  validation error (cosmetic).
- **Base-side git keeps PATH (C9).** git for the base side runs with an environment built from scratch, but PATH is
  kept so git can be found. An earlier workflow step that can write `GITHUB_PATH` can put another `git` first; a step
  that can write `GITHUB_ENV` can already set `NODE_OPTIONS`, which wins over anything the Action does.
- **Counter store restart (task 13).** The Redis store maps settlement ids to tenants in process; after a restart a
  settle returns `unknown` and the sweeper settles at the estimate. This fails safe (charged at the reservation) but
  the actual cost of that request is lost.
- **Live-cap warm-up (task 15, A11).** The date guard runs only at start; the trace salt is random per start when
  `TOKENYARD_TRACE_SALT` is unset; a recycled pid makes the lock look live and fails closed.
- **Two instances and the R11 latch (A9).** The first request of each process reads the latch from the store, later
  reads happen in the background every 30 seconds, so another instance follows a new violation within 30 seconds.
- **Live cap per checkout (second pass).** `npm run live` keeps its spend in `.live/traces` under the package root,
  so two checkouts or worktrees each get the full `TOKENYARD_LIVE_BUDGET_USD` cap. Documented in the README; run live
  tests from one checkout.
- **Request deadline (A8).** Fixed at 18 minutes in `serve`; no flag. A stream longer than that is cut.
- **Chain fallback (A6).** Relies on undici diagnostics channels to know the body was sent; a request not seen created
  counts as sent (fails toward charging, never toward a second provider).
- **Trace layout names (task 7, found again by reviewer C).** `safeTenantDir` maps `a/b` and `a_b` to one directory,
  and `--instance-id` is used unsanitised in a file name. Both values are operator-set, not client-set.
- **Surface and provider format (task 20).** A route without a `match.surface` can send Responses bodies to an
  Anthropic provider; there is no compile-time check. `max_tool_calls` is applied to every server tool, which
  over-counts (safe).
- **Rate and stream limits scoped to session or repo.** The schema scopes them to tenant, team or key today, and a
  policy with a header-derived scope does not load (`test/security/t10-rate-scope-headers.test.ts`); if repo or
  session scopes are added, a missing header is charged to `(unattributed)` as budgets are (guarded in `decide`).
- **Header-selected chains.** A header may choose a different provider chain among the models the key may use; this is
  by design (S10-2).
- **Operational notes from reviewer C.** `count_tokens` has no rate limit of its own; since the final review (ledger
  183 overturned) it passes the key's request-rate checks, with no reservation, token budget or stream slot, so a key
  over its rate gets 429 on it and one developer on a shared operator key cannot spend the organisation's upstream
  `count_tokens` limit alone (`test/edge/admission.test.ts`, "a key over its request rate gets 429 on count_tokens"). If
  the `GET /user` lookup fails the Action assumes `github-actions[bot]` as comment author, so a GitHub App token can
  edit other marker comments. A policy can name any environment variable as a credential; the policy author is trusted.
- **Information.** A `ty_live_` key used as a YAML map key is echoed in an "Unrecognized key" load error (key names are
  capped); the operator who wrote the file sees it.
- **Probes that fail by ruling.** The original B5 probe passes flags that are now refused; the C10 probe asserts a MAC
  that the ruling declined; the C12 probe asserts the removed `hashFiles` condition. The regression tests above replace
  them.

## How to run

```
npx vitest run test/security      # the whole security suite, mock upstreams only
npm test                          # everything, including test/security
npm run check:secrets             # repository, history-independent scan with the gateway's own rules
npm run test:redis                # the Redis variants (needs Docker; loopback port, random password)
npm run test:chaos                # chaos and failure scenarios with invariants, Redis outages included (docs/chaos.md)
```

Every file under `test/security/` is named after the finding it pins (`a*`, `b*`, `c*` for the three reviews, `s*` for
findings raised by the coordinator or by batch review). A new finding gets a failing test there first.

## Second pass

Date: 2026-11-03. Method: reviewer A (budget bypass) was re-run with fresh context against the fixes, the range
9752407..90d7337, with the same brief as the first pass plus the list of fixed findings to re-attack. The reviewer
wrote each attack as a failing probe against mock upstreams; the probes were turned into regression tests under
`test/security/` (RED run first, then the fix, then GREEN; the probes pass afterwards).

Result: three Medium findings; no High or Critical finding was found. Re-attacked and held: A1 with S25-1, A2, A3
with S20-2 under the worst-case estimator, A4, the body-shape refusals (A5), A6, A7, A8, A9, A10, A11, path matching,
late admits, the crash path and header-chosen routes.

| Id | Area | Severity | Description | Regression test | Status | Commit |
|---|---|---|---|---|---|---|
| A2-1 | budget | Medium | Product-route PII redaction made the forwarded body longer than the bytes the bound was computed from (a 6-byte email becomes an 18-byte placeholder), so the reservation was no bound, and the self-made overrun tripped the shared R11 latch for every instance | `test/security/a2-1-redaction-grows-body.test.ts` | fixed: after redaction, model rewrite and the output cap, decide runs again on the final body length before admit, so the bound, the reservation and R11 all use the bytes actually sent | 4c1398c |
| A2-2 | budget | Medium | Under `estimator: session-aware`, a stream that ended without its final usage settled at the session-aware reservation, which prices one iteration and no server tool fees, so dropping the connection before `message_delta` after a web search loop was a client-chosen discount | `test/security/a2-2-session-aware-abort.test.ts` | fixed: decide keeps the worst-case estimate on the plan; a request without final usage (and the fault path) settles at the higher of the reservation and the worst case; replay charges the same | 95bab19 |
| A2-3 | budget | Medium (Low for the example policy) | OpenAI per-call tool fees were reserved but never charged: OpenAI reports calls as `*_call` output items, not in `usage`; and the price table keyed tools by name only, so OpenAI `web_search` was priced with Anthropic's entry | `test/security/a2-3-responses-tool-fee.test.ts` | fixed: server tool prices are per provider (`openai/<type>` keys); `web_search_call` items are counted from the JSON output, `response.output_item.done` and the terminal output; a priced OpenAI tool whose calls are not counted settles at the reservation; OpenAI `web_search` priced at $10 per 1,000 calls (pricing page, retrieved 2026-11-03), its loop reserved as `max_tool_calls + 1` iterations | b07a03c |

Observations (no probe):

- Each package checkout has its own `.live/traces`, so two worktrees each get the full $20 live cap. Documented in
  the README Limitations and above under residual risks.
- Replay of pseudonymised models cannot be priced by a head policy that adds a price for them; this affects only the
  CI gate's cost estimate, not enforcement. Left as is.
- The body-shape refusal reasons (`body-bom`, `duplicate-keys`, `too-deep`, `unparsable-body`) were missing from the
  replay engine's `BODY_EXITS`. Such records normally carry `preDecision`; a record without it was decided again and
  replayed as forwarded. Fixed: they are carried over as recorded, before decide
  (`test/security/a2-obs-body-shape-replay.test.ts`, 90168ad).

## V7 retest

Date: 2026-11-03, against 266d686. Three parts: every item of the Task 25 checklist traced to the test that pins it
(or to the ruling that left it open), a quick adversarial sweep over what changed during V1 to V6 (`5ad6f31..266d686`
in `src/`, `bin/`, `scripts/`, `action.yml`, the workflows, `bench/` and `examples/`), and a secrets pass. No live
provider was called (spend 0 USD).

`npx vitest run test/security`: every file green; the three Redis variants (A9, A10, S-V2-1) skip without `REDIS_URL`
and run in `npm run test:redis`. Tests added in V7 were checked against reverted guards (see "Revert checks").

### Checklist items

The findings and rulings forwarded by the coordinator (S6 to S23-1, S-FS-1 and S-FS-2, S-V2-1 to S-V4-4) are the rows
of the tables above. The checklist items and the minors marked for Task 25:

| Id | Threat | Fix commit | Regression test | Status |
|---|---|---|---|---|
| CL-prototype | Prototype keys on any user-keyed table (prices, keys, server tools, service tiers, geo, attribution) and non-finite costs failing open | see S6 | `test/security/s6-prototype-key-lookup.test.ts`, `s6-2-prototype-keys-other-tables.test.ts` | fixed (S6); other tables held: keys are looked up by hash, `Object.hasOwn` on tiers, tools, modifiers |
| CL-anonymize | Anonymize deny by default; attribution bounded at ingest and escaped in every renderer | see S7a, S7b, B1, S-V4-2 to S-V4-4 | `s7a-anonymize-attribution.test.ts`, `s7b-renderer-injection.test.ts`, `b1-client-text-in-traces.test.ts`, `b1r-model-pseudonym.test.ts`, `s-v4-*.test.ts` | fixed |
| CL-trace-names | `safeTenantDir` not injective, `--instance-id` unsanitised in a file name | none | none | accepted by ruling (progress.md:611 (the Task 25.4 residual-risk entries, progress.md:487-488); residual risks, "Trace layout names"): operator-set values |
| CL-t9a | Parse error, missing or unpriced model priced with `reservationPrice(t, null)` | see A2 | `a2-unpriced-model.test.ts`, `s6-prototype-key-lookup.test.ts` | fixed |
| CL-t9b | R11 bytes-bound switch after a violation | see A9 | `a9-r11-latch-scope.test.ts` | fixed |
| CL-t9c | Estimator throw must fail closed | Task 14 | `test/edge/admission.test.ts` ("a reservation that cannot be priced fails closed") | fixed |
| CL-t9d | Settlement prices `usage.speed` fast | Task 14 | `t9-fast-mode-unpriced.test.ts` (T9-d), `test/edge/admission.test.ts` | fixed |
| CL-t9e | Fast mode asked on a model whose price entry has no `fast` block was reserved at the standard rates | `git log --grep CL-t9e` | `test/security/t9-fast-mode-unpriced.test.ts` (T9-e) | fixed by ruling (progress.md:614, superseding the CL-t9e ruling at progress.md:607): refused as unpriced like S20-1 (403, `x-should-retry: false`, nothing sent), whatever `failure.unpricedModel` says; models with fast prices unchanged (T9-d) |
| CL-fast-max | Under fast mode only the fast rate set counts | none | none | accepted by ruling (progress.md:611 (the Task 25.4 residual-risk entries, progress.md:487-488); residual risks, "Fast mode price sets") |
| CL-client-tool | Client-tool classification by bare prefix | none | none | accepted by ruling (progress.md:611 (the Task 25.4 residual-risk entries, progress.md:487-488); residual risks, "Provider billing assumptions") |
| CL-route | Rewrite priced at the served model, header predicates granting access, server tools not allowed, scope dodge by omitted headers | see S10-1 to S10-4 | `s10-1-*`, `s10-2-*`, `s10-3-*`, `s10-4-*.test.ts` | fixed |
| CL-taint-ns | Session and key taint sets in one namespace | see S10-taint | `s10-taint-namespace.test.ts` | held by construction |
| CL-rewrite-authz | Rewritten model checked against the authorising route | see S10-5 | `s10-5-rewrite-authz.test.ts` | fixed |
| CL-rate-scope | Rate and stream limits scoped to a header skip when it is missing | none needed | `t10-rate-scope-headers.test.ts` | held: the schema allows tenant, team and key only; header-selected chains by design (S10-2) |
| CL-partial-write | Policy file caught mid-write activates a weakened policy | see S-V3-2 | `test/policy-loader/loader-settle.test.ts`, `test/chaos/reload.test.ts` | fixed; slow writers residual |
| CL-cross-tenant | Breaker and retry budget interference across tenants | see S12-1 | `s12-1-per-credential-breaker.test.ts`, `t25-retry-budget-tenant.test.ts` | fixed (breaker), held (retry budget per key-record tenant) |
| CL-redis-restart | Settle after a restart returns unknown, sweeper settles at the estimate | none | none | accepted by ruling (progress.md:611 (the Task 25.4 residual-risk entries, progress.md:487-488); residual risks, "Counter store restart"): fails safe |
| CL-live-crash | Live cap under-count on a crash; stale-lock takeover race | see A11 | `a11-live-cap.test.ts` | fixed; date guard and salt residual |
| CL-parser | Scanner and upstream parser differential (malformed JSON, duplicate keys, non-string tokens, encodings) | see A5, S25-2, S16-1 | `a5-parser-differential.test.ts`, `s25-2-nested-duplicate-keys.test.ts`, `s16-1-scanner-differential.test.ts` | fixed |
| CL-raw-fallback | Malformed body raw fallback and encoded secrets | see S16-2 | `s16-2-malformed-body-escapes.test.ts` | fixed |
| CL-bare-number | PII and secrets in unquoted JSON numbers | see S16-3 | `s16-3-bare-numeric-pii.test.ts` | fixed |
| CL-action | Base policy spoofing via working-tree paths, sticky comment hijack, PR code in the policy-replay workflow | see S19-1, S19-2, C12 | `s19-action-base-policy.test.ts`, `c12-workflow-trusted-checkout.test.ts` | fixed |
| CL-base-side | PR input influencing the base side: paths, git discovery, environment, head-tree config files, policy includes | see S19-3, S19-4, C2, C9, C11 | `s19-action-base-policy.test.ts`, `c9-base-git-env.test.ts`, `c2-action-traces-at-base.test.ts`, `c11-cli-base-ref.test.ts`, `t25-head-tree-gitattributes.test.ts`, `test/policy/schema.test.ts` ("pricing and keys must name a file in the policy directory") | fixed; head-tree `.gitattributes` held (blobs read without textconv or filters) |
| CL-safe-path | Any direct read or write of a user-controlled path | see S-FS-1, S-FS-2 | `s-fs-1-safe-path.test.ts`, `s-fs-2-system-links.test.ts` | fixed |
| CL-settle-tier | Settlement without terminal usage; price tier picked by the client | see S20-1, S20-2, A2-3 | `s20-1-service-tier.test.ts`, `s20-2-responses-settle-without-usage.test.ts`, `a2-3-responses-tool-fee.test.ts` | fixed |
| CL-t20 | Duplicate keys inside `tools[]`; route without a surface; codex route without `allowModels`; `max_tool_calls` on every tool | see S25-2, A2 | `s25-2-nested-duplicate-keys.test.ts`, `a2-unpriced-model.test.ts` | fixed; surface check and over-count residual |
| CL-ops | Ops endpoint exposure; metric cardinality from client input | see S21-1, S21-2, B3 | `s21-1-metrics-exposure.test.ts`, `s21-2-metric-label-cardinality.test.ts`, `b3-ops-host.test.ts` | fixed; series count bounded in the V2 soak |
| CL-reserve-output | `reserveOutputTokens` below a request's max output | see A1, S25-1 | `a1-reserve-output-tokens.test.ts` | fixed |

### New findings

| Id | Area | Severity | Description | Regression test | Status | Commit |
|---|---|---|---|---|---|---|
| S-V7-1 | privacy (tooling) | Low | The local leak guard for `examples/live` (`test/docs/readme.test.ts`) checks the raw linkable ids that `bench/live-summary.ts` writes to `.live/raw-names.json`; the list left out the process epoch (`decision.seqEpoch`, S-V4-4) and the raw traces' server tool placeholders (`tool_<16 hex>`, S-V4-3), so a regression of either in the anonymizer would not have been caught. The committed export held none of them | `test/security/s-v7-1-live-guard-ids.test.ts` (local only: needs the gitignored raw traces) | fixed: both are collected; the list now holds every epoch of the raw traces | `git log --grep S-V7-1` |

No High or Critical finding.

### Sweep of V1 to V6 (held, no finding)

- **Idle keep-alive close** (`closeIdleWhenQuiet`): a byte read after the idle timer cancels the close and hands the
  socket back to Node; a probe that sent one byte at that moment and nothing more saw the socket closed at the
  headers timeout, so the deferral is bounded (2 s while the loop is busy, then Node's headers and request timeouts).
- **Scan budgets** run after authentication and before `JSON.parse`; the refusals are fixed-text 413s with
  `x-should-retry: false` and a fixed reason label.
- **Session churn (S-V2-1)**: the new-session allowance and the marker are written only on admit or on a last-turn taint
  write; key names are percent-encoded; the memory store's markers expire with the idle TTL.
- **SSE parser (S-V4-1)**: a dropped event cannot lower a charge: a Messages stream without final usage or with an
  estimated output settles at the reservation, as does a Responses stream without terminal usage.
- **Body walk** (`skipString`, `duplicateTopLevelKey`, `countJsonValuesUpTo`): quote parity over the preceding backslash
  run matches the sequential parse; the any-depth duplicate key check (S25-2) stays as the second layer.
- **Keyword prefilter** (`keywordsIn`): every start position is searched, prefixes of a longer hit are added, so the
  prefilter finds every keyword `includes` finds.
- **Loader settle re-read, writer forgetting past hours, breaker window**: no new input reaches them beyond the policy
  author and the clock.
- **Ops listener**: only a comment changed; an IPv4-mapped loopback host still needs a token.
- **Bench and soak harness**: every listener binds 127.0.0.1 (the soak probe preloaded into the gateway answers
  memory samples only and is not in the npm package); the Redis URL with its password goes through the environment;
  `bench/soak.ts` refuses a non-loopback `REDIS_URL` and `bench/run.ts` skips one unless `BENCH_ALLOW_FLUSH=1`; `scripts/local-redis.mjs` keeps the
  loopback, random-port, random-password container (S23-1) and now forwards signals to its command.
- **CI**: `permissions: contents: read`, actions pinned to commit SHAs, `persist-credentials: false`; the mutation job
  runs only on `workflow_dispatch`.
- **examples/live**: no prompt text, home paths, host names, email addresses or key-shaped strings in the summary, the
  HTML report, the screenshots or the anonymized traces; the raw epochs are absent from the export.

### Secrets

`npm run check:secrets` is clean (529 files at the last V7 commit). In `git grep HEAD`, 48 tokens start with `sk-ant-`, `sk-` or `ty_live_`
followed by 8 or more key characters, all test canaries, plan examples or fixtures; none equals a key in `.env`
(compared by SHA-256, values never printed).
