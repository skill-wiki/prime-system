---
description: Resolve a task brief into concrete typed atom values via Prime
argument-hint: <task brief>
allowed-tools: mcp__prime-wiki__prime_resolve, mcp__prime-wiki__prime_query, Read
---

The user wants to resolve the following brief into concrete, typed atom output from the Prime knowledge corpus:

> $ARGUMENTS

Do this:

1. If the MCP tool `prime_resolve` is available, call it with the brief above. Pass the brief verbatim as the input. Surface the returned atom IDs, kinds, and any projected values exactly as Prime returns them — do not paraphrase typed fields.
2. If `prime_resolve` is not wired up, fall back: call `prime_query` (or read `_index.xml` from the active corpus) to find atoms whose kind/tags match the brief, then load the top 3-5 candidates and present their key fields.
3. Report results as a short table: atom id, kind, why-it-matched, the load-bearing field(s).
4. End with one line on what is still ambiguous and would need a follow-up brief to pin down.

Keep the response tight. Prime's value is precision — do not invent fields the corpus did not return.
