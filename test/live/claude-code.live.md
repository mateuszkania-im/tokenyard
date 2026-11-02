# Live run log: Claude Code through tokenyard

Run by `npm run live` (spec 14.1). Raw traces stay in `.live/traces/` (gitignored); this file holds only anonymized
counts and amounts. No repository, branch, prompt text, session id or file path from the scratch repository appears
here, and no key value.

## Template for each run

- Date, Claude Code version, models used
- Cap and spend: the harness start line (`live-total`, spent, remaining) before and after
- Per request: tokenyard cost against Claude Code's OTel `claude_code.api_request` `cost_usd`, joined on time and
  request order (spec 12.2), and whether the four token counts are equal
- Cache hit ratio: cache read tokens over all input tokens (input, cache read, cache write) of billed requests
- R11: every billed request has actual input at most its `inputTokensBound`
- Server tools: what Claude Code sends (`max_uses`) and what the policy decided
- Own errors: what Claude Code prints for each tokenyard error, checked against the mock, never the live key

## Run 1: 2026-11-02

**Setup.** Claude Code 2.1.316, `claude -p` (non-interactive) in a shallow clone of a small public repository,
with `ANTHROPIC_BASE_URL` pointing at the harness, the printed `ty_` key in `ANTHROPIC_AUTH_TOKEN`,
`CLAUDE_CODE_GATEWAY_HINT_HEADERS=1` and `CLAUDE_CODE_ENABLE_TELEMETRY=1`. The provider key was only in the
gateway process (`node --env-file=.env`); the Claude Code process was started with `env -u ANTHROPIC_API_KEY -u
OPENAI_API_KEY`. To keep this run small the cap was lowered from the shell for each harness start
(`TOKENYARD_LIVE_BUDGET_USD` of 3, then 5, then 8; the environment wins over `--env-file`, and the guard still
refuses anything above 20). The cap is cumulative: each restart seeded the spend of the earlier runs from
`.live/traces/` (start lines: spent $0.00, then $0.17, then $0.50).

**Sessions.** Five short sessions, 44 requests in total, 18 of them billed:

| Session | Model | What it did | Billed requests | Claude Code `total_cost_usd` | tokenyard cost |
|---|---|---|---|---|---|
| 1 | Sonnet 5.5 | 5 turns, one Explore subagent (3 turns), one edit | 7 | 0.1713382 | 0.171340 |
| 2 | Sonnet 5.5 | 5 turns, one Explore subagent (2 turns), one edit | 5 | 0.0990300 | 0.099030 |
| 3 | Opus 5.5 | 2 turns, one file read | 2 | 0.1588440 | 0.158844 |
| 4 | Sonnet 5.5 | WebSearch attempt; the turn after the tool call reserved $5.81, above the $5 cap of that start, and was refused | 1 | 0.0746165 | 0.074617 |
| 5 | Sonnet 5.5 | WebSearch attempt again, request shapes recorded | 3 | 0.0123766 | 0.012376 |

**Total spend (tokenyard's own counter): $0.516207**, the sum of `chargedMicroUsd` over every live trace, equal to
the spent amount the harness seeds on its next start. Every billed request was settled by the request
(`settledBy: request`), none overran its reservation.

**tokenyard cost against OTel `cost_usd`.** The OTel console exporter printed nothing in `claude -p` mode, so OTel
was sent with OTLP over HTTP JSON to a local file sink for sessions 2 to 5. All 11 billed requests of those
sessions joined one to one (same model, OTel event within 2 s of the request's end, in request order): input,
output, cache read and cache write token counts were equal for all 11, and the cost differed by at most 1
micro-USD (tokenyard rounds each request half up to whole micro-USD; OTel reports a float). Session 1 had no OTel
capture; its total matches Claude Code's own `total_cost_usd` to 2 micro-USD over 7 requests, the same rounding.

**Cache hit ratio.** 0.7102 over all 18 billed requests (cache read tokens over all input tokens); 0.7719 in
session 2. Every cache write was 5 minute; no 1 hour writes. All requests reported `inference_geo` global.

**R11 (actual input at most `inputTokensBound`).** Held for every billed request: 0 violations. 16 billed requests
used the `bytes` bound, where actual input was 0.339 to 0.348 of the bound; 2 used `context-window`.

**Reservations.** A typical Claude Code turn on Sonnet 5.5 (`max_tokens` 128,000, 80 to 90 KB body) reserved
$1.66 to $1.84; on Opus 5.5 $3.57 to $3.58. A turn whose history holds a `tool_reference` block (Claude Code's
deferred tool search) falls back to the `context-window` bound and reserves $5.81 on Sonnet 5.5. Under the
$20 cap that allows about 11 Sonnet turns in flight at once, or 3 with `tool_reference` in the history.

**WebSearch and `max_uses`.** Claude Code's WebSearch tool sends a separate request with one server tool
`web_search_20250305` and **`max_uses: 8`**, so `serverToolsWithoutMaxUses: block` does not break it. That request
cannot be admitted under any live cap, though: with 10 sampling iterations the worst-case bound is 10 times the
1,000,000 token context window plus 10 times 128,000 output tokens, far above $20, so it is refused with 429
("reservation ... is larger than budget live-total allows in total"). Claude Code retried it 10 times over
about 3 minutes, then the main turn received the tool error and the session ended normally.

**Other requests.** Right after session 1 ended, 4 requests with the same `ty_` key and a User-Agent that is not
`claude-cli` arrived: three for Opus 5.5 with the `context-window` bound (refused, reservation above the cap)
and one for `claude-sonnet-4-6` (403, model not allowed by the live route). Their source is not identified (a
background or hook process inheriting the environment is the likely one); nothing was billed for them.

## Own errors in Claude Code (against the mock, not the live key)

Each error came from the real gateway in front of the deterministic mock: budget by seeding $19.99 spent under a
$20 cap through the harness, the others from a store that answers admit with that failure. `claude -p` printed:

| Error | Answer | What Claude Code printed | Retries before printing |
|---|---|---|---|
| Budget | 429 `rate_limit_error`, no `retry-after` | `API Error: Request rejected (429) · tokenyard: budget "live-total" is exhausted (spent $19.99 of $20.00; this request's reservation is $1.80); it resets at 2026-12-01T00:00:00.000Z` | 10 retries, about 3 minutes |
| Rate | 429 `rate_limit_error`, `retry-after: 2` | `API Error: Request rejected (429) · tokenyard: rate limit "live-rpm" reached; retry in 2 s` | 10 retries, about 3 minutes |
| Streams | 429 `rate_limit_error`, `retry-after: 1` | `API Error: Request rejected (429) · tokenyard: concurrent stream limit "live-streams" reached` | 10 retries, about 3 minutes |
| Secret (session taint) | 400 `invalid_request_error` | `API Error: 400 tokenyard: this session's history holds a secret that rule anthropic-api-key blocked earlier; run /clear to drop it from the conversation, rotate the secret, and add a deny rule for the file it came from` | none; Claude Code resent the request without a thinking beta and without deferred tools (its own 400 recovery), printed after 8 s |

Every message is shown whole with the `tokenyard:` prefix. A 429 without `retry-after` is retried like any other
429: the budget error is not shown at once. The secret block in the last turn needs the guardrails (Task 16); its
envelope is the same 400 `invalid_request_error` as the taint block above.

### After Task 16: `x-should-retry: false` on errors that waiting cannot clear

Own blocks for budget, taint, secret, model or route not allowed, server tool not allowed, unpriced and server tool
without `max_uses` now carry `x-should-retry: false`; rate, stream and store-down blocks keep their `retry-after`.
Checked against the mock (no live key) with Claude Code 2.1.316, `env -u ANTHROPIC_API_KEY -u OPENAI_API_KEY claude -p`:

| Error | How | What Claude Code printed | Time to the message |
|---|---|---|---|
| Budget | `serve --policy` with `org-month` at $0.01, prompt "say hello" | `API Error: Request rejected (429) · tokenyard: this request's reservation of $3.57 is larger than budget "org-month" allows in total ($0.01); lower max_tokens or the context sent, or raise the budget` | 2 s, no retries (was about 3 minutes) |
| Secret (last turn) | `serve --dev-upstream <mock>`, the AWS documented example key id in the prompt | `API Error: 400 tokenyard: the last message (message 0) contains a secret (rule aws-access-key-id); it was not sent. Remove it, then run /clear to drop it from the conversation, rotate the secret, and add a deny rule for the file it came from` | 3 s |
