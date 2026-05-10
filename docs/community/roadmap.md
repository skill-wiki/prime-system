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

## Prime self-evolution `[planned · 2026 → 2027]`

Why: a corpus that only grows by hand-written PRs goes stale. Real usage is the
best signal for what's missing — which atoms get queried with no hit, which
intents return low-confidence results, which projections get rewritten by the
agent before use. v0.1 throws all that signal away. v0.2+ keeps it, opt-in,
and feeds it back into the corpus.

### 🔵 Telemetry ingest API

A small, opt-in HTTP endpoint the runtime can POST to on every `prime_query`:
intent, kinds asked, ids returned, projection level, hit / miss, latency. No
content, no PII. Off by default; enabled per-corpus via `domain.yaml`.

### 🔵 Atom-proposal PR-bot

A scheduled job that reads the telemetry stream, finds repeated zero-hit
queries, and uses an LLM extractor (e.g., DSPy-style program) to propose new
atoms. Output: a draft PR against the corpus repo with a stub `.prime` file
the maintainers can edit and merge.

### 🔵 Edge inference reflective pass

After a corpus authors write atoms, run a TextGrad-style pass that proposes
likely edges (`requires`, `contradicts`, `validates-with`) by reflecting on
each pair. Maintainers approve / reject; nothing auto-merges.

### ⚪ Atom-diff viewer in marketplace UI

When a corpus version bumps, show the diff at the atom level: which atoms
changed, which edges moved, which projections re-rendered. Helps consumers
audit upgrades.

### ⚪ Auto-tuning of projection priors

The chunker's projection prior (which fields to keep at `summary` vs `core` vs
`full`) is hand-coded per kind today. A DSPy-style program could tune those
priors per corpus, optimising for downstream task accuracy.

**Moonshot:** schema evolution. Today, atom kinds are fixed by spec. A
corpus accumulating telemetry could *propose its own kinds* — à la
[AutoSchemaKG](https://arxiv.org/abs/2402.14531) — and bubble them up as v2
spec candidates.

References:
[DSPy](https://dspy.ai/) ·
[TextGrad](https://textgrad.com/)

---

## Prime evaluation `[planned · 2026 Q4]`

A protocol is only as useful as it is measurable. Today, the only evaluation
is "does the agent cite the right atoms" — checked by hand on a 20-task
benchmark. v0.2 makes this a first-class verb.

### 🔵 `prime eval` CLI verb

A corpus-scoped harness that wraps [Inspect AI](https://inspect.aisi.org.uk/)
under the hood. Reads a `eval/` directory of task definitions, runs them
against a configured agent, scores against expected atom citations and
domain-specific scorers.

### 🔵 MCP-Bench adapter

An adapter that exposes a Skill Wiki corpus to
[MCP-Bench](https://github.com/Accenture/mcp-bench) so corpora can be
benchmarked head-to-head against other MCP servers on the same task suite.

### 🔵 Domain-specific scorer plugins

The harness ships with kind-aware scorers; corpora can register more.
Examples for `prime-corpus-frontend`: axe-core pass-rate, Lighthouse score,
visual-regression delta. For a security corpus: OWASP-rule-pass-rate.

### ⚪ Three-arm A/B harness

`prime eval --arms prime,skill,raw` runs the same task three times — once
with the corpus mounted via Skill Wiki, once with bulk-loaded SKILL.md, once
with no skill — and reports the deltas. Lets corpus authors prove the
protocol pays its keep.

### ⚪ Citation-precision metric

Of the atoms `prime_query` returned, how many appeared in the agent's final
output? A high-precision corpus is one whose retrieval is well-calibrated;
a low-precision corpus is over-fetching or under-using.

**Moonshot:** a public Prime leaderboard. Corpora register; the harness runs
a fixed task suite weekly; results are published with version pinning. Same
spirit as [HumanEval](https://github.com/openai/human-eval) for code.

References:
[MCP-Bench](https://arxiv.org/abs/2508.20453) ·
[Inspect AI](https://inspect.aisi.org.uk/)

---

## Prime optimization `[planned · 2027]`

The v0.1 retrieval path is naïve: load `_index.xml`, rank, fetch projections.
That's fine at 1k atoms. At 10k it's wasteful; at 100k it stops fitting in
context at all. v0.3+ tightens the loop.

### 🔵 Per-intent edge-graph pruning

At query time, walk the edge graph from the seed atoms outward up to
`max_depth`, *but* prune branches whose verb mix doesn't match the intent
(e.g., for a "implementation" intent, drop `tradeoff` and `provocation`
edges). Smaller candidate set, same recall on the relevant kinds.

### 🔵 Projection compressor (`--compress` flag)

A LLMLingua-style compressor applied to `core` and `full` projections at
serve time, selectable per query. Trades a small amount of fidelity for
~2× tokens saved.

### 🔵 Atom-result cache

Content-addressed cache keyed by `(intent_hash, kinds, max_atoms)`. Same
query inside a session = zero retrieval cost. Invalidates on corpus
recompile.

### ⚪ Multi-Prime composition budget

When multiple corpora are mounted (per the v0.3 multi-corpus MCP), the
runtime allocates a token budget across them based on per-corpus intent
score, instead of fixed per-corpus quotas.

### ⚪ Compile-time projection profiles

Compile a corpus *N* times, once per intent class (e.g., "design",
"implementation", "review"), producing per-class `core` projections that
emphasise different fields. Runtime picks the profile based on intent.

**Moonshot:** [KVzip](https://arxiv.org/abs/2505.23416)-style key-value
memory per atom. Cache the decoder KV state for each `core` projection at
compile time; on retrieval, splice it in instead of re-encoding. Removes
the per-turn re-encoding cost entirely.

References:
[LLMLingua](https://github.com/microsoft/LLMLingua) ·
[KVzip](https://arxiv.org/abs/2505.23416)

---

## Top 5 v0.2 ships

If we ship nothing else in v0.2, these five carry the release:

1. **`prime eval` CLI** — the harness that makes every other claim measurable.
2. **Telemetry ingest + atom-proposal bot** — closes the corpus-staleness loop.
3. **Atom-diff viewer** — required for users to trust corpus version bumps.
4. **Per-intent edge-graph pruning** — the first retrieval optimisation that
   pays for itself on day one.
5. **Citation-precision metric** — the single number that tells a corpus author
   whether their atoms are pulling their weight.

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
