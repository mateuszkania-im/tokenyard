# Experimental: subscription passthrough

Status: not run (blocked on spec risk R2)

This mode is experimental and off by default. Whether Anthropic's terms allow routing subscription (Pro, Max, Team, Enterprise) traffic through a self-hosted proxy run by an employer has not been verified (spec risk R2). Do not use it with a real subscription until that is answered.

## What it does

- A developer keeps the claude.ai login. Claude Code sends the OAuth token in `Authorization` and the OAuth marker in `anthropic-beta`.
- The developer identifies to tokenyard with `x-tokenyard-key`, a key whose record has `billing: subscription`.
- tokenyard forwards `Authorization` and `anthropic-beta` to the provider unchanged and removes every header that carries the tokenyard key. The OAuth token is never logged, stored or traced.
- Cost is computed from the price table and labelled `api-equivalent`; nothing is billed per token to anyone.

## Turning it on

```sh
tokenyard keys create --tenant acme --name alice --billing subscription --experimental-subscription
tokenyard serve --experimental-subscription ...
```

Without `--experimental-subscription` the gateway answers 401 to a subscription key.

Developer side, with no credential variable set (a credential variable would switch Claude Code to per-token billing against that key):

```sh
export ANTHROPIC_BASE_URL=https://tokenyard.internal.example
export ANTHROPIC_CUSTOM_HEADERS="x-tokenyard-key: ty_live_xxxxxxxx"
```

## Automated checks (run against the mock)

Conformance item 17 in `test/conformance/anthropic/c17-subscription.test.ts`: the OAuth `Authorization` and `anthropic-beta` values reach the provider unchanged, the tokenyard key never does (whichever header carried it), the cost basis is `api-equivalent`, and without the flag a subscription key gets 401.

## Manual check (not run)

Run only after R2 is answered and only with an account whose owner agreed.

1. Start `tokenyard serve --experimental-subscription` against the real provider with a subscription key.
2. In a shell with no `ANTHROPIC_API_KEY` and no `ANTHROPIC_AUTH_TOKEN`, set the two variables above and run `claude`, logged in with the subscription.
3. Send one prompt. Expect a normal answer, not a 401.
4. Check that the trace for that request has `billing: subscription`, `costBasis: api-equivalent` and no credential anywhere.
5. Check that `anthropic-ratelimit-unified-*` headers appear on the response.
6. Stop the gateway, run `claude` again, and confirm the login is intact.

Result: not run.
