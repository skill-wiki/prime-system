# Philosophy

> Why Skill Wiki has the shape it has. Five load-bearing decisions, each
> with a specific failure mode it's trying to avoid.

[← back to README](../../README.md) · [Architecture](./architecture.md) · [Getting started](../getting-started.md) · [DSL quick reference](../reference/dsl-quickref.md)

---

## The one-line thesis

> **Existence ≠ content.**

Knowing that a definition of "OWASP input-validation rules" exists is
different from holding all 1841 bytes of its prose in working memory.
Wikipedia separates the two — every reader knows the encyclopedia has
articles on prime numbers without first loading them. Pre-Skill-Wiki
agent stacks routinely conflate the two: every Skill that *might* be
relevant ships its full prose into the prompt every turn.

That's the entire design pivot. Everything that follows is the
consequence of taking that line seriously.

---

## Decision 1 — Typed atoms, not blob skills

The dominant pattern for teaching an LLM agent something is: write a
~200-line markdown file. Give it a YAML frontmatter, give it sections,
give it examples. Load it as system prompt when relevant.

This works at small scale and breaks at large scale. The breakage is not
"too much text." The breakage is **information theory**:

- A blob of prose has high *entropy* — the same idea can be written 50
  ways. Two blobs about the same rule disagree on phrasing and the
  retriever can't reconcile them.
- A blob of prose has low *type* — the system can't ask "give me only
  the persona-style atoms" because there are no personas, only
  paragraphs.
- A blob of prose has no *boundary* — if you want to use just three
  rules out of the file, you have to extract them mentally and the
  model has to ignore the rest.

The atom design is a direct response. Each unit of knowledge declares:

1. **Its kind.** One of 28 — `fact`, `rule`, `pattern`, `persona`,
   `term`, `method`, `constraint`, …
2. **Its required fields, by kind.** A `rule` has a `claim` and an
   `applies-when`. A `persona` has `composition.{must-include, must-avoid}`.
   A `pattern` has a `problem` and a `solution`. The parser enforces.
3. **Its references, typed.** Not "see also: X" but `requires: X`,
   `enhances: X`, `validates-with: X`.

Once knowledge has a kind, the retriever can ask for kinds, the
validator can check schemas, the chunker can produce kind-aware
projections, and the conflict-finder can spot two `fact` atoms
disagreeing on the same `applies-to`.

It's the same gain TypeScript brought over JavaScript. Types do not
generate working code; they catch the *kind* of mistake that scales
linearly with codebase size and superlinearly with team size.

A 200-line markdown skill is JavaScript. An atom corpus is the typed
version.

---

## Decision 2 — Lazy projection, not eager injection

![Projection model — existence is not content](../assets/projection-model.png)

The architectural inversion at the center of Skill Wiki:

| Eager injection | Lazy projection |
|---|---|
| All possibly-relevant skills loaded into system prompt | An index of *what exists* is always loaded |
| Skills loaded by tags / triggers | Atoms loaded by retrieval ranking + agent decision |
| Token cost grows with skill count | Token cost grows with task complexity |
| One bad skill pollutes every turn | Bad atoms are filtered per-turn by relevance |

The pre-existing pattern is a *push* model: the system pushes everything
the brief might need into context, hoping the model picks the right
parts. This is what we measure as **context pollution** — not too many
tokens, but the *wrong* tokens actively misleading the model.

Skill Wiki is a *pull* model: the index says "an atom for GDPR
right-to-erasure rules exists." The agent decides whether to read its
summary, core, or full projection. Token cost is bounded by what the
agent actually decides to use, not by the size of the corpus.

The Wikipedia analogy is exact: every reader knows the encyclopedia
*contains* an article on prime numbers without loading the article.
Loading happens when the reader navigates there. The decoupling is the
whole design.

> **The agent fetches by ID. The system never injects by relevance
> guess.**

This sounds like an implementation detail. It is the line that lets a
1000-atom corpus run cheaper than a 50-skill blob library, and the line
that lets the corpus stay coherent as it grows past what any human
reviewer can hold in their head.

---

## Decision 3 — Edge verbs, not flat related lists

A "related" link is a hyperlink. It says: there's some kind of
connection. Click and find out.

A typed edge says: "A *requires* B" — meaning if A loads, B MUST load.
"A *conflicts* B" — meaning never load both. "A *contradicts* B" —
meaning they make semantically opposing claims.

The verb is load-bearing. It changes how the retriever, the validator,
and the compositor *all* behave:

- **Retriever.** When the brief picks atom A, follow `requires` edges
  outward and add the targets as primaries. Follow `enhances` edges and
  add as soft adjuncts. Follow `conflicts` edges and *exclude* the
  targets. Three different graph traversals, all driven by edge type.
- **Validator.** `contradicts` between A and B is an L3 flag — load
  both and the validator surfaces the contradiction to the user.
  `validates-with` confirms the validation source itself exists and is
  itself valid.
- **Compositor.** `must-include` from a persona's composition contract
  becomes a constraint on the candidate set. The compositor solves a
  small constraint problem each turn.

A flat "related" list cannot drive any of this. Three of these
operations require knowing *what* the relation is.

The 14 verbs are not arbitrary. Each is justified by a specific
behavior the system needs:

- Loading discipline: `requires`, `enhances`, `conflicts`, `compatible`,
  `includes` (5)
- Type system: `specializes`, `extends`, `derived-from` (3)
- Truth relation: `contradicts`, `validates-with`, `supplies-to` (3)
- Discovery only: `related`, `see-also`, `relationships` (3)

The 14 verbs are few enough that authors can hold them all in their head.
Past a certain count, edge verbs become as opaque as untyped strings — authors
guess which to use, the corpus becomes inconsistent. Each verb has a clear
semantic contract.

---

## Decision 4 — Composition contracts, not free composition

Most knowledge systems treat composition as the agent's problem. "Here
are 50 rules; here is your task; figure out which apply." The model
guesses; sometimes it guesses wrong; you can't tell which time it did.

A composition contract makes the constraints explicit. Consider a
`persona` atom for a security-review corpus:

```prime
persona ThreatModeller {
  id: "@security/persona-threat-modeller"
  version: "1.0.0"

  description: "The attacker's lens: assume breach, enumerate attack surfaces, prioritise exploitability."

  composition: {
    must-include: [
      @security/principle-defence-in-depth,
      @security/check-input-validation-coverage,
      @security/taxonomy-owasp-top10,
    ]
    must-avoid: [
      @security/persona-optimist,
    ]
  }
}
```

*(The `typography-required` / `color-required` sub-fields in the
frontend corpus's contracts are domain-specific extensions — not part
of the protocol. See
[`spec/FRONTEND-DESIGN-DOMAIN-v1.md §3`](../../spec/FRONTEND-DESIGN-DOMAIN-v1.md)
for those fields.)*

Three things are now machine-checkable:

1. If the brief picks `persona-threat-modeller`, the compositor *must* load
   the three principle/check/taxonomy atoms. They are not advisory — they are
   contract clauses.
2. If `persona-optimist` also got picked, the L3 checker *will* flag the
   composition as invalid. They are explicitly mutual.
3. If the agent's output omits input-validation coverage, the L5
   composition-contract validator catches the must-include violation.

This is the type system *for domain knowledge*. Two universal layers —
must-include, must-avoid — each enforced at a different stage. Domains
add typed sub-fields via their `domain.yaml`'s `contract:` block.

Free composition is JavaScript with no types. Contract composition is
TypeScript: most of the time the constraints don't trigger, but when
they do, they catch the bug *before* it reaches the user.

---

## Decision 5 — Compile knowledge with a small LLM

Until ~2024, semantic validation of natural-language claims was a
research-grade problem. You could write a `fact` claiming "blue light
suppresses melatonin" and a sibling `fact` claiming "screen color
temperature does not affect sleep," and the system had no way to know
they contradict.

Two things changed at once:

1. **Small models got cheap.** A semantic-equivalence call on two
   atoms now costs around $0.0001. At 1000 atoms, that's $0.10 to
   re-validate the entire corpus.
2. **Small models got reliable enough.** Not for free-form generation
   — for a constrained yes/no judgment ("are these two claims about
   the same applies-to set, and do they agree?"), a Haiku-class model
   answers correctly often enough to be useful, and known errors are
   rare enough to be worth investigating manually.

This is the L2 layer of the compiler. It runs once per atom (and once
per `contradicts`-edge target pair) at build time. It catches the
specific class of bug that a static schema check cannot:

- Two `fact` atoms that disagree about the same applies-to set
- A `rule` whose `severity` says `low` but whose `description` describes
  a critical blocker
- A `persona` whose `implies.color` includes a color its
  `prohibitions` rules out

These are not syntax errors. They are *internal contradictions* — the
kind that 12-month-old corpora drift toward as different authors
contribute atoms over time. The same dynamic plays out in a legal
corpus ("GDPR Art. 17 requires erasure" vs a stub claiming "retention
is always allowed"), a security corpus ("force TLS 1.3" vs a legacy
rule permitting TLS 1.1), or a recipe corpus ("always salt pasta water"
vs an older atom claiming salt makes no difference to flavor).

L2 is optional. Set `DEEPSEEK_API_KEY` and it runs; don't, and it
gracefully skips. We list this as Decision 5 not because every corpus
needs it, but because it represents a category that did not exist
before: *checks that read natural language and reason over it, run as
part of a build.*

A traditional compiler does not read prose. Skill Wiki's does. That is
the new ground.

---

## What this is not

A few patterns that are out of scope:

### It is not a vector database

Embedding-similarity retrieval is fast, opaque, and unreasonable.
Cosine similarity has no opinion about kinds, edges, or contracts. It
returns prose that *resembles* the brief lexically. When prose contains
a reasoning trap (the kind L2 catches), embedding retrieval has no
defense.

Vector retrieval is the right tool for surfacing relevant documents in a
million-document corpus. Skill Wiki's job is different: a few thousand atoms
with semantic structure, where retrieval is *explainable*. Different problem;
different shape.

You can layer embeddings *on top* of Skill Wiki. The protocol does not
require them, but does not prohibit them.

### It is not a model

Skill Wiki has no opinion about which LLM you call. The protocol layer
runs on Node 22+ with no model dependencies. Plugins (intent
classification, semantic validation) talk to LLMs but the *protocol*
does not bake any model in.

Knowledge libraries should outlive any specific model release. A corpus
written for one generation of model still type-checks on the next.

### It is not a Skill replacement

A Skill is a workflow recipe — "when the user says X, do Y, then Z."
Skills orchestrate; they decide what to do at what moment. Skill Wiki
supplies the *atoms* the workflow consumes.

The two compose. A future Skill might be 30 lines of orchestration
that imports a few hundred atoms by ID:

```yaml
imports:
  - @nielsen/taxonomy-10-heuristics: full
  - @impeccable/persona-editorial: core
  - @w3c/wcag-2.2-rules: summary
sequence:
  - apply @nielsen/heuristic-1
  - check @w3c/contrast-aa
  - report
```

Workflow is the orchestration layer. Skill Wiki is the knowledge layer.
Different concerns, both necessary.

### It is not tied to any subject matter

The 28 kinds and 14 verbs are structural abstractions over what knowledge
*is*, not over any specific field. A frontend-design corpus, a security
policy corpus, a culinary corpus, and a legal-clause corpus each express
their knowledge through the same 28 kinds and traverse the same 14 verbs.
The protocol does not change across subjects.

A new domain plugs in by registering a `DomainPlugin`. See
[architecture.md#domain-plugin-architecture](./architecture.md#domain-plugin-architecture)
for the contract.

---


## The shape of what comes next

The protocol is frozen at 1.0 for two years. Beyond that:

- **Atom lifecycle.** Today a `deprecated` atom is a flag. Tomorrow the
  compiler emits a warning when one appears in a retrieval result, and
  refuses to publish a new corpus that depends on a deprecated atom in
  another corpus. Atoms must shrink, not just grow.
- **Domain plugin formalization.** The DomainRegistry pattern is in the
  code; the formal domain-plugin spec is in the roadmap. v1.1 documents
  exactly what a plugin must implement.
- **Provenance and trust.** A `source` atom can cite a paper. A future
  version lets that citation be verifiable — the compiler can confirm
  the cited paper exists and the claim is supported.

These are extensions of the same axis. Knowledge gets typed; types get
enforced; enforcement extends to more dimensions over time.

---

## One sentence to close

> **Knowledge has structure. Honor the structure and the cost goes down,
> the quality goes up, and the system gets smaller as it gets smarter.**

Or, in the form that actually drives the code:

> Existence ≠ content.

[Read the architecture.](./architecture.md)
