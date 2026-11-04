# The policy file

`examples/policy/policy.yaml`, the policy the demo runs (with `prices.yaml`, every price carrying its source URL and retrieval date, and `keys.yaml`, hashes only):

```yaml
apiVersion: tokenyard/v1
kind: Policy
metadata:
  name: acme-coding-agents
  owners: ["@acme/platform"]          # informational

pricing: ./prices.yaml                # versioned price table; part of the bundle
keys: ./keys.yaml                     # key hash, tenant, team, name, kind (developer|service), billing (api)

providers:
  anthropic:
    format: anthropic
    baseUrl: https://api.anthropic.com
    credential: { env: ANTHROPIC_API_KEY }
  anthropic-backup:                   # second workspace; a fallback here starts a cold cache
    format: anthropic
    baseUrl: https://api.anthropic.com
    credential: { env: ANTHROPIC_API_KEY_BACKUP }
  openai:
    format: openai
    baseUrl: https://api.openai.com/v1
    credential: { env: OPENAI_API_KEY }

tenants:
  acme: { teams: [platform, web, data] }

routes:                               # first match wins
  - name: claude-code
    match: { surface: anthropic-messages, traffic: coding-agent, billing: api }
    chain: [anthropic, anthropic-backup]
    allowModels: ["claude-opus-5-5*", "claude-sonnet-5-5*", "claude-haiku-*"]
    # Server tools are denied unless listed. Claude Code uses web search, and tool search when it defers MCP tools;
    # both are priced in prices.yaml (tool search: no fee, a 10-iteration loop).
    serverTools: [web_search, tool_search_tool_regex, tool_search_tool_bm25]
  - name: codex
    match: { surface: openai-responses, traffic: coding-agent }
    chain: [openai]
    allowModels: ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano", "gpt-5.3-codex"]   # unpriced models are refused
  - name: support-summaries
    match: { traffic: product, feature: support-summary }
    chain: [anthropic]
    rewriteModel: claude-haiku-5-5    # product traffic only
    criticality: sheddable
  - name: product-default             # feature comes from a client header, so a header-free route must allow the model too
    match: { traffic: product }
    chain: [anthropic]
    rewriteModel: claude-haiku-5-5
    criticality: sheddable

budgets:
  - { name: org-month,  scope: tenant,  window: month, usd: 6000, onExceed: block }
  - { name: team-day,   scope: team,    window: day,   usd: 300,  onExceed: block }
  - { name: dev-day,    scope: key,     window: day,   usd: 40,   onExceed: block, mode: audit }
  - { name: session,    scope: session,                usd: 25,   onExceed: block, mode: audit }

reservation:
  estimator: worst-case               # worst-case | session-aware
  onOverrun: allow-and-debit
  serverToolsWithoutMaxUses: block    # block | assume (assume prices assumedMaxUses and voids the bound, 7.4)

rateLimits:
  - { name: dev-rpm, scope: key, rpm: 120, burst: 30 }
  - { name: dev-streams, scope: key, concurrentStreams: 8 }   # checked inside admit, released at settle

guardrails:
  secrets:
    rules: default                    # curated prefix rules, section 6.6
    codingAgent: block                # block | warn
    product: redact                   # block | warn | redact
    entropyOnly: warn                 # entropy-only hits never block
    taintTtlHours: 24                 # how long a session stays tainted after a block
  pii:
    product: redact                   # email, PESEL, IBAN, card numbers with Luhn

failure:
  counterStoreDown: { rateLimits: open, budgets: closed }
  unpricedModel: allow-and-flag       # block | allow-and-flag
  breaker: { minRequests: 20, failureRatio: 0.5, windowSeconds: 30, openSeconds: 30 }
  retryBudgetRatio: 0.1

ci:
  failOn:
    cutSessions: 0                    # fail the check if any recorded session would be cut mid-task
    costIncreasePct: 10
```

Budgets start in `mode: audit` (checked and traced, never enforced), and a later pull request switches them to `enforce` with the replay showing what enforcement would have done. `tokenyard policy schema > policy.schema.json` gives editor completion. The gateway validates the policy again at load, swaps it atomically, keeps the last good revision when a new one fails, and reports the active revision in every trace and in `tokenyard_policy_revision_info`. Rewriting the model on coding-agent traffic needs `allowBodyRewrite: true` with a `because:` line on the route; Claude Code is never routed to a non-Claude model. `guardrails.pii.quotedOnly: true` limits PESEL and card number redaction on product routes to values inside JSON strings. `sessions: { idleTtlHours: 24, newPerKeyPerHour: 1000, newPerServiceKeyPerHour: 10000 }` (the defaults) bounds what client-chosen session ids can create: session budget levels and session markers expire after that many idle hours, and one developer key (or service key) may start at most that many new sessions an hour (any number at once up to it, refilled evenly), checked in the same atomic admit call; a key in keys.yaml may carry its own `maxNewSessionsPerHour` (a whole number up to 1,000,000) instead; over it a request gets a 429 `session-churn` with `x-should-retry: false`, and a session the key already uses keeps working.
