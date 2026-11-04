# Point Claude Code and Codex at it

Claude Code, two lines per developer:

```sh
export ANTHROPIC_BASE_URL=https://tokenyard.internal.example
export ANTHROPIC_AUTH_TOKEN=ty_live_xxxxxxxx
```

tokenyard reads the key from `x-tokenyard-key`, `Authorization: Bearer` or `x-api-key`, so `ANTHROPIC_API_KEY` works too. Fleet-wide, through Claude Code managed settings, with the gateway pinned as the only allowed destination (`allowedProviders` needs Claude Code v2.1.285 or later, per the [LLM gateway guide](https://code.claude.com/docs/en/llm-gateway)):

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://tokenyard.internal.example",
    "CLAUDE_CODE_GATEWAY_HINT_HEADERS": "1"
  },
  "apiKeyHelper": "tokenyard-key",
  "allowedProviders": ["customEndpoint"]
}
```

`CLAUDE_CODE_GATEWAY_HINT_HEADERS=1` makes Claude Code send its request class, agent type and prompt id, which the trace and the report split cost by. `tokenyard-key` is an example name for your own script that prints the key (for example from the OS keychain); tokenyard does not ship it. For repo, branch and ticket attribution, start Claude Code with `eval "$(tokenyard env)" && claude`; the headers are fixed at launch, so a branch switch mid-session is not reflected.

Codex, in `~/.codex/config.toml` (run `/logout` first if Codex has its own OpenAI login, which it would otherwise prefer):

```toml
model_provider = "tokenyard"

[model_providers.tokenyard]
name = "tokenyard"
base_url = "https://tokenyard.internal.example/v1"
env_key = "TOKENYARD_KEY"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
env_http_headers = { "x-tokenyard-repo" = "TOKENYARD_REPO" }
```

A product service uses a service key (`kind: service`) and the base URL in the official SDK; its traffic class comes from the key, never from a header.
