# Budgets

**What is guaranteed.** With these premises:

- the `worst-case` estimator,
- a correct and complete price table (models, tiers, modifiers, server tools),
- `serverToolsWithoutMaxUses: block`,
- the tokenizer assumption (at most one input token per byte of body text; see [Limitations](security.md#limitations)),
- a provider that bills no more than the bound,

every request's actual cost is at most its own reservation, and the counter store admits a request only if spent plus reserved plus its estimate stays within the limit on every enforced level, checked and applied in one atomic call (a Lua script on Redis; a critical section without `await` in memory). Two invariants follow, for any number of concurrent requests whose reservation each fits the budget on its own:

1. **Reserved:** at every moment, on every enforced level, spent plus reserved is at most the limit.
2. **Settled:** spent is at most the limit at every moment, because settle replaces each reservation with an actual cost that is not larger.

The worst-case estimate prices every input token at the model's highest input-side rate (the 1 hour cache write rate in today's tables) times every modifier above one, bounds input by the body's byte count plus a fixed overhead (or by the whole context window for any body it cannot bound that way), bounds output by the client's own `max_tokens`, and multiplies both by the server-tool iteration limit when server tools are enabled, plus each tool's `max_uses` times its fee. Coding-agent bodies are never modified, so the client's own `max_tokens` is what the estimate uses.

**The proof.** `test/limits/budget-proof.test.ts` (G4) issues 1,000 requests at once (up to 100 in flight) against a $1 budget, with each actual cost drawn (seeded) between 0 and that request's reservation, and asserts after every admit that invariant 1 holds on the totals the store returns, that final spend is within the budget, that final spend equals the sum of settled costs exactly in micro-USD with nothing left reserved (no lost update), and that every rejection saw spent plus reserved plus its estimate above the limit. A fast-check property test checks that the memory store's admit outcomes equal a sequential model applied in the store's commit order. Every inference route goes through the same admit call, and `test/edge/route-coverage.test.ts` fails if one does not. CI runs it on the memory store in every test job, and on Redis in its `redis` job (`npm run test:redis`, Linux with Node 22, a throwaway `redis:7` container on loopback). The benchmark repeats the scenario through the whole gateway, 1,000 requests on their own open connections sent at the same moment, on both stores and both estimators: 16 admitted and 984 rejected each time, spent plus reserved never above $0.998049 after any admit, overspend $0, and final spend minus settled costs 0 micro-USD (the Budget correctness table in [Measured](benchmarks.md#measured)).

**The concurrency trade-off.** Worst-case reservations are large. One Claude Code turn with a 150,000-byte body and `max_tokens` of 32,000 on Opus 5.5 reserves $2.0600; under a $25 session budget only 12 of 40 such turns sent at once were admitted in flight (12 at a time, not 12 in total), and the rest got 429 until earlier ones settled. The live sessions show the same in practice: ordinary turns reserved $1.66 to $3.58 for turns that cost cents ([Real sessions](real-sessions.md)). The `session-aware` estimator is meant to admit more concurrency in exchange for a weaker bound (overspend at most the sum, over requests in flight, of actual minus estimate), but in v0.1 it reserved the same $2.0600 in that benchmark, because the gateway does not yet pass it the session's previous cache read share and the route set no `reserveOutputTokens`. That is why the session budget in the example starts in audit mode.

**Restarts.** The memory store keeps spend in the process. After a restart it holds only what the `--trace-dir` warm-up seeds from the traces of the current windows, so without `--trace-dir` every restart starts each enforced budget from zero; `tokenyard serve` warns about this on stderr at start. `--store redis` keeps spend across restarts.

`onOverrun: allow-and-debit` lets a stream that outruns its reservation finish and puts the budget into debt, so the next request is blocked; under the premises an overrun cannot happen, and if one does the trace flags `overrun: true`. Cutting a coding-agent stream mid tool call would waste every token already spent, so it is not offered.
