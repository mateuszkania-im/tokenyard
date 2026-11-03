# Quality gates

The V5 phase adds the gates every change has to pass besides the test suite: one aggregate static check, line and
branch coverage with per-module thresholds, mutation testing on the modules that decide and account money, CI on Linux
and Windows, a guard against leaked child processes, and test bounds that hold on a loaded machine.

## Commands

| Command | What it does |
|---|---|
| `npm run check` | `typecheck` (tsc strict, `noUncheckedIndexedAccess`, src, tests, scripts and bench), `lint` (oxlint, warnings denied), `check:bundle`, `check:secrets`, `bench:check` |
| `npm test` | The default suite, with the process guard below |
| `npm run test:coverage` | The default suite with V8 coverage; fails under the thresholds in `vitest.config.ts`; HTML report in `coverage/` |
| `npm run test:mutation` | Stryker on the modules below (`stryker.config.mjs`); fails under a mutation score of 80; HTML report in `reports/mutation/` |
| `npm run test:pack` | Packs the tarball, installs it into an empty project and runs the command |

## Coverage

`npm run test:coverage` (V8 counters, `src/**` only; tests that run the bundle in a child process add nothing). Measured
on 2026-11-03 (Apple M2 Pro, Node 22.14), with the thresholds in `vitest.config.ts` (the measured level rounded down;
two runs differed by 0.1 point on timing-dependent paths, so the global numbers and handler.ts sit one point lower):

| Module | Lines | Branches | Functions | Statements | Threshold (lines / branches) |
|---|---:|---:|---:|---:|---|
| all of src | 90.48 | 83.19 | 89.46 | 88.98 | 89 / 81 |
| policy/decide.ts | 100 | 94.94 | 100 | 98.88 | 100 / 94 |
| policy/resolve.ts | 98.14 | 89.02 | 100 | 98.46 | 98 / 89 |
| limits/memory-store.ts (budget accounting) | 100 | 94.31 | 100 | 98.21 | 100 / 94 |
| limits/store.ts | 100 | 94.11 | 100 | 96 | 100 / 94 |
| limits/estimator.ts | 100 | 100 | 100 | 100 | 100 / 100 |
| guardrails/scan.ts | 99.36 | 97.9 | 100 | 98.97 | 99 / 97 |
| stream/sse.ts | 100 | 98.36 | 100 | 100 | 100 / 98 |
| edge/handler.ts | 94.39 | 89.7 | 90.78 | 93.1 | 93 / 88 |

`limits/redis-store.ts` runs only against a real Redis (`npm run test:redis`) and has no threshold in this run. CPU-time
bounds are ten times looser under coverage instrumentation (`test/helpers/timing.ts`).

## Mutation testing

`npm run test:mutation`: Stryker 10.1 with the Vitest runner, `perTest` coverage analysis (each mutant runs only the
tests that reach it), incremental (`reports/stryker-incremental.json`), static mutants ignored (module-level values such
as the rule tables and the scan budget caps: 33 of 1,963 mutants, but they ran every test per mutant, an estimated 61%
of the run; `test/guardrails/scan-budget-caps.test.ts` pins each scan cap at its boundary instead). The test set is
`vitest.stryker.config.ts`: the in-process tests of the mutated modules and their callers, about 5 s, without the
gateway-level suites (with them the run was estimated at five hours), the tests that call `process.chdir` (unsupported
in Vitest's worker threads) or read this repository's git history (the sandbox has none), and with timing bounds off.
Break threshold 80 for the whole run.

Final full run (2026-11-03, M2 Pro, 15 min 41 s, 1,930 mutants tested, 33 static ignored), then an incremental run
after the keyword cache fix (3 min 48 s):

| Module | Score | Killed | Timeout | Survived | No coverage | Before the V5 tests |
|---|---:|---:|---:|---:|---:|---:|
| policy/decide.ts | 84.02 | 446 | 1 | 68 | 17 | 80.45 |
| limits/memory-store.ts (budget) | 88.35 | 220 | 0 | 27 | 2 | 88.35 |
| limits/store.ts (budget helpers) | 88.10 | 37 | 0 | 4 | 1 | 88.10 |
| limits/estimator.ts | 96.31 | 235 | 0 | 9 | 0 | 79.92 |
| guardrails/scan.ts | 85.50 | 684 | 53 | 123 | 2 | 71.38 |
| all | 86.88 | 1,622 | 54 | 231 | 22 | 77.51 |

The tests added for it pin behaviour, not output: `test/limits/estimator-branches.test.ts` (service tier price sets,
the unpriced envelope, output bounds, OpenAI tool loops, date suffixes, zero and negative estimates),
`test/guardrails/scan-decode.test.ts` (a property over every escaping of any string, surrogates included, raw and parsed;
escape edge cases; whitespace between tokens) and `test/guardrails/scan-views.test.ts` (the exact decoded view, token
boundaries, the budget error, hit placement). The decode property found nothing; the unseeded `keywordsIn` property found
a real bug while this ran (two keyword lists that join to the same text shared one cached regex), fixed in scan.ts.

Equivalent and accepted survivors, by kind (the full list with code is in `reports/mutation/mutation.html` after a run):

- Caches and cursors that only save work: the next-backslash and next-quote cursors in `buildViews`, the keyword
  alternation cache and its size cap, the order of keywords of equal length, the view buffer growth (`>` against `>=`).
  Recomputing gives the same text and spans.
- Early returns that skip work the loop after them would not do: no rules or an empty range in `findSpans`, an empty
  string in `View.push`, an empty keyword list, `bEnd <= bStart`.
- Guards no input reaches: empty segments for a non-empty match, `segments.length !== 1` for a bare number, the anchors
  of the 4-digit hex check on a 4-character string, `fast && m.fast` checked again inside `priceSets`, `Math.max(0, null)`
  for a missing cache share, `null > 0` for a missing max_tokens, the float-noise boundary in `roundUp` (`<` against `<=`
  at exactly 1e-6).
- Multiplying by a modifier of exactly 1 (`factor > 1` against `>= 1`).
- Strings and labels only tests or error text see: the memory store's `keys()` listing (a test helper), refusal names
  whose kind is what callers read.
- Remaining decide.ts survivors (68) are mostly trace and warning fields the gateway-level tests check (route weights,
  rewrite bounds, `worstCaseMicroUsd`), which this test set leaves out; the score is above 80 without them.

## CI

`.github/workflows/ci.yml` runs `npm run check` on `ubuntu-latest` and `windows-latest`, each on Node 20.19 (the
oldest `engines` allows), 22 and 24, then `npm test` on 22 and 24 and `npm run test:pack` on 20.19; then the Redis suite, the packed tarball on both systems, the coverage
thresholds and the compose smoke test. The mutation job runs only when started by hand (`workflow_dispatch`). Every
third-party action is pinned to a full commit SHA (`test/arch/workflow-pins.test.ts`). The workflow has not run on
GitHub yet: it was verified by running the same commands on macOS and in Linux containers (below).

Verified locally on 2026-11-03: macOS (Node 22.14) runs `npm run check`, `npm test`, `npm run test:coverage`,
`npm run test:fuzz`, `npm run test:redis` and `npm run test:chaos`. Linux containers (`docker run --rm`, no published
ports, the repository mounted read-only and copied in, `npm ci` inside, `.env` never copied):

| Image | npm run check | npm test | npm run test:pack |
|---|---|---|---|
| node:24 (24.22.2) | pass | 1,022 passed, 40 skipped | pass (18 checks) |
| node:20.19 (20.19.6) | pass | not supported by Vitest 5 (engines `^22.12 \|\| ^24`): one A8 fake-timer case fails and the reporter crashes on `Map.groupBy` | pass (18 checks) |

So CI runs the Vitest suite on Node 22 and 24, and on Node 20.19 the check and the packed bundle.

## Child processes and listeners

`test/setup/process-guard.ts` (a Vitest setup file) wraps `spawn`, `fork`, `execFile` and `exec`. A child still running
when its test file ends fails that file and is killed; a child the test already signalled gets 5 s to exit. Node
children get `test/setup/child-listen-guard.mjs` preloaded, which records any listener bound to `0.0.0.0` or `::`;
in-process servers are checked the same way. The global teardown (`test/setup/global-guard.ts`) fails the run on any
record and on any recorded child that is still alive, for example one left by a worker that died before its file
ended. A test that needs a listener that is not loopback by name binds `::ffff:127.0.0.1`, reachable only through
loopback. `scripts/local-redis.mjs` forwards SIGINT and SIGTERM to its command before removing the container, so an
interrupted `npm run test:redis` leaves neither the container nor an orphaned Vitest behind.

## Tests on a loaded machine

A test that bounds time must hold when other processes compete for the cores. The rules:

- A bound on work is a bound on CPU time (`test/helpers/timing.ts`), not on the wall clock: the C8c duplicate-key
  check, the ReDoS bodies and the 32 MiB scan budget bodies. A growth check compares the least of three runs per
  size.
- A test waits for the event it needs (a request id handed out by the handler, a counter reaching a value), never for
  a fixed pause that stands for it.
- A test whose only time dependency is the hang guard (it runs git and the bundle in subprocesses and asserts nothing
  about time) gets a timeout sized to its work.

Each flake on the V5 list, reproduced with a CPU burner (one busy thread on every core but one, load average 32 to
37 on a 12-core M2 Pro) or under coverage instrumentation, and how it was fixed:

| Test | Failure | Fix |
|---|---|---|
| C8c duplicate-key check is linear | 1.7 s against a 1 s wall-clock ceiling; later a 5 s timeout | CPU time, least of three runs per size; ratio under 6 |
| ReDoS bodies (1 MiB per rule) | over the 1 s bound at load average 20 | CPU-time bound |
| 32 MiB scan budget bodies (S-V3-3) | event loop stall over 1 s under load | CPU-time bound of 1.5 s (measured at most 0.22 s); the stall keeps a 10 s hang ceiling |
| S25-4 masked-key matching, S-V3-1 and S-V3-3 scanner bounds, keyword prefilter, body shape, alias bomb, breaker | wall clock past the bound under coverage (115 ms against 100 ms; 2.7 s against 2.5 s) | CPU time, ten times the bound under coverage (`cpuBoundMs`) |
| loader "broken file keeps the old revision" | two load errors for one write | product fix: a repeated failure found by the watcher counts once, as one found by the poll did; one write reaches the watcher as several events |
| burst fidelity (Task 17) | a fixed 200 ms pause stood for "the gateway registered the request" | waits for the request id the handler hands out |
| chaos client leaves before the body | the trace line count was compared with a request count read once, before late requests reached the handler | both counts read on every poll |
| S19-1, C11, C12, the Action's base policy case | 5 s default timeout on 1 to 1.5 s of git and bundle subprocesses | 30 s hang guard timeout (`vitest.config.ts`) |

Proof: `npx vitest run` three times in a row with the burner running, zero failures (V5 report).
