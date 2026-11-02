# tokenyard MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build tokenyard v0.1: a byte-faithful TypeScript gateway for Claude Code and Codex traffic with hard budgets, attribution, secret guardrails, decision traces, and policy replay that comments on pull requests.

**Architecture:** One npm package, modules as directories under `src/` (spec 5.2). The data plane (`tokenyard serve`) forwards original body bytes, tees the response stream for usage, and makes exactly one counter-store call (`admit`) per request. Policy is YAML compiled to an immutable snapshot; `decide` and `resolve` are pure, which is what makes replay over NDJSON traces exact.

**Tech Stack:** TypeScript (strict, ESM), Node `>=20.19`, raw `node:http`, undici, zod, yaml, redis (node-redis), commander, picocolors, OpenTelemetry JS (lazy), Vitest, fast-check, esbuild, tsx, oxlint.

**Spec:** `docs/superpowers/specs/2026-11-02-gateway-design.md` (read it with this plan; section numbers below refer to it).

## Global Constraints

- TypeScript `strict` and `noUncheckedIndexedAccess`, ESM, Vitest. One package, no monorepo.
- esbuild bundles everything to one committed file `bin/tokenyard.mjs`; `npm run check:bundle` fails CI when it is stale. No runtime `dependencies` in the published package.
- Package `@mateuszkania-im/tokenyard`, command `tokenyard`, MIT licence. Never run `npm publish`; never `git push` (Mateusz does both).
- `engines.node` is `>=20.19`. CI: Node 20.19, 22 and 24 on Linux; Node 22 on Windows. Docker image on Node 24. Nothing uses `node:sqlite`.
- Dependencies (bundled): `undici`, `zod`, `yaml`, `redis`, `commander`, `picocolors`, OpenTelemetry JS packages loaded only when OTLP is configured. Dev: `vitest`, `esbuild`, `tsx`, `typescript`, `fast-check`, `oxlint`. Anything else needs a line in the task explaining why.
- HTTP server is raw `node:http`. No framework.
- Hot path: at most one network round trip besides the upstream call, the counter store's `admit`. Rate checks, stream slots, session taint and all budget reservations happen inside it.
- Money is integer micro-USD everywhere (`HINCRBY`, never floats in the store). Estimates round up (`Math.ceil`), actual costs round half up (`Math.round`).
- Coding-agent request bodies are never modified or re-serialised; the forwarder's body parameter is typed `Buffer`.
- `policy/`, `replay/`, `surfaces/`, `stream/`, `pricing/`, `guardrails/` and `limits/estimator.ts` do no I/O (import rule test, Task 1).
- Every counter key carries the tenant hash tag `{tenant}`; every trace path starts with the tenant.
- Traces never hold prompt text, tool content, file paths from bodies or credentials. Session, agent, parentAgent and promptId are HMAC-SHA256 pseudonyms.
- Live tests: only through `npm run live`, which reads `.env` with `node --env-file=.env`; hard cap `TOKENYARD_LIVE_BUDGET_USD=20` in total, enforced by tokenyard's own budget; refuse to run after 2026-11-16. The value of `ANTHROPIC_API_KEY` is never printed, logged, passed as an argument, written to a file, committed or copied. Codex live only when `OPENAI_API_KEY` is present in the environment; never search other folders for keys.
- Subscription passthrough exists only behind `--experimental-subscription` and is never mentioned in the README, demo or example policy.
- README numbers only from `bench/results.json` or anonymized live exports; nothing written before it is measured.
- Repo prose in English, no em dashes, no arrow characters.

## Review Focus

1. **Client disconnects before upstream headers arrive** (user hits Esc right after sending). Expected: upstream request aborted, reservation settled at 0 (no usage seen), stream slot freed, no unhandled rejection, trace `aborted: true`. Test added to Task 14.
2. **Body that is not valid JSON, or valid JSON without `model`, on a coding-agent route.** Expected: bytes forwarded unchanged so the provider answers with its own 400; features use `boundKind: 'context-window'` priced at the most expensive model; no gateway crash. Test added to Task 4 (forwarding) and Task 9 (bound).
3. **Policy file saved mid-write or briefly empty** (editor writes in two steps). Expected: the debounced reload fails validation, the old revision keeps serving, `tokenyard_policy_load_errors_total` increments, the next good write activates. Test added to Task 11.
4. **One request whose own worst-case reservation exceeds the whole budget** (huge context with a big `max_tokens` against a small session budget). Expected: an immediate 429 whose message says the request's reservation is larger than the budget's limit, not a retry hint, and nothing reserved. Test added to Task 14.
5. **Policy and keys files with CRLF line endings or a UTF-8 BOM** (edited on Windows). Expected: parsed exactly as the LF version, same bundle sha256 after normalisation. Test added to Task 8.

---

## File Structure

```
package.json, tsconfig.json, vitest.config.ts, esbuild.config.mjs, .oxlintrc.json, LICENSE
action.yml                          GitHub Action (Task 19)
bin/tokenyard.mjs                   committed bundle
compose.yaml, Dockerfile            (Task 22)
.github/workflows/ci.yml            (Tasks 1, 26)
scripts/check-bundle.mjs            bundle staleness check
scripts/check-no-secrets.mjs        fails on sk-ant-/sk-proj- values in repo or tarball
scripts/gen-conformance-doc.mjs     docs/conformance.md from test names
scripts/bench-to-readme.mjs         BENCH block writer and checker
src/cli.ts                          commander entry: serve, demo, mock, policy, report, keys, traces, env, live
src/edge/        server.ts paths.ts auth.ts keys.ts body.ts headers.ts errors.ts attribution.ts handler.ts
src/surfaces/    types.ts anthropic-messages.ts anthropic-count-tokens.ts anthropic-models.ts openai-responses.ts openai-chat.ts
src/stream/      sse.ts tee.ts anthropic-usage.ts responses-usage.ts chat-usage.ts
src/upstream/    forward.ts chain.ts breaker.ts retry-budget.ts
src/policy/      types.ts schema.ts json-schema.ts load-dir.ts validate.ts compile.ts decide.ts resolve.ts match.ts bundle.ts
src/policy-loader/ loader.ts lkg.ts
src/limits/      store.ts keys.ts gcra.ts estimator.ts memory-store.ts redis-store.ts lua.ts sweeper.ts warmup.ts
src/pricing/     prices.ts cost.ts
src/guardrails/  rules.ts scan.ts hmac.ts pii.ts redact.ts
src/ledger/      record.ts writer.ts reader.ts export.ts anonymize.ts
src/replay/      engine.ts sim-store.ts cost-model.ts fidelity.ts diff.ts render-terminal.ts render-json.ts render-markdown.ts
src/report/      report.ts render-terminal.ts render-html.ts
src/telemetry/   semconv.ts otel.ts metrics.ts
src/mock/        anthropic.ts openai.ts cache-sim.ts scenarios.ts session-fixture.ts traffic.ts
src/action/      main.ts
src/live/        harness.ts
test/            mirrors src/; plus test/arch, test/conformance/{anthropic,openai}, test/limits/budget-proof.test.ts,
                 test/live (never in CI), test/helpers/{naive-proxy.ts, policy.ts, gateway.ts}, test/fixtures/
test/live/policy.yaml               live-test policy with the 20 USD budget
bench/           overhead.ts budget.ts cache.ts scan.ts replay.ts calibration.ts run.ts results.json
examples/policy/ policy.yaml prices.yaml keys.yaml
examples/traces/ demo.ndjson.gz
examples/live/   anonymized live export excerpts and screenshots
docs/            conformance.md replay-json.md future-quality.md experimental-subscription.md security-review.md
```

---

### Task 1: Scaffold, bundle check and CI on Linux and Windows (day 1)

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `esbuild.config.mjs`, `.oxlintrc.json`, `LICENSE`, `src/cli.ts`, `scripts/check-bundle.mjs`, `scripts/check-no-secrets.mjs`, `.github/workflows/ci.yml`
- Modify: `.gitignore` (add `.live/`, `bench/tmp/`)
- Test: `test/arch/import-rules.test.ts`, `test/cli.test.ts`

**Interfaces:**
- Produces: npm scripts `build`, `check:bundle`, `typecheck`, `lint`, `test`, `test:redis`, `bench`, `bench:check`, `live`, `check:secrets`. `bin/tokenyard.mjs` with a `--version` command. `test/arch/import-rules.test.ts` exports nothing; later tasks add directories to its `PURE_DIRS` list only through this file.

- [ ] **Step 1: Write the failing tests**

```ts
// test/cli.test.ts
test('tokenyard --version prints package version', async () => {
  const { stdout } = await promisify(execFile)('node', ['bin/tokenyard.mjs', '--version']);
  expect(stdout.trim()).toBe(pkg.version);
});
// test/arch/import-rules.test.ts
const PURE_DIRS = ['src/policy', 'src/replay', 'src/surfaces', 'src/stream', 'src/pricing', 'src/guardrails', 'src/limits/estimator.ts'];
const FORBIDDEN = [/^node:(fs|net|http|https|child_process|dgram|dns)/, /^(undici|redis)$/, /\/edge\//, /\/limits\/redis-store/, /\/ledger\/(writer|reader)/];
test('pure modules import no I/O', () => { /* scan import specifiers with a regex over each .ts file; expect offenders toEqual([]) */ });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/cli.test.ts test/arch`
Expected: FAIL (no bundle).

- [ ] **Step 3: Implement**

`package.json`: `"type": "module"`, `"bin": { "tokenyard": "bin/tokenyard.mjs" }`, `"files": ["bin", "action.yml", "LICENSE", "README.md"]`, all libraries in `devDependencies`. `esbuild.config.mjs`: platform node, format esm, target node20, bundle, banner `#!/usr/bin/env node` plus a `createRequire` shim. `check-bundle.mjs` rebuilds to a temp file and byte-compares with `bin/tokenyard.mjs`. `check-no-secrets.mjs` scans `git ls-files` (and a tarball path when given) for `sk-ant-[A-Za-z0-9_-]{20,}` and `sk-proj-[A-Za-z0-9_-]{20,}` and exits 1 with the file name only, never the match. CI jobs: `test` (matrix ubuntu Node 20.19, 22, 24; windows Node 22) running `typecheck`, `lint`, `test`, `check:bundle`, `check:secrets`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && npm test && npm run check:bundle && npm run check:secrets`
Expected: all PASS, exit 0.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "chore: scaffold package, bundle check and CI"
```

---

### Task 2: SSE parser, tee and Anthropic usage accumulator (day 1)

**Files:**
- Create: `src/stream/sse.ts`, `src/stream/tee.ts`, `src/stream/anthropic-usage.ts`
- Test: `test/stream/sse.test.ts`, `test/stream/tee.test.ts`, `test/stream/anthropic-usage.test.ts`, fixtures `test/fixtures/sse/anthropic-*.txt`

**Interfaces:**
- Produces:
  - `interface SseEvent { event: string | null; data: string }`; `class SseParser { push(chunk: Buffer): SseEvent[]; end(): SseEvent[] }`
  - `createTee(onChunk: (chunk: Buffer) => void): Transform` (passes each chunk downstream before calling `onChunk`; exceptions in `onChunk` are caught and counted, never break the stream)
  - `interface Usage { input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number }`
  - `type UsageSource = 'final' | 'partial' | 'estimated' | 'none'`
  - `interface UsageResult { usage: Usage | null; source: UsageSource; midStreamError: string | null; sawStop: boolean; streamedChars: number; responseModel: string | null }`
  - `class AnthropicUsageAccumulator { onEvent(e: SseEvent): void; result(): UsageResult }`; `parseAnthropicJsonUsage(body: Buffer): UsageResult`

- [ ] **Step 1: Write the failing tests**

```ts
test('parser handles events split at every byte offset', () => { /* feed fixture 1 byte at a time; events equal whole-buffer parse */ });
test('parser handles CRLF, LF and CR line ends and multi-line data', ...);
test('message_delta usage overwrites message_start (cumulative)', () => {
  // message_start input 10, cache_read 100, cache_creation {ephemeral_5m 20, ephemeral_1h 30}; delta output 7; then output 42
  expect(acc.result()).toMatchObject({ source: 'final', usage: { input: 10, cacheRead: 100, cacheWrite5m: 20, cacheWrite1h: 30, output: 42 } });
});
test('cache_creation_input_tokens without split counts as 5m', ...);
test('stream ending after message_start without message_stop is partial', ...);
test('no message_delta usage: output estimated as ceil(streamed chars / 4), source estimated', ...);
test('event: error after 200 sets midStreamError to the error type', ...);   // overloaded_error
test('unknown event types and ping are ignored', ...);
test('tee emits identical bytes even when onChunk throws', ...);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/stream`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement the three modules**

Parser keeps a `Buffer` remainder and decodes UTF-8 only per complete line, so a multi-byte character split across chunks is never corrupted.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/stream`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/stream test/stream test/fixtures/sse && git commit -m "feat: SSE parser, tee and Anthropic usage accumulator"
```

---

### Task 3: Mock Anthropic provider with cache simulator (day 1)

**Files:**
- Create: `src/mock/anthropic.ts`, `src/mock/cache-sim.ts`, `src/mock/scenarios.ts`, `src/mock/session-fixture.ts`
- Modify: `src/cli.ts` (`tokenyard mock --port`)
- Test: `test/mock/cache-sim.test.ts`, `test/mock/anthropic.test.ts`

**Interfaces:**
- Consumes: `Usage` (Task 2).
- Produces:
  - `interface ReceivedRequest { method: string; pathAndQuery: string; headers: Record<string, string | string[]>; body: Buffer }`
  - `type Scenario = { kind: 'ok'; ttftMs: number; tokensPerSec: number; pingEveryMs: number | null; outputTokens: number } | { kind: 'midStreamError'; afterEvents: number; errorType: string } | { kind: 'status'; status: number; headers: Record<string, string>; body: string } | { kind: 'drop'; afterEvents: number } | { kind: 'hangBeforeHeaders' } | { kind: 'pauseAfterStart'; pauseMs: number } | { kind: 'randomUsage'; seed: number }`
  - `interface MockServer { url: string; received: ReceivedRequest[]; setScenario(s: Scenario | ((r: ReceivedRequest) => Scenario)): void; close(): Promise<void> }`
  - `startAnthropicMock(opts?: { workspace?: string; scenario?: Scenario }): Promise<MockServer>`
  - `class CacheSimulator { usageFor(body: unknown, model: string, nowMs: number): Usage }`
  - `buildAgentSession(turns: number, seed: number): Buffer[]` (Claude Code-shaped bodies: block-form `system` with `cache_control`, tools, growing messages, thinking blocks with signatures)

- [ ] **Step 1: Write the failing tests**

```ts
test('second identical prefix within 5 minutes is a cache read', () => {
  const sim = new CacheSimulator(); const b = session[0];
  expect(sim.usageFor(b, 'claude-opus-5-5', 0).cacheRead).toBe(0);
  expect(sim.usageFor(b, 'claude-opus-5-5', 60_000).cacheRead).toBeGreaterThan(0);
});
test('ttl 1h breakpoints survive 30 minutes, 5m ones do not', ...);
test('flattening system to a string changes the prefix and loses the cache', ...);
test('randomUsage returns input <= body bytes and output <= max_tokens, seeded', ...);
test('mock records method, path with query, headers and exact body bytes', ...);
test('40-turn session through the mock yields a deterministic usage sequence', ...); // snapshot
test('scenario 529 before headers, 429 with retry-after, drop after N events behave as scripted', ...);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/mock`
Expected: FAIL.

- [ ] **Step 3: Implement**

Cache simulator: hash of canonical bytes of `tools`, `system` and messages up to each `cache_control` breakpoint, per (workspace, model); token counts from `Buffer.byteLength / 4` (the mock's own deterministic tokenizer). `randomUsage` draws input in `[0, bodyBytes]` split randomly across the four input buckets and output in `[0, max_tokens]` with a seeded PRNG (`mulberry32`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/mock`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mock src/cli.ts test/mock && git commit -m "feat: deterministic Anthropic mock with prompt cache simulator"
```

---

### Task 4: Edge server and Messages passthrough (day 2)

**Files:**
- Create: `src/policy/types.ts`, `src/surfaces/types.ts`, `src/surfaces/anthropic-messages.ts`, `src/surfaces/anthropic-count-tokens.ts`, `src/surfaces/anthropic-models.ts`, `src/edge/{server,paths,auth,body,headers,errors,handler}.ts`, `src/upstream/forward.ts`, `test/helpers/policy.ts`, `test/helpers/gateway.ts`
- Modify: `src/cli.ts` (`serve`)
- Test: `test/edge/*.test.ts`, `test/surfaces/anthropic-messages.test.ts`

**Interfaces:**
- Consumes: `createTee`, `AnthropicUsageAccumulator` (Task 2); `startAnthropicMock` (Task 3).
- Produces:
  - `src/policy/types.ts`: the spec 6.5 types verbatim (`RequestFeatures`, `GuardrailHit`, `Plan`, `Admission`, `Decision`) plus `type Surface`, `BlockReason = 'no-route' | 'model-not-allowed' | 'secret' | 'taint' | 'budget' | 'rate' | 'streams' | 'store-down' | 'unpriced' | 'server-tool-no-max-uses'`, `ProviderSpec { name: string; format: 'anthropic' | 'openai'; baseUrl: string; credential: { env: string } | 'passthrough' }`, `KeyRecord { hash: string; keyId: string; tenant: string; team: string | null; name: string; kind: 'developer' | 'service'; billing: 'api' | 'subscription' }`, and `CompiledPolicy` (fields filled by Task 10; Tasks 4 to 9 use `test/helpers/policy.ts`).
  - `src/surfaces/types.ts`: `interface ExtractedFeatures { model: string | null; stream: boolean; maxOutputTokens: number | null; toolCount: number; thinking: boolean; serverTools: Array<{ type: string; maxUses: number | null }>; bodyBytes: number; prefixHash: string | null; blockTypes: string[]; expandsServerSide: boolean; parseError: boolean; lastTurn: { start: number; end: number } | null }` (`lastTurn` is a byte range into the original body for the scanner)
  - `extractAnthropicFeatures(body: Buffer): ExtractedFeatures`
  - `matchRoute(method: string, rawUrl: string, basePath: string | null): { surface: Surface | 'models' | 'hello'; pathAndQuery: string } | null`
  - `extractCredential(h: IncomingHttpHeaders): { source: 'x-tokenyard-key' | 'bearer' | 'x-api-key'; value: string } | null`; `hashKey(v: string): string` (SHA-256 hex)
  - `readBody(req: IncomingMessage, capBytes: number): Promise<Buffer>` (throws `BodyTooLargeError`)
  - `upstreamHeaders(inbound: IncomingHttpHeaders, opts: { mode: 'api' | 'passthrough'; credential: { header: 'x-api-key' | 'authorization'; value: string } | null; host: string }): Record<string, string | string[]>`; `clientHeaders(up: IncomingHttpHeaders, extra: Record<string, string>): Record<string, string | string[]>`
  - `anthropicError(status: number, type: string, message: string, retryAfterS: number | null, requestId: string): { status: number; headers: Record<string, string>; body: Buffer }`
  - `interface ForwardRequest { method: string; pathAndQuery: string; headers: Record<string, string | string[]>; body: Buffer }`; `interface UpstreamResponse { status: number; headers: IncomingHttpHeaders; body: Readable }`; `forward(p: ProviderSpec, r: ForwardRequest, signal: AbortSignal): Promise<UpstreamResponse>`
  - `interface TraceSink { write(r: Omit<TraceRecord, 'instance' | 'seq'>): boolean }` (implemented by `TraceWriter`, Task 7; `null` until then)
  - `interface GatewayDeps { policy(): CompiledPolicy; store: CounterStore | null; traces: TraceSink | null; clock(): number; newId(): string; basePath: string | null; bodyCapBytes: number }` and `createGateway(deps: GatewayDeps): { listen(port: number, host?: string): Promise<string>; close(): Promise<void> }`
  - CLI `serve --dev-upstream <url>`: a development flag that builds the `test/helpers/policy.ts` single-route policy pointing at `<url>`; it stays as a documented dev flag after Task 10

- [ ] **Step 1: Write the failing tests**

```ts
test('upstream receives the exact body bytes and the query string', async () => { /* POST /v1/messages?beta=true; mock.received[0].body equals sent Buffer; pathAndQuery '/v1/messages?beta=true' */ });
test('hop-by-hop, host, accept-encoding and x-tokenyard-* are not forwarded; anthropic-beta verbatim', ...);
test('API mode replaces the inbound credential with the provider key', ...);
test('headers flushed before first body byte; X-Accel-Buffering: no; no content-encoding', ...);
test('client abort closes the upstream connection within 100 ms', ...);
test('upstream 529 body, status and retry-after reach the client unchanged', ...);
test('body over cap gets 413 in the Anthropic envelope', ...);
test('GET /v1/models?limit=1000 lists only claude ids, no redirect, under 3 s', ...);
test('HEAD /api/hello returns empty 200; count_tokens is forwarded without reservation', ...);
test('invalid JSON body is forwarded unchanged and the provider 400 reaches the client', ...); // Review Focus 2
test('extractAnthropicFeatures: server tools with max_uses, block types, image block sets expandsServerSide', ...);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/edge test/surfaces`
Expected: FAIL.

- [ ] **Step 3: Implement**

`handler.ts` runs spec 5.3 steps 1 to 4 and 9 to 12; steps 5 to 8 call `deps.policy()`-based hooks that are no-ops until Tasks 10 and 14 (a `forwardToFirstProvider` plan from `test/helpers/policy.ts`). `pipeline(upstream.body, tee, res)` with backpressure; `AbortController` tied to `res.on('close')` before `writableFinished`. `accept-encoding: identity` upstream.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/edge test/surfaces`
Expected: PASS.

- [ ] **Step 5: Manual check with real Claude Code against the mock (no spend)**

Run: `node bin/tokenyard.mjs mock --port 4010 &` and `node bin/tokenyard.mjs serve --dev-upstream http://127.0.0.1:4010 --port 4000`, then `ANTHROPIC_BASE_URL=http://127.0.0.1:4000 ANTHROPIC_AUTH_TOKEN=ty_live_dev claude -p "say hi"`.
Expected: the reply from the mock prints; record the Claude Code version for Task 5's doc.

- [ ] **Step 6: Commit**

```bash
git add src test && npm run build && git add bin && git commit -m "feat: edge server with byte-faithful Messages passthrough"
```

---

### Task 5: Anthropic conformance suite (day 2)

**Files:**
- Create: `test/conformance/anthropic/c01-body-bytes.test.ts` through `c16-attribution.test.ts`, `test/conformance/fixtures/*.json`, `test/helpers/naive-proxy.ts`, `scripts/gen-conformance-doc.mjs`, `docs/conformance.md`
- Test: the files above

**Interfaces:**
- Consumes: `createGateway` (Task 4), `startAnthropicMock`, `buildAgentSession` (Task 3).
- Produces: `startNaiveProxy(upstreamUrl: string): Promise<{ url: string; close(): Promise<void> }>` (flattens `system` to a string, re-serialises JSON); test titles of the form `C<n> <rule> [<doc url>]` that `gen-conformance-doc.mjs` turns into a table; Tasks 6, 14 and 20 add `C17`, `C18` and `R<n>` tests in the same format.

- [ ] **Step 1: Write the tests, one file per spec section 10 item 1 to 16**

```ts
test('C1 body bytes upstream equal client bytes [https://code.claude.com/docs/en/llm-gateway-protocol.md]', async () => {
  for (const f of fixtures) { await send(f); expect(mock.received.at(-1)!.body.equals(f.bytes)).toBe(true); }
});
test('C6 message_start reaches the client before a 2 s upstream pause ends', ...);   // scenario pauseAfterStart 2000; assert receipt time < 1000 ms
test('C15 40-turn session: usage identical through tokenyard and direct', ...);
test('C15b the naive proxy fails the cache integrity check', async () => { expect(await cacheIntegrity(naiveProxyUrl)).toBe(false); });
```

Fixtures cover every body item in spec 10.1: `cache_control` on system and messages, block-form `system`, mid-conversation `role: "system"`, thinking with signatures, `output_config`, `context_management`, tools with `strict` and `defer_loading`, unknown top-level fields, a tool `pattern` with `\p{L}`.

- [ ] **Step 2: Run the suite**

Run: `npx vitest run test/conformance/anthropic`
Expected: PASS for C1 to C16 (Task 4 already implements the behaviour). Any failure is a Task 4 bug: fix in `src/edge` or `src/stream`, never in the test.

- [ ] **Step 3: Generate the doc**

Run: `node scripts/gen-conformance-doc.mjs > docs/conformance.md`
Expected: a table of 16 rows plus a "Client versions checked by hand" section holding the Claude Code version from Task 4 Step 5.

- [ ] **Step 4: Commit**

```bash
git add test/conformance test/helpers/naive-proxy.ts scripts/gen-conformance-doc.mjs docs/conformance.md && git commit -m "test: Anthropic protocol conformance suite"
```

---

### Task 6: Keys, attribution, pricing, cost and experimental subscription passthrough (day 3)

**Files:**
- Create: `src/edge/keys.ts`, `src/edge/attribution.ts`, `src/pricing/prices.ts`, `src/pricing/cost.ts`, `examples/policy/prices.yaml`, `docs/experimental-subscription.md`
- Modify: `src/edge/handler.ts`, `src/edge/headers.ts`, `src/cli.ts` (`keys create`, `env`, `serve --experimental-subscription`)
- Test: `test/edge/keys.test.ts`, `test/edge/attribution.test.ts`, `test/pricing/*.test.ts`, `test/conformance/anthropic/c17-subscription.test.ts`, `test/cli/env.test.ts`

**Interfaces:**
- Consumes: `KeyRecord`, `ProviderSpec` (Task 4), `Usage` (Task 2).
- Produces:
  - `createKey(): { plaintext: string; hash: string }` (`ty_live_` + base62 of 32 random bytes); `appendKey(file: string, rec: Omit<KeyRecord, 'hash'> & { hash: string }): Promise<void>`
  - `interface RawAttribution { session; agent; parentAgent; requestClass; agentType; promptId; repo; branch; ticket; feature }` (all `string | null`); `readAttribution(h: IncomingHttpHeaders, surface: Surface): RawAttribution`
  - `interface ModelPrice { input: number; output: number; cacheWrite5m: number; cacheWrite1h: number; cacheRead: number; maxContextTokens: number; maxOutputTokens: number; tiers?: Array<{ aboveInputTokens: number; input: number; output: number; cacheWrite5m: number; cacheWrite1h: number; cacheRead: number }>; source: string; retrieved: string }` (USD per million tokens)
  - `interface PriceTable { version: string; models: Record<string, ModelPrice>; modifiers: Record<string, number>; serverTools: Record<string, { perUseUsd: number; maxIterations: number; source: string; retrieved: string }> }`
  - `parsePriceTable(text: string): PriceTable`; `lookupModel(t: PriceTable, model: string): { id: string; price: ModelPrice } | null` (exact id, else the longest table id followed by `-` that prefixes the model, so dated ids resolve)
  - `costMicroUsd(t: PriceTable, modelId: string, u: Usage, o?: { modifiers?: string[]; serverToolUses?: Record<string, number> }): number`

- [ ] **Step 1: Write the failing tests**

```ts
test('cost of Opus 5.5 usage in micro-USD', () => {
  // input 1000*4 + cw5m 2000*5 + cw1h 3000*8 + read 10000*0.2 + output 500*20 = 4000+10000+24000+2000+10000
  expect(costMicroUsd(t, 'claude-opus-5-5', { input: 1000, cacheWrite5m: 2000, cacheWrite1h: 3000, cacheRead: 10000, output: 500 })).toBe(50_000);
});
test('inferenceGeoUs modifier multiplies every bucket by 1.1', ...);
test('tier above 100k input tokens uses the tier prices', ...);
test('dated model id resolves to its table entry; unknown returns null', ...);
test('price table without maxContextTokens is rejected', ...);
test('createKey: ty_live_ prefix, 32 random bytes, hash is sha256 hex of plaintext', ...);
test('attribution: x-claude-code-* headers and x-tokenyard-repo/branch/ticket parsed; codex session_id and session-id', ...);
test('tokenyard env prints ANTHROPIC_CUSTOM_HEADERS with repo, branch and ticket parsed by --ticket-pattern', ...);
test('C17 subscription passthrough: OAuth Authorization and anthropic-beta reach the mock unchanged, x-tokenyard-key stripped, cost basis api-equivalent', ...);
test('C17b subscription key is refused (401) when the gateway runs without --experimental-subscription', ...);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/pricing test/edge/keys.test.ts test/edge/attribution.test.ts test/conformance/anthropic/c17-subscription.test.ts test/cli/env.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`examples/policy/prices.yaml` takes every value from the Claude pricing page and the models overview page, with `source` and `retrieved: 2026-11-02` per entry; no value is typed from memory. `docs/experimental-subscription.md` holds the manual check list, headed "Status: not run (blocked on spec risk R2)".

- [ ] **Step 4: Run tests to verify they pass**

Run: same command as Step 2.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src test examples/policy/prices.yaml docs/experimental-subscription.md && npm run build && git add bin && git commit -m "feat: keys, attribution, cost and experimental subscription passthrough"
```

---

### Task 7: Trace ledger, export with instances, anonymize, minimal report (day 3)

**Files:**
- Create: `src/ledger/{record,writer,reader,export,anonymize}.ts`, `src/guardrails/hmac.ts`, `src/report/report.ts`, `src/report/render-terminal.ts`
- Modify: `src/edge/handler.ts` (queue a record after `res.end()`), `src/cli.ts` (`traces export`, `traces prune`, `report`, `serve --trace-dir --instance-id`)
- Test: `test/ledger/*.test.ts`, `test/report/report.test.ts`

**Interfaces:**
- Consumes: `UsageResult` (Task 2), `RawAttribution`, `costMicroUsd` (Task 6).
- Produces:
  - `TraceRecord` exactly as spec 9.1 (with `kind: 'request'`, `instance`, `seq`); `SegmentRecord`, `HeartbeatRecord`, `ShutdownRecord`, `ManifestRecord` as spec 9.1 and 9.5; `type LedgerLine = TraceRecord | SegmentRecord | HeartbeatRecord | ShutdownRecord | ManifestRecord`
  - `pseudonym(salt: string, value: string): string` (HMAC-SHA256, first 32 hex chars)
  - `class TraceWriter { constructor(o: { dir: string; instanceId: string; queueMax: number; clock(): number }); write(r: Omit<TraceRecord, 'instance' | 'seq'>): boolean; heartbeat(): void; close(): Promise<void>; readonly dropped: number }`
  - `defaultInstanceId(hostname: string, startedAtMs: number): string` (8 hex chars)
  - `readLedger(paths: string[]): AsyncIterable<LedgerLine>` (plain or `.gz`)
  - `exportTraces(o: { dir: string; sinceMs: number; untilMs: number; out: string; anonymizeSalt?: string }): Promise<ManifestRecord>`
  - `anonymizeRecord(r: TraceRecord, p: (kind: 'tenant' | 'team' | 'key' | 'repo' | 'branch' | 'ticket', v: string) => string): TraceRecord`
  - `buildReport(records: TraceRecord[], by: Array<'tenant' | 'team' | 'key' | 'repo' | 'branch' | 'ticket' | 'session' | 'requestClass' | 'agent' | 'promptId'>): Report`; `renderReportTerminal(r: Report): string`

- [ ] **Step 1: Write the failing tests**

```ts
test('writer names files <tenant>/<YYYY-MM-DD>/<HH>.<instance>.ndjson and starts each with a segment record', ...);
test('seq increases by one per request record; overflow drops and increments dropped', ...);
test('records contain no prompt text: a body with a canary string never appears in any trace file', ...);
test('export merges two instances ordered by ts then id and writes the manifest first', ...);
test('manifest reports seqGaps and hoursWithoutFile for an instance missing one hour between heartbeats', ...);
test('export --anonymize maps tenant, team, key, repo, branch, ticket to stable pseudonyms and drops client.version', ...);
test('records written across an hour boundary land in the file of their write hour and still export in ts order', ...);
test('report splits cost by team and by request class; totals equal the sum of records', ...);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/ledger test/report`
Expected: FAIL.

- [ ] **Step 3: Implement**

The queue drains with `fs.promises.appendFile` per batch; hourly rotation by the record's write time; heartbeat called by the sweeper tick (Task 13) and by a 60 s timer until then. HMAC salt from `--trace-salt` or `TOKENYARD_TRACE_SALT`; the gateway refuses to start without one when `--trace-dir` is set.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/ledger test/report`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src test && npm run build && git add bin && git commit -m "feat: NDJSON trace ledger with instance files, export and report"
```

---

### Task 8: Policy schema, validation and `policy check` (day 4)

**Files:**
- Create: `src/policy/schema.ts`, `src/policy/json-schema.ts`, `src/policy/load-dir.ts`, `src/policy/validate.ts`, `examples/policy/policy.yaml`, `examples/policy/keys.yaml`, `test/fixtures/policy/<CODE>/` (one directory per error and warning code)
- Modify: `src/cli.ts` (`policy check`, `policy schema`)
- Test: `test/policy/schema.test.ts`, `test/policy/validate.test.ts`

**Interfaces:**
- Consumes: `parsePriceTable` (Task 6), `KeyRecord` (Task 4).
- Produces:
  - `PolicyDoc` (zod-inferred type of spec 6.3, including `reservation.serverToolsWithoutMaxUses`, `reservation.assumedMaxUses` default 25, `rateLimits[].concurrentStreams`, `guardrails.secrets.taintTtlHours`)
  - `interface PolicySource { dir: string; policy: PolicyDoc; prices: PriceTable; keys: KeyRecord[]; normalizedFiles: Record<string, string> }`
  - `loadPolicyDir(dir: string): Promise<PolicySource>` (strips a UTF-8 BOM and converts CRLF to LF before parsing)
  - `interface Issue { code: string; path: string; message: string }`; `validatePolicy(src: PolicySource, o: { experimentalSubscription: boolean }): { errors: Issue[]; warnings: Issue[] }`
  - Error codes: `E_CHAIN_UNKNOWN_PROVIDER`, `E_CHAIN_LENGTH`, `E_CODING_AGENT_FORMAT`, `E_CODING_AGENT_NON_CLAUDE`, `E_BODY_REWRITE`, `E_PASSTHROUGH_HOST`, `E_SUBSCRIPTION_FLAG`, `E_UNPRICED_MODEL`, `E_MODEL_LIMITS`, `E_UNPRICED_SERVER_TOOL`, `E_BUDGET_DUP`, `E_BUDGET_WINDOW`, `E_BUDGET_USD`, `E_STORE_DOWN_UNSTATED`. Warning codes: `W_CHILD_BUDGET`, `W_SURFACE_NO_ROUTE`, `W_ROUTE_SHADOWED`, `W_SESSION_AWARE_BLOCK`, `W_SERVER_TOOLS_ASSUME`, `W_SUBSCRIPTION_BLOCK`
  - `policyJsonSchema(): object`

- [ ] **Step 1: Write the failing tests**

```ts
test.each(codes)('fixture %s produces exactly that issue code', async (code) => {
  const r = validatePolicy(await loadPolicyDir(`test/fixtures/policy/${code}`), { experimentalSubscription: false });
  expect([...r.errors, ...r.warnings].map(i => i.code)).toEqual([code]);
});
test('examples/policy validates with 0 errors', ...);
test('passthrough credential is valid with experimentalSubscription true and E_SUBSCRIPTION_FLAG without', ...);
test('CRLF and BOM copies of examples/policy parse to the same normalizedFiles', ...); // Review Focus 5
test('policy schema output is valid JSON Schema and lists every top-level key', ...);
test('policy check exits 1 on errors, 0 with warnings, and prints code and path per issue', ...);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/policy`
Expected: FAIL.

- [ ] **Step 3: Implement**

Zod v4 with `z.toJSONSchema` for the export. The example policy is spec 6.3 verbatim (no subscription items).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/policy && node bin/tokenyard.mjs policy check examples/policy`
Expected: PASS; check prints `0 errors`.

- [ ] **Step 5: Commit**

```bash
git add src/policy src/cli.ts examples/policy test && npm run build && git add bin && git commit -m "feat: policy schema, semantic validation and policy check"
```

---

### Task 9: Worst-case estimator (day 4)

**Files:**
- Create: `src/limits/estimator.ts`
- Test: `test/limits/estimator.test.ts`

**Interfaces:**
- Consumes: `ExtractedFeatures` (Task 4), `ModelPrice`, `PriceTable`, `costMicroUsd` (Task 6), `RequestFeatures` (Task 4).
- Produces:
  - `OVERHEAD_TOKENS = 4096`; `TEXT_BLOCK_TYPES = ['text', 'thinking', 'redacted_thinking', 'tool_use', 'tool_result']`
  - `inputTokenBound(x: ExtractedFeatures, m: ModelPrice): { tokens: number; kind: 'bytes' | 'context-window' }`
  - `maxInputRate(m: ModelPrice): number`; `maxOutputRate(m: ModelPrice): number`; `modifierProduct(t: PriceTable): number` (product of modifiers above 1)
  - `worstCaseMicroUsd(f: RequestFeatures, m: ModelPrice, t: PriceTable, o: { serverToolsWithoutMaxUses: 'block' | 'assume'; assumedMaxUses: number; reserveOutputTokens: number | null }): { micro: number; boundAssumed: boolean; block: 'server-tool-no-max-uses' | 'unpriced-server-tool' | null }`
  - `sessionAwareMicroUsd(f: RequestFeatures, m: ModelPrice, t: PriceTable, prevCacheReadShare: number | null, reserveOutputTokens: number | null): number`

- [ ] **Step 1: Write the failing tests**

```ts
test('spec 7.4 example: 150,000-byte text body, max_tokens 32,000, Opus 5.5', () => {
  // input (150_000 + 4096) * 8 = 1_232_768; output 32_000 * 20 = 640_000; * 1.1 = 2_060_044.8
  expect(worstCaseMicroUsd(f, opus, table, opts).micro).toBe(2_060_045);
});
test('bytes bound is capped at maxContextTokens', ...);
test('image, document, file or url source, mcp_servers, container or unknown block type gives context-window', ...);
test('parse error or missing model gives context-window and is priced at the most expensive model', ...); // Review Focus 2
test('web_search max_uses 5: input and output bounds times maxIterations, plus 5 * perUseUsd', ...);
test('server tool without max_uses: block by default; assume uses assumedMaxUses and sets boundAssumed', ...);
test('Responses request without max_output_tokens uses maxOutputTokens', ...);
test('property: any usage with input <= bound and output <= max_tokens costs <= the reservation', () => {
  fc.assert(fc.property(arbUsageWithinBound, ({ f, u, model }) => costMicroUsd(table, model, u, allModifiers) <= worstCaseMicroUsd(f, table.models[model]!, table, opts).micro));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/limits/estimator.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Pure functions only; `Math.ceil` once on the final micro-USD sum.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/limits/estimator.test.ts test/arch`
Expected: PASS (import rule includes `src/limits/estimator.ts`).

- [ ] **Step 5: Commit**

```bash
git add src/limits/estimator.ts test/limits/estimator.test.ts && git commit -m "feat: worst-case reservation estimator with provable input bound"
```

---

### Task 10: Compiler, `decide` and `resolve` (day 4)

**Files:**
- Create: `src/policy/compile.ts`, `src/policy/match.ts`, `src/policy/decide.ts`, `src/policy/resolve.ts`
- Modify: `src/policy/types.ts` (fill `CompiledPolicy`), `src/edge/handler.ts` (use `decide` and `resolve`; `admit` still a stub until Task 14), `test/helpers/policy.ts` (build from `examples/policy` through `compilePolicy`)
- Test: `test/policy/decide.test.ts`, `test/policy/decide.property.test.ts`

**Interfaces:**
- Consumes: `PolicySource` (Task 8), `worstCaseMicroUsd`, `sessionAwareMicroUsd` (Task 9), `lookupModel` (Task 6).
- Produces:
  - `compilePolicy(src: PolicySource, revision: string, o: { experimentalSubscription: boolean }): CompiledPolicy` (deep-frozen; throws `PolicyInvalidError` with the issues when `validatePolicy` has errors)
  - `CompiledPolicy { revision: string; priceTableVersion: string; providers: ReadonlyMap<string, ProviderSpec>; keysByHash: ReadonlyMap<string, KeyRecord>; routes: readonly CompiledRoute[]; budgets: readonly CompiledBudget[]; rateLimits: readonly CompiledRate[]; streamLimits: readonly CompiledStreamLimit[]; reservation: PolicyDoc['reservation']; guardrails: PolicyDoc['guardrails']; failure: PolicyDoc['failure']; ci: PolicyDoc['ci']; prices: PriceTable; candidate: CompiledPolicy | null }`
  - `budgetKey(tenant: string, budget: string, scopeValue: string, windowStart: string | null): string` in `src/limits/keys.ts` (always `ty:{tenant}:b:...`)
  - `decide(policy: CompiledPolicy, f: RequestFeatures): Plan`; `resolve(policy: CompiledPolicy, plan: Plan, admission: Admission | null): Decision`
  - `buildFeatures(x: ExtractedFeatures, key: KeyRecord, attr: RawAttribution, hits: GuardrailHit[], prices: PriceTable, id: string, ts: number, surface: Surface): RequestFeatures` in `src/policy/decide.ts`

- [ ] **Step 1: Write the failing tests**

```ts
test('first matching route wins over surface, traffic, billing, team, requestClass, agentType, repo, feature, model glob', ...);
test('model outside allowModels gives preBlock model-not-allowed and resolve returns 403 permission_error', ...);
test('no route gives preBlock no-route and 403', ...);
test('reservations cover tenant, team, key, repo and session levels with budgetKey and window start in UTC', ...);
test('weighted chain picks by hash of session id, stable across calls', ...);
test('audit-mode budget appears with enforce false', ...);
test('resolve maps budget failure to 429 rate_limit_error without retry-after; rate to 429 with integer retry-after <= 60; streams to 429 retry-after 1; taint and secret to 400; store-down closed to 503 retry-after 5', ...);
test('candidate policy produces its own plan for the trace', ...);
test('property: decide and resolve return deep-equal results for the same arguments', () => fc.assert(...));
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/policy`
Expected: FAIL on the new files.

- [ ] **Step 3: Implement**

Globs compile to anchored RegExps once at compile time. `decide` reads `f.ts` for window starts; never `Date.now()`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/policy test/arch test/conformance`
Expected: PASS; conformance still green with the real `decide`.

- [ ] **Step 5: Commit**

```bash
git add src test && npm run build && git add bin && git commit -m "feat: policy compiler and pure decide and resolve"
```

---

### Task 11: Bundles, loader, last-known-good and audit mode (day 5)

**Files:**
- Create: `src/policy/bundle.ts`, `src/policy-loader/loader.ts`, `src/policy-loader/lkg.ts`
- Modify: `src/cli.ts` (`policy build`, `serve --policy | --policy-url --state-dir --candidate-policy`)
- Test: `test/policy/bundle.test.ts`, `test/policy-loader/loader.test.ts`

**Interfaces:**
- Consumes: `loadPolicyDir`, `validatePolicy` (Task 8), `compilePolicy` (Task 10).
- Produces:
  - `interface Bundle { manifest: { revision: string; schemaVersion: 1; createdAt: string; sha256: string }; policy: PolicyDoc; prices: PriceTable; keys: KeyRecord[] }`
  - `buildBundle(src: PolicySource, o: { revision?: string; createdAt: string }): Bundle` (sha256 over canonical JSON of policy, prices and sorted keys; revision `GITHUB_SHA` or first 12 hex of sha256)
  - `class PolicyLoader extends EventEmitter { constructor(o: { dir?: string; url?: string; stateDir: string; pollMs?: number; debounceMs?: number; experimentalSubscription: boolean }); start(): Promise<void>; active(): CompiledPolicy; stop(): Promise<void>; readonly loadErrors: number }` (events `loaded`, `error`)

- [ ] **Step 1: Write the failing tests**

```ts
test('bundle sha256 is stable across key order and CRLF', ...);
test('file change swaps the snapshot; in-flight request keeps its revision', ...);
test('swap under load: 200 concurrent requests during 5 swaps, zero failed', ...);
test('broken file keeps the old revision and increments loadErrors', ...);
test('truncated mid-write then complete write: old revision serves, then the new one activates', ...); // Review Focus 3
test('URL source: If-None-Match sent, 304 keeps snapshot, redirect is an error', ...);
test('unreachable source at start uses last-known-good from stateDir; none and no source refuses to start', ...);
test('bundle with wrong sha256 is rejected', ...);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/policy/bundle.test.ts test/policy-loader`
Expected: FAIL.

- [ ] **Step 3: Implement**

Debounce 250 ms, poll 15 s; one reference swap `this.current = compiled`. `--candidate-policy` loads a second source into `compiled.candidate`.

- [ ] **Step 4: Run tests to verify they pass**

Run: same as Step 2.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src test && npm run build && git add bin && git commit -m "feat: policy bundles, hot swap with last-known-good and audit candidate"
```

---

### Task 12: Chain executor, retry budget and circuit breaker (day 5)

**Files:**
- Create: `src/upstream/chain.ts`, `src/upstream/breaker.ts`, `src/upstream/retry-budget.ts`
- Modify: `src/edge/handler.ts`
- Test: `test/upstream/*.test.ts`

**Interfaces:**
- Consumes: `forward` (Task 4), `Plan.chain` (Task 10), `failure.breaker` and `retryBudgetRatio` from `CompiledPolicy`.
- Produces:
  - `class Breaker { constructor(o: { minRequests: number; failureRatio: number; windowSeconds: number; openSeconds: number }, clock: () => number); allow(provider: string): boolean; record(provider: string, ok: boolean): void; open(provider: string, untilMs: number): void }`
  - `class RetryBudget { constructor(ratio: number, clock: () => number); request(tenant: string): void; tryRetry(tenant: string): boolean }`
  - `runChain(plan: Plan, policy: CompiledPolicy, req: ForwardRequest, signal: AbortSignal, deps: { breaker: Breaker; retry: RetryBudget }): Promise<{ attempt: number; provider: string; response: UpstreamResponse }>`

- [ ] **Step 1: Write the failing tests**

```ts
test('connect error, 500, 502, 503, 504, 529 before headers fall back to the next provider', ...);
test('429 with retry-after is forwarded unchanged unless fallbackOn429', ...);
test('spend-cap 429 opens that provider breaker for openSeconds', ...);
test('other 4xx forwarded unchanged, no fallback', ...);
test('no retry once a byte was written; never more than 3 attempts', ...);
test('retry budget of 10% stops fallback storms', ...);
test('fallback to another workspace marks cacheColdRisk', ...);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/upstream`
Expected: FAIL.

- [ ] **Step 3: Implement** the three classes and the executor; the handler writes headers only after `runChain` returns.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/upstream test/conformance`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src test && npm run build && git add bin && git commit -m "feat: provider chain with fallback rules, retry budget and breaker"
```

---

### Task 13: Counter stores: memory and Redis (day 6)

**Files:**
- Create: `src/limits/store.ts`, `src/limits/gcra.ts`, `src/limits/memory-store.ts`, `src/limits/redis-store.ts`, `src/limits/lua.ts`, `src/limits/sweeper.ts`, `src/limits/warmup.ts`
- Modify: `src/limits/keys.ts`
- Test: `test/limits/store-contract.ts`, `test/limits/memory-store.test.ts`, `test/limits/redis-store.test.ts`, `test/limits/gcra.test.ts`, `test/limits/keys.test.ts`

**Interfaces:**
- Consumes: `Plan`, `Admission` (Task 4 types), `budgetKey` (Task 10), `TraceRecord`, `readLedger` (Task 7).
- Produces:
  - `CounterStore` exactly as spec 7.1 including `seed`
  - `gcra(tatMs: number | null, nowMs: number, emissionMs: number, burst: number, quantity: number): { allowed: boolean; tatMs: number; retryAfterMs: number }`
  - `createMemoryStore(o: { clock(): number }): CounterStore`; `createRedisStore(client: RedisClientType, o: { deadlineMs: number }): CounterStore`
  - `streamKey(tenant, limit, key)`, `taintKey(tenant, session)`, `reservationKey(tenant, id)`, `deadlinesKey(tenant)`, `gcraKey(tenant, limit, key)` in `src/limits/keys.ts`
  - `startSweeper(store: CounterStore, o: { intervalMs: number; onTick?: () => void; lock?: { acquire(): Promise<boolean> } }): () => void`
  - `warmupEntries(records: AsyncIterable<LedgerLine>, policy: CompiledPolicy, nowMs: number): Promise<Array<{ key: string; spentMicroUsd: number; ttlMs: number }>>`
  - `runStoreContract(name: string, make: () => Promise<CounterStore>): void` (shared Vitest suite)

- [ ] **Step 1: Write the contract suite (fails for both stores)**

```ts
test('admit reserves on every level and returns post-admit totals', ...);
test('enforced level with spent + reserved + est > limit fails with kind budget; nothing written', ...);
test('audit level that would fail is reported in audit and still reserved', ...);
test('duplicate admit for the same id makes no second reservation', ...);
test('settle replaces reserved with actual and is idempotent (second call returns unknown)', ...);
test('GCRA: burst then retryAfterMs; a check with quantity q consumes q emission intervals', ...);
test('stream slots: max reached fails kind streams; settle and sweep free the slot', ...);
test('taint add writes the HMAC with TTL and nothing else; later check with that HMAC fails kind taint', ...);
test('sweep settles overdue reservations at the estimate', ...);
test('seed sets spent for warm-up keys', ...);
test('every key the store writes contains {tenant}', ...);
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/limits` and `REDIS_URL=redis://127.0.0.1:6379 npx vitest run test/limits/redis-store.test.ts` (Redis from `docker run -p 6379:6379 redis:7`)
Expected: FAIL.

- [ ] **Step 3: Implement**

Memory store: no `await` between check and write inside `admit`. Redis: scripts from spec 7.2 as string constants in `lua.ts`, loaded with `SCRIPT LOAD` and called with `EVALSHA` (fallback `EVAL` on `NOSCRIPT`); all keys of one call share `{tenant}`. Sweeper lock: `SET ty:{tenant}:sweep-lock <instance> NX PX 25000`. The sweeper tick also calls `TraceWriter.heartbeat()`.

- [ ] **Step 4: Run to verify pass**

Run: same as Step 2.
Expected: PASS on memory; PASS on Redis when `REDIS_URL` is set (`test:redis` script).

- [ ] **Step 5: Commit**

```bash
git add src/limits test/limits && git commit -m "feat: atomic counter stores with budgets, GCRA, stream slots and taint"
```

---

### Task 14: Admission in the gateway, budget proof and coverage tests (day 6)

**Files:**
- Modify: `src/edge/handler.ts`, `src/edge/server.ts`, `src/cli.ts` (`serve --store memory|redis --redis-url`)
- Create: `test/limits/budget-proof.test.ts`, `test/edge/admission.test.ts`, `test/edge/route-coverage.test.ts`, `test/conformance/anthropic/c18-stream-cap.test.ts`

**Interfaces:**
- Consumes: `CounterStore` (Task 13), `decide`, `resolve` (Task 10), `TraceWriter` (Task 7), `costMicroUsd` (Task 6), mock scenario `randomUsage` (Task 3).
- Produces: the full spec 5.3 lifecycle; `settle` after `res.end()` with the computed cost; trace fields `decision.reservedMicroUsd`, `boundAssumed`, `taintUnchecked`, `outcome.overrun`, `usageSource`, `settledBy`. `ROUTE_TABLE: ReadonlyArray<{ method: string; path: string; inference: boolean }>` exported from `src/edge/paths.ts`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/limits/budget-proof.test.ts, run for memory always and redis with REDIS_URL
test('G4: 1,000 concurrent requests, $1 budget, random actual cost up to each reservation', async () => {
  // each request's own reservation <= $1; mock scenario randomUsage(seed)
  expect(maxObservedSpentPlusReserved).toBeLessThanOrEqual(1_000_000);   // (a) from Admission.totals after every admit
  expect(final.spent).toBeLessThanOrEqual(1_000_000);                    // (b)
  expect(final.spent).toBe(sumOfSettledCosts); expect(final.reserved).toBe(0);  // (c)
  for (const r of rejected) expect(r.spent + r.reserved + r.est).toBeGreaterThan(1_000_000);  // (d)
  expect(traces.some(t => t.outcome.overrun)).toBe(false);
});
test('property: memory store admit outcomes equal a sequential model applied in commit order', () => fc.assert(...));
test('every inference route in ROUTE_TABLE calls admit', ...);                       // spec 7.4 coverage
test('aborted stream after message_start settles partial usage, never zero', ...);
test('client abort before upstream headers: upstream aborted, settled 0, slot freed, aborted true', ...);  // Review Focus 1
test('request whose own reservation exceeds the limit gets 429 naming reservation and limit, nothing reserved', ...); // Review Focus 4
test('store down: budgets closed gives 503 retry-after 5; rate limits open; trace marks storeDown', ...);
test('C18 per-key stream cap: third concurrent stream gets 429 retry-after 1; slot frees on end, abort and sweep', ...);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/limits/budget-proof.test.ts test/edge test/conformance/anthropic/c18-stream-cap.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** the admit, resolve, forward, settle path in `handler.ts`; `serve` starts the sweeper and seeds the store from `--trace-dir` at start (warm-up).

- [ ] **Step 4: Run tests to verify they pass**

Run: same as Step 2, then `npm test`.
Expected: PASS; whole suite green.

- [ ] **Step 5: Commit**

```bash
git add src test && npm run build && git add bin && git commit -m "feat: atomic admission in the request path with budget proof test"
```

---

### Task 15: Live-test harness with the 20 USD cap, first live Claude Code run (day 6)

**Files:**
- Create: `src/live/harness.ts`, `test/live/policy.yaml`, `test/live/prices.yaml` (symlink-free copy of `examples/policy/prices.yaml`), `test/live/harness.test.ts`, `test/live/claude-code.live.md` (run log template)
- Modify: `src/cli.ts` (`live` command, hidden from `--help`), `package.json` (`"live": "node --env-file=.env bin/tokenyard.mjs live"`), `vitest.config.ts` (exclude `*.live.*`)

**Interfaces:**
- Consumes: `createGateway`, `createMemoryStore`, `warmupEntries`, `TraceWriter`, `exportTraces` (Tasks 7, 13, 14).
- Produces: `startLiveHarness(o: { env: NodeJS.ProcessEnv; today: string; traceDir: '.live/traces'; port: number }): Promise<{ url: string; clientKey: string; spentMicroUsd: number; close(): Promise<void> }>`; `liveGuard(env: NodeJS.ProcessEnv, today: string): { ok: true; capUsd: number; codexLive: boolean } | { ok: false; reason: string }`

- [ ] **Step 1: Write the failing tests (mock upstream, no key, runs in CI)**

```ts
test('liveGuard refuses without ANTHROPIC_API_KEY, after 2026-11-16, without TOKENYARD_LIVE_BUDGET_USD or with a value above 20', ...);
test('liveGuard reports codexLive from presence of OPENAI_API_KEY only', ...);
test('live policy has one enforced tenant budget live-total equal to the env cap, worst-case estimator, serverToolsWithoutMaxUses block', ...);
test('harness seeds spend from earlier live traces: $19.99 spent means a $0.02 reservation is refused', ...);
test('unreadable trace dir refuses to start', ...);
test('harness output and trace files never contain the provider key value', async () => {
  const env = { ANTHROPIC_API_KEY: 'sk-ant-test-CANARY-0123456789abcdef', TOKENYARD_LIVE_BUDGET_USD: '20' };
  // start against the mock, send 3 requests, close; grep stdout, stderr and .live/traces for CANARY: none
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/live/harness.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

The harness prints only the gateway URL, the `ty_` client key and remaining budget. Provider credential comes from `credential: { env: ANTHROPIC_API_KEY }` resolved inside the gateway process.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/live/harness.test.ts && npm run check:secrets`
Expected: PASS.

- [ ] **Step 5: First live run (spends money; Mateusz present)**

Run: `npm run live -- --port 4000`, then in a scratch clone of a public repo: `ANTHROPIC_BASE_URL=http://127.0.0.1:4000 ANTHROPIC_AUTH_TOKEN=<printed ty_ key> CLAUDE_CODE_GATEWAY_HINT_HEADERS=1 CLAUDE_CODE_ENABLE_TELEMETRY=1 OTEL_METRICS_EXPORTER=console claude` for a short task (about 10 turns, one subagent). No direct-to-API comparison run is made on the live key, because it would bypass the cap: cache fidelity against direct is proven on the mock (C15), and the live run checks that tokenyard's per-request token counts equal the ones Claude Code reports in its own OTel `api_request` events, so the cache hit ratio Claude Code sees is the one tokenyard records.
Expected, recorded in `test/live/claude-code.live.md`: Claude Code version; total spend under the cap; per-request tokenyard cost equals OTel `cost_usd` (join on time and request order, spec 12.2); cache hit ratio; every request `actual input <= inputTokensBound` (R11); whether Claude Code's WebSearch sets `max_uses` (decides whether `serverToolsWithoutMaxUses: block` breaks it). Each own-error type (budget, rate, streams, secret placeholder) shown once in Claude Code against the mock and its display noted.

- [ ] **Step 6: Commit**

```bash
git add src/live src/cli.ts package.json vitest.config.ts test/live && npm run build && git add bin && git commit -m "feat: live-test harness with tokenyard-enforced 20 USD cap"
```

---

### Task 16: Secret guardrails, session taint, PII redaction (day 7)

**Files:**
- Create: `src/guardrails/rules.ts`, `src/guardrails/scan.ts`, `src/guardrails/pii.ts`, `src/guardrails/redact.ts`, `test/fixtures/fp-corpus/README.md` (lists sources), `bench/scan.ts` (stub used by Task 23)
- Modify: `src/edge/handler.ts`, `src/policy/decide.ts` (build `Plan.taint` from hits)
- Test: `test/guardrails/*.test.ts`, `test/edge/taint.test.ts`

**Interfaces:**
- Consumes: `ExtractedFeatures.lastTurn` (Task 4), `pseudonym` (Task 7), `CounterStore` taint support (Task 13).
- Produces:
  - `interface SecretRule { id: string; keywords: string[]; regex: RegExp; source: string; licence: string; entropyOnly?: boolean }`; `DEFAULT_RULES: readonly SecretRule[]` (spec 6.6 list, including `ty_live_`)
  - `scanBody(body: Buffer, lastTurn: { start: number; end: number } | null, rules: readonly SecretRule[], actionFor: (rule: SecretRule) => 'block' | 'warn' | 'redact', salt: string): GuardrailHit[]`
  - `PII_RULES` (email, PESEL with checksum, IBAN mod-97, card numbers with Luhn); `redactProductBody(body: Buffer, hits: Array<{ rule: string; start: number; end: number }>): Buffer` (placeholder `[REDACTED:<RULE>_<n>]`, product routes only)

- [ ] **Step 1: Write the failing tests**

```ts
test.each(DEFAULT_RULES)('rule %s matches its positive fixture and not its negative one', ...);
test('last-turn hit with codingAgent block gives preBlock secret and Plan.taint.add with the HMAC; message names rule and index, never the value', ...);
test('next request in the same session carrying the value in history fails admit with kind taint (memory and redis)', ...);
test('history hit of a value that was only warned does not block', ...);
test('store down: last-turn block still works; taint skipped and taintUnchecked true', ...);
test('entropy-only hits never block', ...);
test('product route: redact replaces values and recomputes content-length; coding-agent route never changes bytes', ...);
test('PII: PESEL checksum, IBAN mod-97 and Luhn reject near-misses', ...);
test('false-positive corpus (why-diff, read-receipts, tokenyard trees, lockfiles, fixtures) gives zero block hits', ...);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/guardrails test/edge/taint.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Keyword prefilter with `Buffer.indexOf` before any regex. History scan over the body outside `lastTurn` with block rules only. The FP corpus is read from sibling paths given in `TOKENYARD_FP_CORPUS` (CI checks out why-diff and read-receipts) plus committed lockfiles. PII redaction is a cut-line item: if day 7 slips, drop `pii.ts` and `redact.ts` with their tests and note it in the Limitations list.

- [ ] **Step 4: Run tests to verify they pass**

Run: same as Step 2.
Expected: PASS; corpus test prints `block hits: 0`.

- [ ] **Step 5: Commit**

```bash
git add src test bench/scan.ts && npm run build && git add bin && git commit -m "feat: secret guardrails with session taint in admit and product redaction"
```

---

### Task 17: Replay engine with fidelity check (day 8)

**Files:**
- Create: `src/replay/{engine,sim-store,cost-model,fidelity,diff,render-terminal,render-json}.ts`, `docs/replay-json.md`
- Modify: `src/cli.ts` (`policy replay`)
- Test: `test/replay/*.test.ts`, `test/replay/__snapshots__/`

**Interfaces:**
- Consumes: `decide`, `resolve`, `compilePolicy`, `loadPolicyDir` (Tasks 8, 10), `createMemoryStore` (Task 13), `readLedger`, `ManifestRecord` (Task 7), `costMicroUsd` (Task 6).
- Produces:
  - `createSimStore(clock: () => number): CounterStore` (memory store on the virtual clock)
  - `replay(o: { base: CompiledPolicy; head: CompiledPolicy; traces: AsyncIterable<LedgerLine>; sinceMs: number | null; tenant: string | null }): Promise<ReplayResult>`
  - `interface Totals { costMicroUsd: number; costBasis: 'billed' | 'api-equivalent' | 'mixed'; estimated: boolean; forwarded: number; blocked: number }`
  - `interface ReplayResult { schemaVersion: 1; window: { sinceMs: number; untilMs: number }; tenant: string | null; requests: number; sessions: number; fidelity: { agreement: number; disagreements: Array<{ reason: string; count: number }>; missingInstances: Array<{ instance: string; hours: string[]; kind: 'no-file' | 'seq-gap' | 'heartbeats-stop' }> }; base: Totals; head: Totals; rerouted: Array<{ fromRoute: string; toRoute: string; requestClass: string | null; count: number }>; blocked: Array<{ policy: 'base' | 'head'; reason: BlockReason; name: string; count: number }>; cutSessions: Array<{ session: string; team: string | null; repo: string | null; requestClass: string | null; requestIndex: number; cause: string; droppedRequests: number; droppedCostMicroUsd: number }>; budgetHits: Array<{ policy: 'base' | 'head'; budget: string; scopeValue: string; firstHitTs: string; days: number }>; exactness: Array<{ output: string; exactness: 'exact' | 'exact-given-assumptions' | 'estimated' | 'not-computed' | 'never'; applied: boolean }>; gates: { failed: string[] } }`
  - `renderTerminal(r: ReplayResult): string`; `renderJson(r: ReplayResult): string` (stable key order)
  - `RawTraceDirError` thrown when given a directory of per-instance files

- [ ] **Step 1: Write the failing tests**

```ts
test('replaying traces against their own revision reproduces every recorded decision (fidelity 100%)', ...);
test('tightening team-day blocks the requests that cross it, in ts order', ...);
test('a block after a forwarded request in the same session counts as a cut; later requests drop with their recorded cost', ...);
test('recorded taint block is reproduced from guardrail hits', ...);
test('model change: cost estimated with output ratio, cache reads become 5m writes for one request', ...);
test('warm-up seeds budgets from records before --since', ...);
test('raw per-instance directory is refused with a message naming traces export', ...);
test('manifest with a missing instance hour and a seq gap is reported under fidelity.missingInstances', ...);
test('same inputs give byte-identical JSON and terminal output', ...);  // snapshot
test('ci.failOn cutSessions and costIncreasePct set gates.failed', ...);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/replay`
Expected: FAIL.

- [ ] **Step 3: Implement** spec 9.2 steps 1 to 6 and 9.3; the exactness table text is a constant shared with the README (Task 24).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/replay test/arch`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src test docs/replay-json.md && npm run build && git add bin && git commit -m "feat: deterministic policy replay with fidelity and missing-instance check"
```

---

### Task 18: Synthetic traffic generator and `tokenyard demo` (day 9)

**Files:**
- Create: `src/mock/traffic.ts`, `examples/traces/demo.ndjson.gz`, `examples/policy-head/policy.yaml` (the demo PR's change, kept for the local demo)
- Modify: `src/cli.ts` (`demo`)
- Test: `test/mock/traffic.test.ts`, `test/demo.test.ts`

**Interfaces:**
- Consumes: mocks (Task 3), gateway (Task 14), `exportTraces` (Task 7), `replay` and renderers (Task 17).
- Produces: `generateTraffic(o: { gatewayUrl: string; keys: Record<string, string>; seed: number; days: number }): Promise<{ requests: number; sessions: number }>` (8 developers in 3 teams, Claude Code-shaped sessions with subagents, compaction and auxiliary requests, cache markers, one fake AWS key pasted by one developer, a few Codex sessions once Task 20 lands); `runDemo(o: { out: NodeJS.WritableStream; seed: number }): Promise<ReplayResult>`

- [ ] **Step 1: Write the failing tests**

```ts
test('same seed gives byte-identical exported traces', ...);
test('demo ends with a replay report showing at least one reroute, one budget hit and the secret block', ...);
test('demo runs in one process without Docker in under 60 s', ...);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/mock/traffic.test.ts test/demo.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**, then generate and commit `examples/traces/demo.ndjson.gz` with `node bin/tokenyard.mjs demo --write-traces examples/traces/demo.ndjson.gz`. The fake AWS key is the documented example `AKIAIOSFODNN7EXAMPLE`.

- [ ] **Step 4: Run tests to verify they pass**

Run: same as Step 2.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src test examples && npm run build && git add bin && git commit -m "feat: synthetic agent traffic and one-process demo"
```

---

### Task 19: Markdown renderer, GitHub Action and demo PR (day 9)

**Files:**
- Create: `src/replay/render-markdown.ts`, `src/action/main.ts`, `action.yml`, `.github/workflows/policy-replay.yml`
- Modify: `esbuild.config.mjs` (second entry not needed: the action calls `bin/tokenyard.mjs action`), `src/cli.ts` (`action` subcommand)
- Test: `test/replay/render-markdown.test.ts`, `test/action/main.test.ts`

**Interfaces:**
- Consumes: `ReplayResult` (Task 17), `validatePolicy` (Task 8).
- Produces: `renderMarkdown(r: ReplayResult, o: { baseRev: string; headRev: string; checkSummary: { errors: number; warnings: number } }): string` starting with `<!-- tokenyard-replay -->`; `runAction(env: NodeJS.ProcessEnv, gh: { listComments(): Promise<Array<{ id: number; body: string }>>; createComment(b: string): Promise<void>; updateComment(id: number, b: string): Promise<void> }): Promise<number>` (exit code)

- [ ] **Step 1: Write the failing tests**

```ts
test('markdown matches spec 9.4 layout and starts with the sticky marker', ...);  // snapshot on demo traces
test('fidelity line and missing instances appear above the table', ...);
test('action updates the existing sticky comment instead of adding a second', ...);
test('fork PR: job summary only, no comment, no trace token read', ...);
test('exit 1 when a ci.failOn gate fails; replay.json written for upload', ...);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/replay/render-markdown.test.ts test/action`
Expected: FAIL.

- [ ] **Step 3: Implement**

`action.yml`: `runs: using: node24`, `main: bin/tokenyard.mjs`, inputs per spec 9.5; uses `fetch` against the GitHub REST API with the `token` input, no Octokit.

- [ ] **Step 4: Run tests to verify they pass**

Run: same as Step 2.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src test action.yml .github/workflows/policy-replay.yml && npm run build && git add bin && git commit -m "feat: Markdown replay comment and GitHub Action"
```

- [ ] **Step 6: Demo PR (Mateusz's step, after he pushes the repo)**

Prepare branch `demo/cheaper-compaction` locally that changes `examples/policy/policy.yaml` as in spec 13 (compaction and auxiliary to a cheaper Claude model with `allowBodyRewrite: true` and a `because:` line; tighter `web` team daily budget). Do not push; hand Mateusz the branch name and the PR body. Done when he opens it and the Action posts the comment.

---

### Task 20: Responses surface, Codex conformance and live run; Chat Completions stretch (day 10)

**Files:**
- Create: `src/surfaces/openai-responses.ts`, `src/stream/responses-usage.ts`, `src/mock/openai.ts`, `test/conformance/openai/*.test.ts`, `test/fixtures/sse/responses-*.txt`, `test/live/codex.live.md`; stretch: `src/surfaces/openai-chat.ts`, `src/stream/chat-usage.ts`
- Modify: `src/edge/paths.ts`, `src/edge/errors.ts` (`openaiError`), `src/edge/handler.ts`, `docs/conformance.md`
- Test: `test/stream/responses-usage.test.ts`, `test/conformance/openai/*.test.ts`

**Interfaces:**
- Consumes: Tasks 2 to 14 pipeline; `liveGuard` (Task 15).
- Produces: `extractResponsesFeatures(body: Buffer): ExtractedFeatures`; `class ResponsesUsageAccumulator { onEvent(e: SseEvent): void; result(): UsageResult }`; `startOpenAIMock(o?): Promise<MockServer>`; `openaiError(status, type, code, message, retryAfterS, requestId)`; stretch: `ChatUsageAccumulator`.

- [ ] **Step 1: Write the failing tests**

```ts
test('R1 body and header bytes equal, including encrypted reasoning items and unknown fields', ...);
test('R2 /responses and /v1/responses both served', ...);
test('R3 response.completed usage parsed: input_tokens, output_tokens, input_tokens_details.cached_tokens', ...); // fixture from a real capture once available
test('R4 response.failed and response.incomplete forwarded unchanged', ...);
test('R5 truncated stream settled partial from streamed output text', ...);
test('R6 own errors use the OpenAI envelope', ...);
test('R7 missing max_output_tokens reserves maxOutputTokens', ...);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/conformance/openai test/stream/responses-usage.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**, add the OpenAI models (with `maxContextTokens`, `maxOutputTokens`) to `prices.yaml` from OpenAI's pricing page with source and date.

- [ ] **Step 4: Run tests to verify they pass**

Run: same as Step 2, then `node scripts/gen-conformance-doc.mjs > docs/conformance.md`.
Expected: PASS.

- [ ] **Step 5: Codex live run, or "not verified live"**

If `liveGuard(process.env, today).codexLive` is true: `npx @openai/codex` with the spec 3 step 6 `config.toml` pointing at `npm run live`, a short task, recorded in `test/live/codex.live.md` (Codex version, spend, `response.completed` usage captured as the R3 fixture with values replaced). Otherwise mark Codex "not verified live" in `docs/conformance.md` and keep the documented shape fixture.
Expected: spend stays under the shared 20 USD cap.

- [ ] **Step 6 (stretch, first on the cut line): `/v1/chat/completions` for product routes**

Tests: `include_usage` added on product routes only and the extra usage chunk removed before the client; coding-agent route bytes unchanged and settled `estimated` when usage is missing. Skip this step entirely if day 10 is short.

- [ ] **Step 7: Commit**

```bash
git add src test docs/conformance.md examples/policy/prices.yaml && npm run build && git add bin && git commit -m "feat: OpenAI Responses passthrough for Codex"
```

---

### Task 21: OTel export, `/metrics`, health endpoints (day 11)

**Files:**
- Create: `src/telemetry/semconv.ts`, `src/telemetry/otel.ts`, `src/telemetry/metrics.ts`
- Modify: `src/edge/server.ts`, `src/edge/handler.ts`, `src/cli.ts` (`serve --otlp-endpoint`)
- Test: `test/telemetry/*.test.ts`

**Interfaces:**
- Consumes: trace record fields (Task 7), loader metrics (Task 11).
- Produces: `SEMCONV_COMMIT` and attribute name constants; `createMetrics(): { inc(name: string, labels: Record<string, string>, v?: number): void; observe(name: string, v: number, labels?): void; render(): string }`; `interface SpanSink { requestSpan(r: TraceRecord): void; shutdown(): Promise<void> }`; `createTracer(endpoint: string | null): Promise<SpanSink>` (dynamic `import()` of OTel packages only when an endpoint is set; a no-op sink otherwise).

- [ ] **Step 1: Write the failing tests**

```ts
test('semconv constants equal the snapshot pinned to SEMCONV_COMMIT', ...);
test('gen_ai.usage.input_tokens = input + cache read + cache write', ...);
test('one SERVER span per request and one CLIENT span per upstream attempt named "<operation> <model>"', ...); // in-memory exporter
test('/metrics serves tokenyard_* counters with no session, prompt or key labels', ...);
test('/readyz is 503 before a policy loads and when the store is down with budgets closed', ...);
test('no OTel module is imported when no endpoint is set', ...);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/telemetry`
Expected: FAIL.

- [ ] **Step 3: Implement** per spec 12.2. OTel packages are added to `devDependencies` and bundled.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/telemetry`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src test package.json package-lock.json && npm run build && git add bin && git commit -m "feat: OTel GenAI spans, Prometheus metrics and health endpoints"
```

---

### Task 22: Docker image, compose demo and `report --html` (day 11)

**Files:**
- Create: `Dockerfile`, `compose.yaml`, `deploy/otel-collector.yaml`, `src/report/render-html.ts`
- Modify: `src/cli.ts` (`report --html`)
- Test: `test/report/render-html.test.ts`, `test/compose.smoke.sh` (run in CI on Linux only)

**Interfaces:**
- Consumes: `runDemo` (Task 18), `buildReport` (Task 7), metrics and OTel (Task 21).
- Produces: image `tokenyard:dev` (Node 24, non-root user, read-only root filesystem, one writable `/var/lib/tokenyard`); compose services `mock`, `tokenyard`, `traffic`; profiles `redis` (Redis plus two gateway replicas with distinct `--instance-id`) and `otel` (collector plus Jaeger); `renderReportHtml(r: Report): string` (self-contained, light and dark).

- [ ] **Step 1: Write the failing tests**

```ts
test('html report is one file with no external requests and contains every team row', ...);
```

```sh
# test/compose.smoke.sh
docker compose up --abort-on-container-exit --exit-code-from traffic | tee /tmp/out && grep -q "tokenyard policy replay" /tmp/out
docker compose --profile redis up --abort-on-container-exit --exit-code-from traffic   # shared budgets across 2 replicas; replay reads the merged export
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/report/render-html.test.ts && sh test/compose.smoke.sh`
Expected: FAIL.

- [ ] **Step 3: Implement.** `report --html` is on the cut line (second); the compose `redis` profile is last on the cut line.

- [ ] **Step 4: Run tests to verify they pass**

Run: same as Step 2, then `docker compose --profile otel up` and open Jaeger at `http://localhost:16686`.
Expected: PASS; spans for `chat claude-*` visible.

- [ ] **Step 5: Commit**

```bash
git add Dockerfile compose.yaml deploy src test && npm run build && git add bin && git commit -m "feat: Docker image, compose demo with profiles and HTML report"
```

---

### Task 23: Benchmarks and the generated README block (day 12)

**Files:**
- Create: `bench/{overhead,budget,cache,scan,replay,calibration,run}.ts`, `bench/results.json`, `scripts/bench-to-readme.mjs`
- Modify: `package.json` (`bench`, `bench:check`)
- Test: `test/bench/bench-to-readme.test.ts`

**Interfaces:**
- Consumes: mocks, gateway, stores, replay, scanner, `.live/` anonymized export for calibration (Tasks 3 to 20).
- Produces: `bench/results.json` with `{ hardware, os, node, tools, runAt, overhead, budget, cache, scan, replay, calibration }`; `writeBenchBlock(readme: string, results: object): string` and `checkBenchBlock(readme: string, results: object): boolean` between `<!-- BENCH:START -->` and `<!-- BENCH:END -->`.

- [ ] **Step 1: Write the failing test**

```ts
test('writeBenchBlock replaces only the block; checkBenchBlock fails on any drift', ...);
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/bench`
Expected: FAIL.

- [ ] **Step 3: Implement the six benchmarks of spec 12.3**

Overhead with `autocannon` (dev dependency, coordinated-omission correction on) for non-streaming, streaming 500 tokens and 150 KB bodies at concurrency 10, 100, 500, memory and Redis stores, reporting added TTFB and total time p50/p95/p99, CPU and RSS per 100 streams. Budget: the G4 scenario plus `session-aware` and the 150,000-byte turn headroom under $25. Cache: 40-turn session through tokenyard and the naive proxy at Opus 5.5 prices. Scan: MB/s last turn and full body, FP corpus hits. Replay: records per second on 1 million synthetic records. Calibration: bound to actual input and reservation to actual cost on demo and anonymized live traces; exits 1 if any `actual > bound`.

- [ ] **Step 4: Run**

Run: `npm run bench && node scripts/bench-to-readme.mjs --write README.md && npm run bench:check`
Expected: `bench/results.json` written; check exits 0.

- [ ] **Step 5: Commit**

```bash
git add bench scripts/bench-to-readme.mjs package.json test/bench README.md && git commit -m "bench: overhead, budget, cache, scan, replay and calibration"
```

---

### Task 24: README, docs and anonymized live results (day 12)

**Files:**
- Create: `README.md` (outline of spec 13), `docs/future-quality.md`, `examples/live/` (anonymized export excerpt, report screenshots light and dark), `docs/demo.gif`, `CHANGELOG.md`
- Modify: `docs/conformance.md`
- Test: `test/docs/readme.test.ts`

**Interfaces:**
- Consumes: bench block (Task 23), exactness table constant (Task 17), `exportTraces --anonymize` (Task 7), live logs (Tasks 15, 20).

- [ ] **Step 1: Write the failing tests**

```ts
test('README exactness table equals the replay constant verbatim', ...);
test('README has no subscription passthrough mention', () => expect(readme).not.toMatch(/experimental-subscription|subscription (mode|passthrough|login)|OAuth/i));
test('README and docs contain no em dash and no arrow characters', () => expect(proseOnly(all)).not.toMatch(/[\u2014\u2192\u21D2]|->|=>/));  // proseOnly drops fenced and inline code
test('every number in the README Measured and Real sessions sections appears in bench/results.json or examples/live', ...);
test('examples/live contains no repo, branch, ticket or tenant names from the raw live traces', ...);  // compares against a local-only list in .live/, skipped in CI
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/docs`
Expected: FAIL.

- [ ] **Step 3: Write**

Anonymize: `node bin/tokenyard.mjs traces export --since 30d --dir .live/traces --anonymize --salt <random> --out examples/live/live.ndjson.gz`, then `report --html` on that file only, screenshots from that report. README sections 1 to 13 of spec 13 with the Budgets section stating the 7.4 premises, invariants, proof test and concurrency trade-off from bench numbers; Limitations includes R2 consequences (Remote Control, voice, HIPAA), R11 and "Codex not verified live" when applicable. The GIF is recorded from the demo PR once Mateusz has opened it; until then the README uses the PNG of the local `demo` Markdown output and says so.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/docs && npm run bench:check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add README.md CHANGELOG.md docs examples/live test/docs && git commit -m "docs: README with measured numbers and anonymized live sessions"
```

---

### Task 25: Security review round (day 12)

**Files:**
- Create: `docs/security-review.md`, one regression test per finding under `test/security/`
- Modify: whatever the findings require (each fix in its own commit)

**Interfaces:**
- Consumes: the whole tree.

- [ ] **Step 1: Run the adversarial review in the why-diff format**

Dispatch three independent reviewers (fresh context, no access to each other's notes), each told to find a way to break one property and to write the attack as a failing test: (a) **budget bypass**: any path that forwards without `admit` or settles below actual (abort timings, duplicate ids, Idempotency-Key reuse, sweeper races, unknown model, server tools, Responses without `max_output_tokens`, header spoofing of session and request class, two instances); (b) **leak**: provider key, OAuth token, `ty_` key or prompt text reaching a log, trace, error body, metric label, span, report or the npm tarball; secret value in a guardrail message; (c) **policy and CI**: a policy PR that runs code, reads traces or exfiltrates via the Action, a passthrough credential to a non-official host, YAML tricks (anchors, merge keys, huge aliases), redirects on `--policy-url`, cross-tenant counter or trace access.

- [ ] **Step 2: Triage**

Each finding goes into `docs/security-review.md` with severity, reproduction test name, and status. Every accepted finding has a failing test in `test/security/` first.

- [ ] **Step 3: Fix and verify**

Run: `npm test && npm run check:secrets`
Expected: PASS, every `test/security` test green.

- [ ] **Step 4: Second pass**

Re-dispatch reviewer (a) only against the fixes. Expected: no new high-severity finding; record the result.

- [ ] **Step 5: Commit**

```bash
git add docs/security-review.md test/security && git commit -m "docs: security review round"
```

---

### Task 26: npm packaging and final CI (day 12)

**Files:**
- Modify: `.github/workflows/ci.yml`, `package.json` (`publishConfig: { access: "public", provenance: true }`, `repository`, `keywords`), `CHANGELOG.md` (0.1.0)
- Create: `test/pack/pack.smoke.mjs`

**Interfaces:**
- Consumes: everything.

- [ ] **Step 1: Write the failing smoke test**

`test/pack/pack.smoke.mjs`: `npm pack` into a temp dir, install the tarball into an empty project, run `npx tokenyard --version`, `npx tokenyard policy check <copied examples/policy>` and `npx tokenyard demo`; assert the tarball has no `dependencies`, contains only `bin/`, `action.yml`, `LICENSE`, `README.md`, `package.json`, and passes `scripts/check-no-secrets.mjs <tarball>`.

- [ ] **Step 2: Run to verify failure**

Run: `node test/pack/pack.smoke.mjs`
Expected: FAIL until `files` and metadata are complete.

- [ ] **Step 3: Implement**

CI jobs: existing matrix; `redis` job on ubuntu with a `redis:7` service running `npm run test:redis` (store contract and G4 proof on Redis); `pack` job running the smoke test on Linux and Windows; `bench-check` job running `npm run bench:check`; `npm audit signatures`; `compose` job running `test/compose.smoke.sh`. No publish job.

- [ ] **Step 4: Run to verify pass**

Run: `node test/pack/pack.smoke.mjs && npm test && npm run check:bundle`
Expected: PASS. CI itself is verified by Mateusz after he pushes.

- [ ] **Step 5: Commit**

```bash
git add .github package.json CHANGELOG.md test/pack && git commit -m "chore: package for npm and complete CI matrix"
```

---

## Cut line

If days slip, cut in this order (spec 14): Task 20 Step 6 (`/v1/chat/completions`), `report --html` in Task 22, PII redaction in Task 16, audit-mode candidate in Task 11 (replay stays), the breaker in Task 12 (chain fallback stays), the compose `redis` profile in Task 22. Never cut: Task 5 and the conformance parts of Tasks 6, 14 and 20, Task 14's budget proof, Task 17's fidelity check, Task 19's demo PR preparation.

## Self-review notes

- Spec coverage: G1 Tasks 4, 5, 15; G2 Tasks 8, 10, 11; G3 Tasks 17, 19; G4 Tasks 9, 13, 14; G5 Tasks 6, 7, 15; G6 Tasks 6, 15; G7 Task 16; G8 Tasks 18, 22; G9 Tasks 21, 22; G10 Tasks 23, 26. Live tests and the 20 USD cap: Tasks 15, 20, 24. Multi-instance traces: Tasks 7, 17, 22. Taint and stream caps in admit: Tasks 13, 14, 16. Security model: Task 25 plus the leak tests in Tasks 7 and 15.
- The estimator is in day 4 (Task 9) because `decide` needs it; the spec's day 4 row was updated to match.
- Live runs start on day 6 (Task 15), not day 2, because the cap has to be enforced by tokenyard's own budgets, which exist from day 6.
