# Skill Wiki — Frequently Asked Questions

[English](./faq.md) · [中文](../zh-CN/community/faq.md)

---

## Table of contents

1. [Why typed atoms instead of free-form markdown?](#1-why-typed-atoms-instead-of-free-form-markdown)
2. [Why a custom DSL instead of YAML or JSON?](#2-why-a-custom-dsl-instead-of-yaml-or-json)
3. [Do I need an LLM running to compile a corpus?](#3-do-i-need-an-llm-running-to-compile-a-corpus)
4. [Can I use Skill Wiki without MCP?](#4-can-i-use-skill-wiki-without-mcp)
5. [How does Skill Wiki differ from RAG?](#5-how-does-skill-wiki-differ-from-rag)
6. [Does Skill Wiki support embedding-based retrieval?](#6-does-skill-wiki-support-embedding-based-retrieval)
7. [What is the scale limit for a corpus?](#7-what-is-the-scale-limit-for-a-corpus)
8. [How does schema evolution work?](#8-how-does-schema-evolution-work)
9. [Does Skill Wiki support multi-tenant deployments?](#9-does-skill-wiki-support-multi-tenant-deployments)
10. [How fast is retrieval?](#10-how-fast-is-retrieval)
11. [Can multiple agents share a corpus?](#11-can-multiple-agents-share-a-corpus)
12. [What if my domain doesn't fit the 28 atom kinds?](#12-what-if-my-domain-doesnt-fit-the-28-atom-kinds)
13. [Why does the compiler write atom content to disk instead of keeping it in memory?](#13-why-does-the-compiler-write-atom-content-to-disk-instead-of-keeping-it-in-memory)
14. [How does the retrieval ranking algorithm work?](#14-how-does-the-retrieval-ranking-algorithm-work)
15. [What license applies to atoms I generate using Skill Wiki?](#15-what-license-applies-to-atoms-i-generate-using-skill-wiki)

---

## 1. Why typed atoms instead of free-form markdown?

Free-form markdown is easy to write but impossible to reason about
programmatically. When two markdown skill files contradict each other, there is
no mechanism to detect it — the model sees both and has to reconcile them in
context, inconsistently.

Typed atoms make the structure explicit. A `rule` atom requires a `claim` field
and an `applies_when` field; the parser enforces this at compile time. A `fact`
atom requires a `statement` and a `confidence` score. Because the structure is
declared, the compiler can validate it, the retriever can filter by kind, the
graph can traverse typed edges, and the projection system can expose exactly the
fields an agent needs — rather than dumping everything.

The analogy to typed programming languages is intentional: types don't prevent
you from expressing what you want, but they catch a class of mistakes before
runtime and make tooling possible.

---

## 2. Why a custom DSL instead of YAML or JSON?

Three reasons, in order of importance:

**Readability under human authoring.** YAML has significant footgun-surface
(implicit type coercion, indentation sensitivity, multi-document files). JSON
requires quoting every key. The `.prime` DSL is designed to be written by humans
in a text editor: block literals with `"""`, atom references with `@scope/id`
syntax, and field names that read like English (`validates-with`, `must-include`).

**Lexer-level atom kind enforcement.** In the `.prime` grammar, the atom kind is
the first token of a declaration. This lets the lexer fail fast on an unknown
kind before parsing the body. With YAML/JSON, kind validation would require a
separate schema-validation pass after parsing, with worse error messages.

**Forward evolution.** A custom grammar can evolve the syntax independently of
any serialization format spec. Adding a new field syntax (e.g., function
signatures, union types, range expressions) doesn't require mapping it to a JSON
Schema or YAML extension. The spec owns the grammar.

The tradeoff is tooling bootstrapping cost: there is no off-the-shelf YAML-aware
editor plugin for `.prime`. This is a known gap.

---

## 3. Do I need an LLM running to compile a corpus?

**No.** L1 and L3 are fully deterministic and require no LLM.

- **L1** (structural): the parser validates field presence, field types, atom-kind
  schema, cross-atom reference resolution, and duplicate ID detection. Pure
  parsing — no network calls.
- **L3** (graph): checks cycle detection in `requires:` edges,
  `must-include` corpus presence, and `contradicts:` flagging. Pure graph
  algorithms — no network calls.

**L2** (semantic) is opt-in and LLM-backed. It's gated by the `DEEPSEEK_API_KEY`
environment variable. When the key is absent, L2 is silently skipped and the
compiler proceeds with L1 + L3 only. You will see a notice in the build output:

```
[compile] L2 semantic check: SKIPPED (DEEPSEEK_API_KEY not set)
```

For most authoring workflows, L1 + L3 are sufficient. L2 is most valuable when
you want to catch semantic contradictions between atoms that share no textual
keywords — e.g., two atoms that each define correct behavior for the same
scenario but recommend different approaches.

---

## 4. Can I use Skill Wiki without MCP?

**Yes.** MCP is one delivery mechanism; it is not required.

The compiled corpus is a directory of JSON files. An agent with filesystem access
can read atoms directly using its `Read` tool. The index is at
`compiled/_index.xml`. Individual atoms are at `compiled/<atom-id>/summary.json`,
`compiled/<atom-id>/core.json`, `compiled/<atom-id>/full.json`.

The MCP server (`bunx @aoe/mcp-server-core` with `AOE_CORPUS_DIR` set) is a convenience layer that wraps this
filesystem access with a structured query interface (`aoe_query`) and handles
edge traversal. It is useful when:

- You want to expose the corpus to an agent that doesn't have direct filesystem
  access (e.g., a remote or sandboxed agent).
- You want the query interface to handle edge traversal and projection selection.
- You want to use the `scope: "search"` mode for keyword-based retrieval across
  the whole corpus.

If your agent can read files and you're comfortable building the retrieval logic
yourself, the MCP server is optional.

---

## 5. How does Skill Wiki differ from RAG?

Both Skill Wiki and embedding-retrieval RAG (Retrieval-Augmented Generation) try
to solve the same problem: giving an agent relevant knowledge without loading
everything into context at once.

The differences are architectural:

| Axis | Embedding-retrieval RAG | Skill Wiki |
|---|---|---|
| Knowledge structure | Opaque chunks — no types | Typed atoms — 28 kinds |
| Retrieval mechanism | Cosine similarity over embeddings | Symbolic: keyword × kind × edge × domain × quality |
| Explainability | Opaque — cosine scores only | Every score axis is inspectable |
| Conflict detection | None — no concept of "conflicting chunks" | `contradicts` and `conflicts` edges; L3 checks |
| Composition contract | None | `must-include` / `must-avoid` per persona atom |
| Infrastructure | Vector database + embedding model | Filesystem only |
| Authoring overhead | Low — write prose, chunk it | Medium — learn the DSL |
| Scale | Millions of chunks | ~10k atoms without sharding |

RAG is the right choice when your corpus is large, unstructured, and you need
semantic similarity across paraphrase. Skill Wiki is the right choice when your
knowledge has structure worth encoding, you need explainable retrieval, and you
want compile-time guarantees.

They are not mutually exclusive: a hybrid where Skill Wiki handles the structured
domain knowledge and a vector store handles unstructured reference documents is
a reasonable architecture.

---

## 6. Does Skill Wiki support embedding-based retrieval?

Not in v0.1.0. Retrieval is entirely symbolic.

The retrieval ranking is a weighted combination of: keyword overlap between the
query and atom text, kind-based boost (e.g., `persona` and `template` atoms
score higher for design-generation tasks), edge-traversal adjacency, domain
match, and quality score. Each axis is inspectable and tunable.

The absence of embedding retrieval means that queries using terminology not
present in any atom's text can miss relevant atoms. This is a known limitation.

Pluggable embedding retrieval is on the roadmap but not in scope for v1. The
architecture is designed so that an embedding score could be added as an
additional ranking axis without changing the atom format or the projection model.

---

## 7. What is the scale limit for a corpus?

The `_index.xml` file — which is always loaded into the agent's context — grows
roughly linearly with atom count. At ~3 KB for 1,000 atoms, it fits comfortably
in most context windows. At ~30 KB for 10,000 atoms, it begins to strain context
budgets on models with smaller windows.

**Practical guidance:**

| Corpus size | Expected behavior |
|---|---|
| < 1,000 atoms | No issues. Index is ~3 KB. |
| 1,000 – 5,000 atoms | Monitor index size. Still fine on most modern models. |
| 5,000 – 10,000 atoms | Index is ~15–30 KB. Consider domain-scoped sub-indexes. |
| > 10,000 atoms | Sharding required. See below. |

**Sharding strategy (not yet implemented in v0.1.0):** split the corpus into
multiple compiled sub-directories, each with its own `_index.xml`. The agent
loads only the sub-indexes relevant to the current task's domain. The `domain:`
field on each atom and the `scope` atom kind are designed to support this.

If you hit the 10k ceiling before sharding is implemented, the workaround is to
maintain multiple corpus directories and mount only the relevant one per session.

---

## 8. How does schema evolution work?

Schema evolution works at two levels: per-atom versioning and spec versioning.

**Per-atom versioning.** Every atom has a `version` field following semver.
Breaking changes to an atom's content (removing a required field, changing a
field's semantic meaning) increment the major version. The atom ID is stable
across versions; the version appears in the registry manifest. Dependents that
pin to `"~1.0.0"` will not receive a major bump automatically.

**Content-addressed IDs.** The compiler can optionally append a content hash to
the compiled output. This means a changed atom produces a different compiled
artifact, making it impossible to silently overwrite content under the same ID.

**Spec versioning.** The protocol spec (`PRIME-PROTOCOL-v1.md`) is versioned
independently of the implementation. The spec version is frozen at v1.0. A v2
spec would be backward compatible at the corpus level (existing atoms remain
valid) unless explicitly breaking. The compiler's `[spec: vX]` tag in build
output tells you which spec version was used.

**Migration path.** There is no automated migration tool in v0.1.0. Renaming a
field across many atoms requires a script or a find-and-replace pass. This is
on the roadmap.

---

## 9. Does Skill Wiki support multi-tenant deployments?

**Yes, via corpus isolation.** Each tenant gets its own compiled corpus
directory. The MCP server is started with `--corpus /path/to/tenant-corpus` and
serves only that corpus. No atom from Tenant A is visible to Tenant B's server.

**Namespace isolation within a shared corpus.** If running a shared corpus is
preferable (e.g., for a SaaS product where tenants each contribute atoms to a
shared pool), the `@scope/` prefix in atom IDs provides namespace isolation.
`aoe_query` can be filtered by scope prefix. The `scope` atom kind exists
specifically to declare the boundary of a knowledge domain within a shared
corpus.

What's not yet implemented: runtime access control (e.g., requiring a token to
read atoms in a specific scope). That would require a middleware layer in front
of the MCP server or a custom registry endpoint. The filesystem-only architecture
delegates access control to the OS.

---

## 10. How fast is retrieval?

**Microseconds to low milliseconds** for a compiled corpus loaded in memory.

The MCP server loads all compiled JSON files at startup. A `aoe_query` call
with `scope: "search"` scans the in-memory atom list and scores each atom. For a
1,000-atom corpus, this is a linear scan over ~1,000 records with simple
arithmetic — typically under 1 ms.

Edge traversal (`scope: "related"`, `scope: "graph"`) is a graph walk over the
pre-resolved adjacency list. Depth-1 traversal on a typical atom with 5–10
neighbors takes tens of microseconds.

The bottleneck in practice is not retrieval but **atom content loading** — reading
the full projection JSON from disk. For an NVMe SSD, a `full.json` file (~400
tokens, ~2 KB) reads in ~50–200 μs. This is done only for atoms that retrieval
selected, not the whole corpus.

Network latency to the MCP server (if it's remote) dominates all of the above.

---

## 11. Can multiple agents share a corpus?

**Yes.** The compiled corpus is read-only from the agents' perspective. Multiple
agents can read from the same corpus directory simultaneously without
coordination. The MCP server is stateless with respect to the corpus content —
it loads at startup and serves reads with no write path.

If two agents need to write to the same corpus (e.g., authoring agents that add
atoms), they should write to separate staging directories and run `prime compile`
to produce a new compiled corpus. Merging two corpora (deduplication, conflict
resolution) is a compiler-level operation; there is no concurrent write path at
the filesystem level.

---

## 12. What if my domain doesn't fit the 28 atom kinds?

Use `kind: custom` and specify your kind name in the `custom_kind` field.

```prime
custom MySpecialKind {
  id: "@myteam/custom-risk-assessment"
  custom_kind: "risk-assessment"
  version: "1.0.0"

  # any fields you want
  risk_level: "high"
  mitigation: "..."
}
```

With a custom kind, you lose:
- Compile-time schema validation for your kind-specific fields (L1 only checks
  the base fields: `id`, `version`, `domain`).
- Kind-aware retrieval boosting (the ranking algorithm doesn't know what a
  `risk-assessment` is).

You keep:
- Edge graph and graph traversal (all 14 edge verbs work normally).
- Projection model (summary / core / full).
- Registry publish / install.
- L3 consistency checks (cycles, contradicts, missing must-include atoms).

The long-term path for a domain-specific kind that proves broadly useful is to
propose it as a new first-class kind in the spec. The spec evolution process
requires a concrete use case, sample atoms, and a proposed schema.

---

## 13. Why does the compiler write atom content to disk instead of keeping it in memory?

Because **the agent's `Read` tool is the load mechanism** — not an IPC call, not
a function call, not a database query.

When an agent decides to load a specific atom at full projection, it calls its
`Read` tool with the path `compiled/@example/fact-water-boils-at-100c/full.json`.
This is a direct filesystem read. There is no process the agent needs to talk to;
there is no IPC overhead; there is no serialization round-trip. The atom file is
just a file.

This design choice has several implications:

- **Auditability.** The compiled corpus is human-readable and inspectable with
  standard filesystem tools. `cat compiled/@example/fact.../core.json` works.
- **No daemon required.** The MCP server is optional. An agent with filesystem
  access can skip it entirely.
- **Cacheability.** OS-level file caching applies naturally. If 10 agents read
  the same atom concurrently, the OS serves it from the buffer cache after the
  first read.
- **Content addressing.** The file path is deterministic from the atom ID. Given
  an atom ID, any tool can construct the path without asking a server.

The alternative — keeping compiled atoms in memory and serving them via IPC —
would require the MCP server to always be running, add latency, and break the
"agent reads files" model that most agent runtimes (including Claude Code) are
designed around.

---

## 14. How does the retrieval ranking algorithm work?

The default ranking algorithm combines five axes multiplicatively (with
configurable weights):

1. **Keyword overlap.** How many query tokens appear in the atom's `id`,
   `summary`, `description`, or tag fields. This is the baseline signal.

2. **Kind boost.** Different atom kinds can be weighted differently depending on
   the corpus configuration. Boosts are set via `AOE_KIND_BOOSTS` (a JSON map
   of kind → float) or via `domain.yaml`. By default, all 28 kinds have equal
   weight. A frontend corpus might boost `persona` and `template`; a security
   corpus might boost `rule` and `check`; a recipe corpus might boost `step` and
   `method`. The boost table is fully configurable per corpus.

3. **Edge-traversal adjacency.** If an atom that already scored highly has a
   `requires` or `enhances` edge to another atom, that neighbor receives a
   secondary score boost. This implements the "follow the graph" heuristic.

4. **Domain match.** If the query or context indicates a specific domain
   (e.g., `security`, `cooking`, `typography`), atoms tagged with that domain
   score higher. Domain tags are configured in `domain.yaml` — the protocol
   does not hardcode any tag vocabulary.

5. **Quality score.** Each atom can carry a `quality` field (0.0–1.0). This is
   set by the corpus author and reflects confidence in the atom's correctness
   and completeness. It acts as a tiebreaker.

The final score is a weighted product of these five axes. The weights are exposed
in the corpus manifest and can be overridden per-query via the `aoe_query`
interface.

Topic synonyms (e.g., mapping "字体" and "typography" and "font" to the same
retrieval topic) are configured in the corpus's domain plugin. Without them,
cross-language or cross-terminology queries degrade to keyword overlap only.

---

## 15. What license applies to atoms I generate using Skill Wiki?

**Your call entirely.** The Skill Wiki system (parser, compiler, runtime, CLI,
MCP server) is Apache-2.0. Using it to author and distribute atoms does not
impose any license constraint on the atoms themselves.

Think of it like using a code editor: the editor's license does not affect the
license of the code you write with it.

If you publish atoms to the public registry, you are expected to declare the
license in the corpus manifest. The registry will display it. Downstream
consumers can filter by license.

If you incorporate atoms from a corpus that ships with a specific license (e.g.,
the `prime-corpus-frontend` repo, which includes atoms derived from
MIT-licensed sources), you must respect that license for those atoms. The
`NOTICE` file in each corpus repo documents third-party attributions.

The 3 example corpora in this repo (`hello-world`, `recipes`, `coding-style`)
are Apache-2.0 along with the system code.

---

*Skill Wiki v0.1.0 · Apache-2.0 · [Back to docs](../../README.md#documentation)*
