# Live run log: Codex through tokenyard

Run by `npm run live` (spec 14.1). Raw traces stay in `.live/traces/` (gitignored); this file holds only anonymized
counts and amounts. No prompt text, session id, file path or key value from the run appears here.

## Run 1: 2026-11-03

**Setup.** Codex CLI 0.166.0 (`npx -y @openai/codex exec`, non-interactive) in a shallow clone of a small public
repository, with a temporary `CODEX_HOME` whose `config.toml` sets `model_provider = "tokenyard"`, `base_url` to the
harness plus `/v1`, `wire_api = "responses"`, `requires_openai_auth = false`, `supports_websockets = false`,
`env_key` naming a variable that held the printed `ty_` key, model `gpt-5.4-mini` with reasoning effort low, and
`web_search = "disabled"`. `OPENAI_API_KEY` was only in the gateway process; Codex ran under
`env -u OPENAI_API_KEY -u ANTHROPIC_API_KEY`, so it could only reach tokenyard. The harness started with
`TOKENYARD_LIVE_BUDGET_USD=3.5` from the shell (spent $0.52 seeded from the earlier runs, $2.98 remaining), so
tokenyard itself capped this run at about $3. A local recording proxy between Codex and the harness kept the request
and response bytes for the fixture (authorization header not recorded).

**Task.** "Read index.js and add one short comment line at the top of index.js saying what the module does."
Codex read the file with its shell tool, applied a one-line patch and finished: 3 billed requests.

| Request | Input items | Bound | Reserved | Input / cache read / output tokens | tokenyard cost |
|---|---|---|---|---|---|
| 1 | developer and user messages | bytes (65,040) | $0.687258 | 12,933 / 0 / 88 | $0.010096 |
| 2 | plus reasoning, assistant message, function call and output | context-window (400,000) | $0.963600 | 417 / 12,800 / 151 | $0.001952 |
| 3 | the same, one turn longer | context-window (400,000) | $0.963600 | 361 / 13,056 / 20 | $0.001340 |

**Spend.** This run: $0.013388. **Total live spend (tokenyard's own counter): $0.529595**, the sum of
`chargedMicroUsd` over every live trace, which the harness seeds on its next start. Every billed request was settled
by the request, none overran its reservation.

**R11 (actual input at most `inputTokensBound`).** Held: the one bytes-bound request billed 13,021 input tokens
against a bound of 65,040 (0.20 of it).

**R3 shape (`response.completed`).** The usage object Codex's stream carried, values replaced:

```json
{"input_tokens":1200,"input_tokens_details":{"cache_write_tokens":64,"cached_tokens":1024},"output_tokens":42,"output_tokens_details":{"reasoning_tokens":30},"total_tokens":1242}
```

`input_tokens` includes the cached tokens (`total_tokens` is input plus output). The capture had
`cache_write_tokens: 0`; it is not in the shape the spec expected and is parsed as a cache write inside
`input_tokens`, priced at the input rate for the models in the table. The whole stream, with every id, text,
timestamp and count replaced and the echoed instructions and tools dropped, is
`test/fixtures/sse/responses-completed.txt` (R3). Events seen: `response.created`, `response.in_progress`,
`response.output_item.added` and `.done`, `response.content_part.added` and `.done`, `response.output_text.delta`
and `.done`, `response.function_call_arguments.delta` and `.done`, `response.completed`. The response object also
carries `tool_usage` (`web_search.num_requests`, `image_gen` tokens).

**Request shape.** `POST /v1/responses` with headers `originator: codex_exec`, `session-id`, `thread-id`,
`x-client-request-id`, `x-codex-window-id`, `x-codex-turn-metadata` (a JSON blob with the workspace path, the
repository's remote URL and commit; forwarded unchanged, never traced), `x-codex-beta-features` and
`User-Agent: codex_exec/0.166.0 ...`. The body has no `instructions` (developer messages instead), no
`max_output_tokens` (the reservation uses the model's 128,000), `store: false`,
`include: ["reasoning.encrypted_content"]`, `prompt_cache_key`, and a `client_metadata` object with session, thread
and turn ids. Codex did not call `/models` (it printed that model metadata for `gpt-5.4-mini` was not found and used
its fallback).

**Surprises.**

- The first attempt was refused: Codex 0.166.0 sends a tool of type `namespace` (its sub-agent function tools grouped
  under `multi_agent_v1`), which the extractor counted as an unknown server tool (403, server tool not allowed). The
  extractor now looks inside a namespace and classifies its tools; a built-in tool nested in one is still a server
  tool. `client_metadata` is now a plain field (before, it made every Codex request use the context-window bound).
- Codex retried that 403 five times ("Reconnecting... 5/5", about 6 s) although it carried `x-should-retry: false`,
  then printed the message: `unexpected status 403 Forbidden: tokenyard: server tool namespace is not allowed on route
  "codex"; ...`.
- Every turn after the first carries reasoning items with `encrypted_content`, so it uses the context-window bound
  ($0.96 reserved on gpt-5.4-mini for a turn that cost about $0.002).

## Own errors in Codex (against the mock, no spend)

A gateway in front of the OpenAI mock with `org-month` at $0.01: Codex printed `ERROR: Quota exceeded. Check your plan
and billing details.` at once, without retrying (the budget block is 429 with `type` and `code`
`insufficient_quota`). Codex shows its own text for that code, not tokenyard's message.
