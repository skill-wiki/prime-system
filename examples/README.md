# Example Corpora

> Three minimal, complete, cross-domain corpora. Hello-world through real-but-tiny.

Three working corpora, each in a different domain — physics, cooking, and team
engineering standards. Each is a complete runnable corpus: compile it, boot the
MCP server, and query it in under two minutes.

Pick whichever matches your starting point.

---

## The three corpora

| Corpus | Atoms | Kinds used | What it teaches |
|---|---|---|---|
| [`hello-world/`](./hello-world/) | 5 | fact, term, rule, method, collection | The smoke test. One command to compile, one to query. Verify your install works. |
| [`recipes/`](./recipes/) | 15 | fact, term, rule, pattern, anti-pattern, method | Cross-domain proof. Shows graph density, typed edges, and the interplay between knowledge kinds. |
| [`coding-style/`](./coding-style/) | 12 | rule, pattern, anti-pattern, principle, tradeoff, collection | Institutional knowledge. A team's lint rules as atoms — with the `tradeoff` kind showing explicit engineering tensions. |

---

## Which to start with

**I want to verify my install works.**
→ [`hello-world/`](./hello-world/). Five atoms. One compile command. Done.

**I'm authoring my first real corpus and need a pattern to follow.**
→ [`recipes/`](./recipes/). Fifteen atoms across eight kinds. Dense enough to see how the graph forms. Small enough to read in 20 minutes.

**I want to encode my team's engineering standards for an AI agent.**
→ [`coding-style/`](./coding-style/). Twelve atoms showing rules, patterns, anti-patterns, a principle, and a trade-off. Use as a template: copy, change `@team` to your namespace, adapt the atoms to your actual rules.

**I want to see the full range of what the protocol can express.**
→ Read all three corpora in order. Each one demonstrates progressively more of the protocol's features.

---

## What each corpus demonstrates

### hello-world — the smoke test (5 atoms)

```
@example/fact-water-boils-at-100c   ──supplies-to──►  @example/method-make-tea
@example/rule-altitude-affects-boiling ──supplies-to──►  @example/method-make-tea
@example/method-make-tea  ──requires──►  @example/fact-water-boils-at-100c
@example/collection-tea-basics  ──includes──►  (all four atoms)
```

Demonstrates: fact / term / rule / method / collection — the five most common kinds.
Demonstrates: `requires`, `supplies-to`, `enhances`, `includes` edge verbs.
Does not demonstrate: patterns, anti-patterns, tradeoffs, or deep graph traversal.

### recipes — cross-domain proof (15 atoms)

Eight kinds. Thirty-plus edges. A method (`method-pan-sauce`) that requires four atoms
across three kinds. Anti-patterns that point at each other via `see-also`. A pattern
that supplies to a method.

Demonstrates: graph density, cross-kind edges, the `anti-pattern` and `pattern` kinds,
and how a corpus naturally forms a graph around a hub atom.

### coding-style — institutional knowledge (12 atoms)

A TypeScript team's style guide. Four enforced rules, three preferred patterns,
two active anti-patterns, one root principle, one explicit trade-off, one collection.

Demonstrates: the `principle` kind (root heuristics), the `tradeoff` kind
(explicit engineering tensions), and how atoms coexist with a linter
(`rule` atoms explain why, `.eslintrc` enforces how).

---

## How corpora relate to the system

Each corpus is independent. It lives in its own directory with its own `primes/sources/`
and `primes/compiled/`. The system repo provides the tools; corpora provide the knowledge.

```
prime-system/          ← this repo (tools, parser, compiler, runtime)
  examples/
    hello-world/       ← tiny corpus, ships here for smoke-testing
    recipes/           ← medium corpus, ships here as cross-domain proof
    coding-style/      ← medium corpus, ships here as institutional-knowledge proof
  packages/
    parser/
    compiler/
    ...

prime-corpus-frontend/ ← separate repo (899-atom frontend design knowledge)
your-corpus/           ← your domain, your namespace, your atoms
```

The generic MCP server (`packages/mcp-server-core/`) works with any compiled corpus.
Point it at any of these directories and it serves that corpus over the MCP protocol.

---

## Authoring your own corpus

After reading these examples, follow the authoring guide:

- [`docs/corpus-authoring.md`](../docs/corpus-authoring.md) — start here
- [`docs/dsl-quickref.md`](../docs/dsl-quickref.md) — field-by-field DSL reference
- [`spec/PRIME-PROTOCOL-v1.md §1.2`](../spec/PRIME-PROTOCOL-v1.md) — all 28 atom kinds with required fields

The short version:
1. `prime init my-corpus/` — scaffold the directory
2. Write `.prime` files in `my-corpus/primes/sources/@myscope/`
3. `prime compile my-corpus/primes/sources --out my-corpus/primes/compiled`
4. `PRIME_DIR=my-corpus/primes/compiled bunx @prime-lang/mcp-server-core`
5. Wire the MCP server into your agent

You do not need to publish to a registry to use a corpus locally.
Publishing is optional — for sharing with a team or the community.
