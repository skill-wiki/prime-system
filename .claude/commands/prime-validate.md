---
description: Validate a built artifact against a Prime brief contract
argument-hint: <artifact-path> <brief>
allowed-tools: mcp__prime-wiki__prime_validate, Read
---

The user wants to validate a built artifact against a Prime brief. Arguments:

> $ARGUMENTS

The first token is the artifact path (file or directory). Everything after is the brief.

Do this:

1. Call the MCP tool `prime_validate` with `artifact = <first arg>` and `brief = <rest>`.
2. Return the result as a structured pass/fail block:
   - overall verdict: PASS / FAIL / PARTIAL
   - per-check rows: rule id, expected, actual, status
   - any contradicted atoms or violated edges, with their ids
3. If `prime_validate` is not available, read the artifact directly, then load the atoms named in the brief and do a manual contract check on the load-bearing fields. Mark this case clearly as "manual fallback — no Prime contract enforcement".
4. End with a one-line recommendation: ship / fix-before-ship / re-author-brief.

Do not soften failures. The validator is the contract.
