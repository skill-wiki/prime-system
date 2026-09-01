# Authoring a corpus

This page is for someone who wants to build a Prime corpus from scratch
in their own domain — cooking, security policy, ML eval rubrics, legal
clauses, anything. The 28 atom kinds and 14 edge verbs do not change
across domains. What changes is which kinds a given corpus relies on
and how it clusters them.

The path goes:

1. Pick the kinds your domain actually needs.
2. Bootstrap with 5–10 atoms across 3–4 kinds.
3. Add edges (start with `related`, level up later).
4. Compile, query, iterate.
5. Graduate to composition contracts when patterns stabilize.
6. Optional: write a domain-specific MCP wrapper.
7. Optional: publish to a registry.

Six steps in. Two optional. End-to-end timing for an experienced author
on a familiar domain: about a weekend for a 40-atom MVP corpus.

---

## Step 1 — pick your kinds

The full table of 28 lives in [dsl-quickref.md](../reference/dsl-quickref.md).
You will not use all of them. A first corpus typically uses 4–6.

A useful starting heuristic:

| If your domain is mostly about… | Reach for |
|---|---|
| **What is true** (encyclopedic) | `fact`, `term`, `category`, `source` |
| **How to do** (procedural) | `step`, `method`, `tool` |
| **What's allowed** (policy / rubrics) | `rule`, `check`, `constraint` |
| **What it should feel like** (style / voice) | `persona`, `voice`, `template` |
| **Patterns** (problem ↔ solution) | `pattern`, `anti-pattern` |
| **How to organize** | `collection`, `taxonomy`, `principle` |

Pick three or four kinds for your first pass. You can add more in
month two when you discover an edge that doesn't fit. Do not start by
solving for all 28.

Concrete examples from real corpora:

- **Cooking** (`examples/recipes/`, 15 atoms): `fact` (water boils at
  100°C), `step` (slice onions thinly), `method` (sweat aromatics),
  `rule` (acid balances fat), `term` (mise en place).
- **Frontend design** (the corpus repo, 899 atoms): `persona`,
  `pattern`, `rule`, `check`, `template`, `principle`, plus 6 more
  for the long tail.
- **Security policy** (hypothetical, ~50 atoms): `rule`, `check`,
  `pattern`, `anti-pattern`, `term`, `source`, `principle`.

There is no requirement to declare your kinds anywhere — just use the
declaration form at the top of each `.prime` file (`rule`, `pattern`,
`fact`, …). The parser sees the keyword.

---

## Step 2 — bootstrap with 5-10 atoms

Pick a tight slice of your domain. Resist the urge to be exhaustive.
The goal of bootstrap is to **find out what shape your atoms want to
be**, not to fill out a curriculum.

```bash
# Make a workspace
$ mkdir -p my-corpus/sources/@me
$ cd my-corpus

# First atom — a fact
$ cat > sources/@me/fact-rest-meat.prime <<'EOF'
fact RestMeat {
  id: "@me/fact-rest-meat"
  version: "1.0.0"

  statement: "Resting meat 5-10 minutes after cooking lets juices redistribute, raising serving moisture by ~10%."
  confidence: 0.95
  domain: cooking

  related: [
    @me/term-myoglobin,
  ]
}
EOF
```

Repeat for 5–10 atoms. You will feel friction in three places:

1. **Naming.** What's the right id? Use the convention
   `@scope/kind-slug` and lean on slugs that read like English.
   `@me/method-render-bacon` is better than `@me/method-bacon-001`.
2. **Granularity.** When does one atom become two? If you find
   yourself writing "...and also..." in the body, split. An atom
   should answer one question.
3. **Where is the kind boundary?** Is "always salt boiling water" a
   `rule` or a `fact`? Decide once and stay consistent. A common
   policy: if it's testable in a check, it's a `rule`; if it's
   descriptive of the world, it's a `fact`.

Compile early to keep yourself honest:

```bash
$ prime compile sources/@me/fact-rest-meat.prime --dir
✅ Phase 1: Parsed 14 lines, 0 syntax errors
✅ Phase 2: All checks passed
✅ Phase 4: Emitted atom directory
   Tokens: summary=18 core=64 full=104
```

After ~10 atoms, run the full registry check:

```bash
$ prime check --registry --dir sources
═══ Prime Registry — Integrity Check
  Atoms checked:   10
  Passed:          10
  With issues:     0
  Pass rate:       100%
```

---

## Step 3 — add edges

The bootstrap atoms probably have only `related` edges, which is fine.
This step is about **typing** those edges as the structure stabilizes.

Replace `related` with a more specific verb when one applies:

| Replace `related` with… | When |
|---|---|
| `requires` | A only makes sense if B is loaded too |
| `enhances` | B improves A but A stands alone |
| `validates-with` | A's correctness is checkable against B |
| `specializes` | A is a narrower version of B |
| `contradicts` | A and B make opposing claims (compiler L3 will flag) |
| `conflicts` | A and B should never co-load |

```prime
method RenderBacon {
  id: "@me/method-render-bacon"
  version: "1.0.0"

  // Was: related: [ @me/fact-rest-meat ]
  // Now:
  enhances: [
    @me/method-pan-roast-vegetables,    // bacon fat is a stage input
  ]
  validates-with: [
    @me/check-bacon-shatter-test,
  ]

  steps: [...]
}
```

`prime check --registry` will resolve every edge target — broken refs
become errors.

A common newbie pattern: every edge is `related`. That's fine for
month one. By month two you should have at least 30% of edges
typed. By month six, less than 10% of edges should be the generic
`related` verb.

---

## Step 4 — compile, query, iterate

A working corpus has a tight inner loop:

```bash
# Edit
$ vim sources/@me/method-render-bacon.prime

# Compile
$ prime compile sources/@me/method-render-bacon.prime --dir --output ./compiled

# Query (via the generic MCP server)
$ AOE_CORPUS_DIR=$(pwd)/compiled bunx @aoe/mcp-server-core &
$ # ... ask Claude Code about "rendering bacon"
$ # ... or use the CLI:
$ prime show @me/method-render-bacon
$ prime deps @me/method-render-bacon

# Notice a missing piece, edit, repeat
```

Compile time on a 50-atom corpus is ~150 ms. The cost is in *thinking*
about the atom, not in tooling.

A useful drill: pick a real brief from your domain ("how do I cook a
medium-rare steak?"), ask the agent against your corpus, and check
whether the index entries the agent saw were the right ones. Where
the agent had to fall back to its own training data is where your
corpus has a gap.

---

## Step 5 — composition contracts

Once you have stable patterns — typically around 30–50 atoms — graduate
the most central atoms (usually `persona`, `principle`, or
`pattern` kinds) to **composition contracts**. A composition contract
is a `must-include` / `must-avoid` declaration on an atom that tells
the retriever which other atoms MUST be in the loaded set when this
one is loaded.

```prime
persona MichelinFineDining {
  id: "@me/persona-michelin-fine-dining"
  version: "1.0.0"

  // …regular fields…

  composition: {
    must-include: [
      @me/rule-mise-en-place,
      @me/rule-acid-balance,
      @me/check-plating-discipline,
      @me/principle-restraint,
    ]
    must-avoid: [
      @me/persona-comfort-food,
      @me/anti-pattern-overgarnishing,
    ]
  }
}
```

Now any retrieval that picks `persona-michelin-fine-dining` is
**required** to also surface those four atoms, and **must not** surface
the two avoid-list ones. The runtime / wrapper enforces this; if you
have your own MCP wrapper it can build the L5 validator on top.

A test for whether you're ready for composition contracts: can you
pre-write the must-include list before generating? If yes, the
contract codifies that knowledge. If no — you don't have a stable
pattern yet; stay at the `requires` / `enhances` edge level.

---

## Step 6 — domain-specific MCP wrapper (optional, v0.2 roadmap)

The generic `mcp-server-core` is enough for most teams. You only need
a wrapper if your retrieval has **domain logic** the protocol can't
express in edges and kinds alone. Examples:

- **Multi-axis retrieval.** "Given a frontend brief, return one atom
  each from `register`, `pattern`, `motion`, `typography`, `color`,
  `rules` axes." That's a wrapper concern.
- **Intent classification.** "Brief in → IntentObject out." Domain
  classifier, not a corpus operation.
- **Output validation.** "Did the generated HTML satisfy the
  composition contract?" Runtime validator that combines corpus
  knowledge with output parsing.

Today, the generic `aoe_query` tool covers atom search, related-edge
traversal, and projection-level resolution. Domain wrappers can compose
these into higher-level workflows by chaining `aoe_query` calls.

A first-class API for adding domain-specific MCP tools alongside
`aoe_query` (e.g. a `legal_check` tool that runs domain validators on
a text input) is on the v0.2 roadmap. Until then, domain authors who
need custom tools can spawn a separate MCP server and forward
`aoe_query` requests to the core server via the
`@modelcontextprotocol/sdk` client — the same pattern the frontend
corpus repo uses for its five-tool wrapper.

To start the core server today, use the real command:

```bash
AOE_CORPUS_DIR=/abs/path/to/compiled bunx @aoe/mcp-server-core
```

Or in `.mcp.json`:

```json
{
  "mcpServers": {
    "skill-wiki": {
      "command": "bunx",
      "args": ["@aoe/mcp-server-core"],
      "env": { "AOE_CORPUS_DIR": "/abs/path/to/compiled" }
    }
  }
}
```

(For the planned first-class extension API shape, track the v0.2
milestone — the design is captured in the GitHub Discussions thread
"MCP extension points for domain wrappers".)

---

## Step 7 — publish (optional)

Two situations call for a registry:

1. **Multi-machine** — you author on a laptop, run agents on a
   server.
2. **Multi-author** — your team needs a shared canon.

For either, [docs/registry.md](../reference/registry.md) covers self-hosting in
full. The minimum:

```bash
# On your registry host
AOE_REGISTRY_TOKEN=secret bun run scripts/registry-server.ts \
  --port 7700 --root /var/lib/prime-store

# On every author/runner machine
export AOE_REGISTRY=https://prime.team.example
export AOE_REGISTRY_TOKEN=...

# Push
prime publish sources/@me/method-render-bacon.prime

# Pull (on the runner)
prime install @me/method-render-bacon --dir ./sources
```

You don't need a registry to share atoms — `git` is fine. The
registry adds versioning semantics and dependency-resolution via
`--remote`.

---

## Patterns: minimum viable corpus shape

A workable starter corpus has, roughly:

- **5–10 `fact` / `term` atoms** — the lexicon of your domain.
- **3–5 `rule` or `check` atoms** — the things that can be wrong.
- **2–4 `pattern` atoms** — the things you do over and over.
- **1–2 `persona` or `principle` atoms** — the voice / posture.
- **1 `collection` atom** — bundles the above for `scout` queries.

Total: ~15 atoms. Edges: every `pattern` should `requires` at least
one `rule`; every `persona` should reference at least three `pattern`
atoms via `must-include`.

Not pretty, but enough to be useful. You can grow from there.

---

## Patterns: when to split a corpus

One repo, one corpus, one MCP server is the simplest shape. Split when:

1. **Audiences diverge.** A frontend-design corpus and a security
   corpus serve different agents. Splitting lets each have its own
   release cadence.
2. **Scope cap is hit.** A scope (e.g. `@community`) starts colliding
   with another team's atoms. Carve out `@community-cooking` /
   `@community-frontend`.
3. **Versioning needs differ.** The cooking corpus is stable; the
   frontend corpus is iterating weekly. Two corpora let you freeze
   one without blocking the other.

Don't split prematurely — a single corpus with disciplined scopes is
easier to reason about than two corpora with shared atoms.

---

## Patterns: when to introduce a new namespace

A namespace (`@scope`) is a directory under `sources/`. Introduce a
new one when:

- **Authorship boundary.** `@core` (you ship it) vs `@community`
  (others ship it).
- **Stability boundary.** `@stable` (frozen) vs `@experimental`.
- **Domain boundary inside one corpus.** `@cooking` and `@cocktails`
  in a hospitality corpus.

A namespace is just a directory. There's no schema cost. Use them
freely.

---

## Anti-patterns

### Deeply nested atoms

If you find yourself writing nested objects three levels deep inside
one `.prime` file, that's a signal: split. The deeper levels
**probably want to be their own atoms** that the outer atom references.

### Atoms with no edges

An atom with no edges is unreachable except by direct id lookup. If
the only way the agent can find atom X is to already know about X,
you've built dead weight. Either add edges into X (something else
should `enhance`/`require`/`relate-to` it) or delete it.

The exception: bootstrap-stage atoms in week one. By month two, every
atom should have at least one inbound and one outbound edge.

### Mega-atoms

A 1000-line atom is fundamentally a mistake. The whole protocol bets
on small atoms loading lazily; a mega-atom collapses that bet. If you
hit ~400 lines in one `.prime` file, split. Common splits:

- A `pattern` with a long `solution:` prose → one `pattern` (problem
  + solution outline) + N `step` atoms (the procedure) + 1
  `template` atom (the example output).
- A `persona` with extensive `voice:` examples → one `persona` + 1
  `voice` atom + N `template` atoms (one per voice example).

### Inconsistent kind boundaries

Decide once, write it down, follow it. If half your atoms use `rule`
for "things that can be wrong" and the other half use `check`, the
retriever sees an arbitrary distinction and so does the agent. Pick
one boundary and codify it (a CONTRIBUTING.md or a `principle` atom
both work).

### Skipping `prime check --registry`

The integrity check is fast (`prime check --registry --dir sources`
on 100 atoms takes ~50 ms). Run it on every commit. The most common
silent failure is a typo in an edge target — `@me/rule-fooo` instead
of `@me/rule-foo` — and it surfaces only via the registry check.

---

## Reference: the `prime-decompose` Skill

The system repo ships `prime decompose` as a heuristic-only verb.
The Skill version (in the corpus repo, **not here**) is LLM-driven
and produces much higher quality output:

```
A long-form SKILL.md  →  prime-decompose Skill  →  10–30 atoms
                                                   in your corpus
```

If you have an existing markdown SKILL bundle and want to convert it
to atoms, the Skill is the recommended path. The CLI verb is fine for
a first triage; for production-quality decomposition, use the Skill.

The Skill lives alongside the corpus it produces atoms for, because
its prompts and example mappings are necessarily domain-specific.
Each corpus author can fork the Skill and tune its kind-detection
heuristics for their domain.

---

## Checklist

Before declaring a corpus "ready":

- [ ] At least 15 atoms across at least 4 kinds
- [ ] `prime check --registry` is clean
- [ ] Every atom has at least one inbound or outbound edge
- [ ] At least one composition contract (`must-include` /
      `must-avoid`) on a central atom
- [ ] You can pose three real briefs and the agent finds the right
      atoms via index alone
- [ ] A README at the corpus root explaining the scope, the kinds
      used, and the namespace conventions
- [ ] (If publishing) a tested `prime publish` round-trip to your
      target registry

---

## See also

- `docs/cli.md` — every CLI verb in detail.
- `docs/dsl-quickref.md` — the 28 kinds and their required fields.
- `docs/mcp.md` — wiring the corpus into Claude Code.
- `docs/registry.md` — running your own registry.
- `examples/hello-world/` — minimal 5-atom corpus.
- `examples/recipes/` — 15-atom cross-domain proof.
- `examples/coding-style/` — 12-atom team lint corpus.
