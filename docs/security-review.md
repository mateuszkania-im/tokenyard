# Security review (Task 25)

Record of the adversarial review of tokenyard at the end of the build, the findings it produced, the tests that pin
each fix and what is knowingly left open. Date: 2026-11-03. Reviewed tree: branch `mvp` at 9752407.

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
   Three fix rounds followed independent review of the batches; they found four more issues (S25-1 to S25-5), listed
   below.
4. **Forwarded findings.** Every finding raised by the coordinator during the build (tasks 6 to 23) and every ruling
   attached to it got a dedicated test in `test/security/` in this batch (second table). Eleven of the new tests were
   re-checked by reverting the fix in a scratch worktree; see "Revert checks".
5. **Second pass.** Reviewer A is re-run against the fixes and the result is recorded in the last section. It is a
   placeholder until that pass has happened.

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
| S25-5 | policy | Medium | The YAML node cap did not count mappings | `test/security/s25-5-yaml-node-cap-maps.test.ts` | fixed | f2b52d5 |

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
| S20-1 | 20 | budget | Medium | Non-standard `service_tier` priced as standard | `test/security/s20-1-service-tier.test.ts` | fixed: refused unless the model has tier prices; `auto` reserves at the highest tier | dbac3f6 |
| S20-2 | 20 | budget | Medium | Responses settlement without terminal usage under-charged | `test/security/s20-2-responses-settle-without-usage.test.ts` | fixed: settles at the reservation | dbac3f6 |
| S21-1 | 21 | leak | Medium | `/metrics` unauthenticated on the API port | `test/security/s21-1-metrics-exposure.test.ts` | fixed: separate ops listener, token off loopback | b3820c1 |
| S21-2 | 21 | leak | Medium | Metric labels from client-controlled values (cardinality, poisoning) | `test/security/s21-2-metric-label-cardinality.test.ts` | fixed: bounded label sets, series cap | b3820c1 |
| S23-1 | 23 | exposure | Medium | Bench Redis published on all interfaces without a password | `test/security/s23-1-local-redis-exposure.test.ts` | fixed: loopback, random port, `--requirepass`, one helper | 2c7e812 |

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

## Accepted residual risks and known limitations

These are not claimed to be fixed. Each was reported, judged and left, with the reason.

- **Provider billing assumptions.** Thinking blocks are bounded by bytes only if the provider bills at most one token
  per byte; the estimator does not model more. OpenAI stored prompts may carry server-side tools that the request body
  does not show. Client-tool classification uses bare prefixes (`bash_`, `computer_`, ...); a future server tool with
  such a prefix would be treated as a client tool (no provider tool using them was found).
- **Fast mode price sets (task 9).** Under fast mode only the fast rate set counts for the reservation. If a provider
  ever lists fast prices below standard, the reservation is lower than the standard bound; policy validation does not
  yet require `fast >= standard`.
- **Truncated policy files (task 11).** A policy file cut at a line boundary that still validates (for example trailing
  budgets dropped) can activate and become the last-known-good. The three files are read non-atomically and there is
  no stability re-read. Operators should replace policy files atomically (write to a temporary name, then rename).
- **Last-known-good is not authenticated (C10).** Its sha256 detects corruption; anyone who can write the state
  directory can plant a policy. The loader requires gateway-user ownership and mode 0600, nothing more.
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
- **Request deadline (A8).** Fixed at 18 minutes in `serve`; no flag. A stream longer than that is cut.
- **Chain fallback (A6).** Relies on undici diagnostics channels to know the body was sent; a request not seen created
  counts as sent (fails toward charging, never toward a second provider).
- **Trace layout names (task 7, found again by reviewer C).** `safeTenantDir` maps `a/b` and `a_b` to one directory,
  and `--instance-id` is used unsanitised in a file name. Both values are operator-set, not client-set.
- **Surface and provider format (task 20).** A route without a `match.surface` can send Responses bodies to an
  Anthropic provider; there is no compile-time check. `max_tool_calls` is applied to every server tool, which
  over-counts (safe).
- **Rate and stream limits scoped to session or repo.** The schema scopes them to tenant, team or key today; if repo or
  session scopes are added, a missing header is charged to `(unattributed)` as budgets are (guarded in `decide`).
- **Header-selected chains.** A header may choose a different provider chain among the models the key may use; this is
  by design (S10-2).
- **Operational notes from reviewer C.** `count_tokens` has no rate limit of its own (it shares the upstream limit). If
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
```

Every file under `test/security/` is named after the finding it pins (`a*`, `b*`, `c*` for the three reviews, `s*` for
findings raised by the coordinator or by batch review). A new finding gets a failing test there first.

## Second pass

Pending. The controller re-runs reviewer A against the fixes and records here: date, reviewed commit, reviewer result,
new findings (id, severity, status) or "no new finding of high severity".
