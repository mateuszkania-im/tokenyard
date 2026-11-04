# Using tokenyard

A step-by-step setup for a team: from the demo to Claude Code and Codex going through the gateway, budgets and secret checks on, and every policy change replayed in CI. Each step links to the page with the details.

Requirements: Node 20.19 or later. Redis 7 only if you run more than one gateway process.

## 1. Try it without an API key

```sh
npx @mateuszkania-im/tokenyard demo
```

Seven days of synthetic traffic from 8 developers in 3 teams go through the gateway to a deterministic mock provider, then the demo policy change is replayed. You see the cost report and the comment a pull request would get.

## 2. Install

```sh
npm install -g @mateuszkania-im/tokenyard
tokenyard --version
```

or run every command below with `npx @mateuszkania-im/tokenyard` instead of `tokenyard`.

## 3. Start a policy directory

The package ships the CLI only. Copy the example policy from the repository and edit it:

```sh
mkdir -p policy && cd policy
for f in policy.yaml prices.yaml keys.yaml; do
  curl -fsSLO "https://raw.githubusercontent.com/mateuszkania-im/tokenyard/main/examples/policy/$f"
done
cd ..
tokenyard policy check policy      # schema and semantic rules; exits 1 on errors
```

- `policy.yaml`: providers (their keys come from environment variables, never from the file), tenants and teams, routes with allowed models, budgets, rate limits, secret rules. See [The policy file](policy.md) and [Budgets](budgets.md).
- `prices.yaml`: the price table, each price with its source and date.
- `keys.yaml`: SHA-256 hashes of tokenyard keys, never the keys themselves. Empty the example entries before you add your own.

## 4. Create a key per developer

```sh
tokenyard keys create --tenant acme --team web --name alice --file policy/keys.yaml
```

The key is printed once; only its hash is stored. Service keys for product features use `--kind service`.

## 5. Run the gateway

```sh
export ANTHROPIC_API_KEY=...            # the provider keys the policy names
export OPENAI_API_KEY=...
export TOKENYARD_TRACE_SALT=...         # long random secret: session and agent ids in traces are HMAC pseudonyms
tokenyard serve --policy policy --trace-dir traces --port 4000
```

`/metrics`, `/healthz` and `/readyz` are on a separate ops port (9464 by default). The memory store keeps budgets in this process; that is fine for one process.

For several processes or machines, use Redis so they share budgets:

```sh
tokenyard serve --policy policy --store redis --redis-url-file /run/secrets/redis-url \
  --trace-dir traces --workers 3        # 3 processes on one port, one ops port each (9464 to 9466)
```

See [Running several instances](scaling.md).

## 6. Point Claude Code and Codex at it

Claude Code, per developer:

```sh
export ANTHROPIC_BASE_URL=http://your-gateway:4000
export ANTHROPIC_AUTH_TOKEN=ty_live_...  # the developer's tokenyard key
eval "$(tokenyard env)" && claude         # optional: repo, branch and ticket attribution
```

Fleet-wide settings (managed settings, gateway as the only allowed destination) and the Codex `config.toml` are in [Point Claude Code and Codex at it](clients.md).

## 7. See where the money goes

```sh
tokenyard traces export --since 7d --trace-dir traces --out traces.ndjson.gz
tokenyard report --traces traces.ndjson.gz --by team,repo --html report.html
```

## 8. Replay every policy change in CI

Keep the policy directory in git. In the repository that holds it, add the Action:

```yaml
# .github/workflows/policy-replay.yml
on:
  pull_request:
    paths: ['policy/**']
permissions:
  contents: read
  pull-requests: write
jobs:
  replay:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: mateuszkania-im/tokenyard@v0.2.0
        with:
          policy-dir: policy
          traces: https://example.internal/traces.ndjson.gz   # a merged export, or a path in the checkout
          traces-token: ${{ secrets.TRACES_TOKEN }}
```

Every pull request that changes the policy gets one comment: requests that would route differently, blocks, budget hits, cost delta and agent sessions cut mid-task, and the check fails when a `ci.failOn` gate is exceeded. The live demo is [pull request #2](https://github.com/mateuszkania-im/tokenyard/pull/2). The workflow in this repository (`.github/workflows/policy-replay.yml`) shows how to run the Action from the base commit, so a pull request cannot change the code that judges it; read [What replay can and cannot tell you](replay.md) before you trust a number.

## 9. Shut down cleanly

SIGTERM or SIGINT drains: `/readyz` answers 503, requests and streams in flight get `--shutdown-grace-ms` (default 30 s) to finish, a second signal stops at once.

Draining in detail, with the limits: [Running several instances](scaling.md), Shutdown.

## Commands at a glance

```sh
tokenyard policy check policy                                  # schema and semantic rules; exits 1 on errors
tokenyard keys create --tenant acme --team web --name alice --file policy/keys.yaml   # prints the key once, stores its SHA-256
export TOKENYARD_TRACE_SALT=...                                # secrets come from the environment or a --*-file, never a flag
tokenyard serve --policy policy --trace-dir traces
tokenyard serve --policy policy --store redis --redis-url-file /run/secrets/redis-url --trace-dir traces
tokenyard serve --policy policy --store redis --redis-url-file /run/secrets/redis-url --trace-dir traces --workers 3   # 3 processes, one port
tokenyard traces export --since 7d --trace-dir traces --out traces.ndjson.gz
tokenyard policy replay --base-ref main --head policy --traces traces.ndjson.gz
tokenyard report --traces traces.ndjson.gz --by team,repo --html report.html
```

The provider keys are read from the environment variables the policy names (`credential: { env: ANTHROPIC_API_KEY }`); developers never see them.
