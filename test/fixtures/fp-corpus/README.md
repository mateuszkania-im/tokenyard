# False-positive corpus for the secret rules

`test/guardrails/fp-corpus.test.ts` sends every file below as a `tool_result` in the newest user turn, with every
default rule set to `block`, and expects zero block hits (spec 6.6, "measured, not assumed"). It prints
`block hits: <n>`.

## Sources

- **tokenyard**: every file `git ls-files` lists in this repository, including `package-lock.json`, the conformance
  fixtures in `test/conformance/fixtures`, the docs and the committed bundle `bin/tokenyard.mjs`.
- **why-diff**: every tracked file of `../why-diff` when it is checked out beside this repository (CI checks it out),
  including its `package-lock.json`.
- **read-receipts and other trees**: every path in `TOKENYARD_FP_CORPUS` (separated by the platform's path delimiter,
  `:` on Linux and macOS) is scanned the same way. read-receipts is scanned only when this variable points at it.

## Left out on purpose

Files that hold positives by design, because they test secret detection itself:

- tokenyard `test/guardrails/` and `test/edge/taint.test.ts` (the rule and taint tests).
- why-diff `test/redact.test.ts` (why-diff's own redaction tests: a JWT and private key fixtures).

AWS's documented example key id `AKIAIOSFODNN7EXAMPLE` is a positive by design (the rule tests and the demo use it), so
the test counts its matches apart instead of as false positives.

Files over 4 MiB are skipped.
