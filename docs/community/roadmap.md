# Roadmap

> Where Skill Wiki / Prime is going. Annotated with status and rationale.
> See [CHANGELOG.md](./CHANGELOG.md) for what's already shipped.

This roadmap covers only the **system** repo. Corpus repos (e.g.
`prime-corpus-frontend`) maintain their own roadmaps; the protocol moves at
its own pace, independent of any single corpus.

Status legend:

- ✅ **Shipped** — in v0.1.0
- 🟡 **Underway** — being worked on now
- 🔵 **Planned** — committed, not started
- ⚪ **Considering** — open question, may or may not happen
- ❌ **Out of scope** — explicitly not pursuing

---

## v0.1.0 — protocol baseline `[shipped 2026-05-09]`

The protocol baseline: implementation separated from any domain corpus.

✅ Parser + L1 structural checker
✅ L3 cross-atom graph checker
✅ Runtime atom loader + projection resolver
🔵 Generic validator-core (L1/L2/L3 framework, HTML-agnostic) — not shipped in v0.1.0
✅ HTTP registry with publish / install
✅ `prime` CLI with 10 verbs
✅ Generic MCP server (`prime_query` over any compiled corpus)
✅ 3 example corpora demonstrating cross-domain applicability
✅ Protocol spec at `spec/PRIME-PROTOCOL-v1.md`
✅ Apache-2.0 license + NOTICE attributions

---

## v0.2 — lifecycle and AST `[planned · Q3 2026]`

The two pieces of v1 spec the v0.1 implementation didn't honor.

### 🔵 Lifecycle enforcement

The atom DSL allows `version: "1.2.0"` and a status field:
`active` | `deprecated` | `experimental`. Today the parser accepts these but
the compiler does nothing with them — `deprecated` atoms appear in retrieval
without warnings.

Plan: when a `deprecated` atom is selected by `prime_query`, the response
includes a `warnings: [{ kind: "deprecated", atom_id, message, replacement }]`
field. The runtime API surfaces this; the CLI prints a yellow warning line.

Optional follow-up: `prime check --strict-deprecation` fails the build when
the corpus contains active references *to* deprecated atoms (i.e. a `requires:`
edge points at one). This converts deprecation into a soft-deprecation /
hard-deprecation pipeline.

### 🔵 Structured type AST

Atoms can declare types using a small expression language: function
signatures `(input: AtomList) -> CompositionResult`, unions `"low" | "med" | "high"`,
ranges `0.0-1.0`. Today the parser preserves these as opaque strings — they
round-trip correctly but the compiler can't reason over them.

Plan: build a `TypeExpr` AST (Function | Union | Range | Primitive | Ref).
Use it to enforce that, e.g., the `confidence:` field of a `fact` atom
parses as a `0.0-1.0` range. This unblocks better error messages and a
future "type checker for compositions."

---

## v0.3 — formal domain plugin protocol `[planned · Q4 2026]`

Today, `domain:` is a metadata tag on each atom. The runtime treats
`frontend-design`, `security`, `recipes` identically — each retrieval call
returns whatever atoms match, regardless of whether the brief is about
HTML or about salad dressing.

This works because in practice each MCP server only loads one corpus. But
the spec already imagines multiple corpora coexisting under one server, with
domain-aware routing. To get there:

### 🔵 Plugin interface

```typescript
interface DomainPlugin {
  name: string;                                    // "frontend-design"
  matches(intent: IntentObject): number;            // 0-1 score
  retrievalAxes: AxisDefinition[];                  // domain-specific axes
  validators: { l1?, l2?, l3? };                    // domain-specific validators
}
```

Corpus packages register plugins; the runtime routes briefs to the highest-
scoring plugin and applies that plugin's retrieval axes and validators.

### 🔵 Multi-corpus MCP

The MCP server supports multiple corpora via multiple `PRIME_DIR`-equivalent
env vars or a config file. The generic `prime_query` tool gains an optional
`corpus:` parameter. If omitted, the runtime infers from intent.

### ⚪ Auto-domain disambiguation

When a brief is ambiguous between two corpora (e.g., "make a layout for the
recipe steps" — recipes? frontend-design?) the runtime returns a list of
candidate atoms from each, sorted by per-corpus rank, and lets the agent
pick.

---

## v0.4 — better registry `[planned · 2027]`

The v0.1 registry is a barebones HTTP service: PUT to publish, GET to
install. No semver resolution, no signing, no audit log. It's enough for a
self-hosted team registry; it's not enough to be the npm / crates.io of
agent knowledge.

🔵 Semver-aware install. `prime install @example/atom@^1.2` resolves to the
   highest matching version, locks via `prime.lock`.
🔵 Cryptographic signing. Authors sign atoms; consumers verify.
🔵 Audit log. Registry records who published what, when. Required for
   trust in third-party namespaces.
⚪ Web UI. Browse atoms / collections in a browser. Out of scope unless
   someone actually self-hosts the public registry.

---

## v1.0 spec → v2.0 spec `[considering · 2027]`

The current spec freezes at 28 atom kinds, 14 edge verbs, 5 MCP tools (in
the wrapper layer; the system core has 1). Open questions for v2:

### ⚪ Should there be fewer kinds?

Some kinds are barely used in practice. `provocation` and `feedback` and
`tradeoff` could fold into `principle` with a `subtype:` field, dropping the
top-level count to ~22. Counter-argument: the kind name *is* the semantic
hint for retrieval; collapsing them muddies the rank. Will revisit after
3-5 corpus repos exist.

### ⚪ Should edge verbs be extensible?

Today the 14 verbs are closed. A corpus that wants `regulates` (e.g., an
ISO-standard atom regulates a `rule` atom) has to overload `validates-with`
or `enhances`. Adding a `verb_extensions:` declaration would let corpora
register new verbs with documented semantics. Risk: every corpus invents
its own dialect; retrieval portability dies. Mitigation: the spec lists
which verbs are core and which are extension; tools warn on extension
verbs by default.

### ⚪ Should atoms have content addressing?

Each atom currently has a string `id`. A change to a published atom
silently changes downstream behavior. A content-addressed scheme (each
atom's compiled JSON hashed; references include the hash) would catch
this. Would also enable distributed registries (anyone can host any
hash). Tradeoff: human-readable IDs are nice for authoring; content
hashes are uglier in source. Likely solution: keep human IDs, add a
`@digest` suffix as opt-in.

---

## Out of scope (won't pursue here)

❌ **Vector embeddings as the primary retrieval mechanism.** The protocol
   is structured retrieval. Embeddings can layer on top (a corpus can
   compute embeddings during compile and a retrieval plugin can use them);
   they're not the substrate.

❌ **A web app for browsing atoms.** That's a corpus-repo concern, not a
   protocol concern.

❌ **A "Skill compiler" that turns SKILL.md into atoms.** Lives in the
   corpus repo as the `prime-decompose` Claude Code Skill — it's domain-
   adjacent (you decompose to *some* corpus) and shouldn't be a system
   responsibility.

❌ **Bundling / minification of corpora for the wire.** A corpus's compiled
   form is already minimal (atom dirs, projections per level). If you want
   smaller, gzip the directory.

❌ **Built-in observability / metrics.** The MCP server logs to stderr.
   For Prometheus / OpenTelemetry, wrap the runtime; the protocol
   doesn't need to know.

---

## How priorities are set

Three questions for any addition:

1. **Does it unblock a corpus team that exists today?** (Strong yes.)
2. **Does it generalize across corpora?** (Strong yes — protocol-level
   features must.)
3. **Does it preserve the "tiny system, expressive corpus" balance?**
   The system repo aims to stay under ~15k LoC.

The fastest path for a feature: (a) prototype in a corpus repo, (b) prove
it generalizes by porting to a second corpus, (c) propose the protocol change.

---

## Tracking

Active work: GitHub project board (link TBD, when the repo is published).
Major decisions land in this file as they're made; minor refinements live
in CHANGELOG entries.
