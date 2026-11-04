# How it differs

Only what the cited sources say. "Not checked" means this page makes no claim either way.

| | tokenyard v0.1 | LiteLLM | Bifrost | Claude apps gateway |
|---|---|---|---|---|
| See what a policy change would do to recorded traffic before it ships | Yes: `policy replay` and a GitHub Action that comments on the pull request | Not found: a review of 15 gateways found replay or shadow evaluation in none ([deepinspect.ai](https://www.deepinspect.ai/blog/best-ai-gateway-2026)) | Not found (same review) | No: "Configuration is the YAML file; redeploy to change it" ([docs](https://code.claude.com/docs/en/claude-apps-gateway)) |
| Clients and models | Claude Code (Claude models only), Codex, product services | Not checked | Codex CLI guide ([docs](https://docs.getbifrost.ai/cli-agents/codex-cli)) | Claude Code, Claude models only, one issuer, Linux only ([docs](https://code.claude.com/docs/en/claude-apps-gateway)) |
| Request body on coding-agent routes | Forwarded byte for byte (conformance C1) | Open issues on lost thinking blocks ([#24985](https://github.com/BerriAI/litellm/issues/24985), [#32188](https://github.com/BerriAI/litellm/issues/32188)) and 400s on `output_config.effort` in passthrough ([#25877](https://github.com/BerriAI/litellm/issues/25877)) | Not checked | Not checked |
| Budgets under concurrency | Reserve then settle in one atomic admit; proof test in [Budgets](budgets.md) | Issues: 5 concurrent requests used 6.6 times a 100 TPM limit ([#18730](https://github.com/BerriAI/litellm/issues/18730)); lost counter updates ([#20977](https://github.com/BerriAI/litellm/issues/20977)); an aborted stream released its reservation as zero ([#35568](https://github.com/BerriAI/litellm/issues/35568)) | Not checked | Spend limits ([docs](https://code.claude.com/docs/en/claude-apps-gateway)) |
| Added p99 latency on a local mock | See [Measured](benchmarks.md#measured); method and hardware differ, so not comparable | 0.7 ms (Rust path), 257.7 ms (Python proxy) in LiteLLM's July 2026 benchmark ([LiteLLM](https://docs.litellm.ai/blog/rust-ai-gateway-benchmarks)) | 4.5 ms in the same benchmark | Not checked |

tokenyard does not try to win on speed; a TypeScript gateway will not. What it adds is the replay, the budget guarantee with its proof, and protocol fidelity for coding agents.
