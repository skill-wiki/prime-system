# Prime Protocol — v1.0

> The protocol layer for AI knowledge: typed atoms, edge graph, projection levels, composition contracts, corpus registry.

**Status**: Stable — v1.0, frozen 2026-05-09.
**Domains**: pluggable via `domain.yaml` — zero built-in domains ship with the protocol.

> **Read this file first.** If you are building a domain-specific wrapper (e.g. a frontend-design MCP, a security-policy advisor, or a legal-clause corpus), start here to understand the protocol, then read
> [`spec/FRONTEND-DESIGN-DOMAIN-v1.md`](./FRONTEND-DESIGN-DOMAIN-v1.md) for the bundled frontend-design reference implementation.
> See also [`spec/DOMAIN-EXTENSION-SPEC.md`](./DOMAIN-EXTENSION-SPEC.md) for the `domain.yaml` schema that lets any corpus extend the protocol.

---

## §1 · Atom DSL Grammar

### Atom declaration

```
<kind> <PascalName> {
  id: "@<scope>/<kebab-name>"
  version: "<semver>"
  description: "..."

  // kind-specific fields (see §1.2) ...

  related: [@scope/atom, ...]
  composition: {
    must-include: [@scope/atom, ...]
    must-avoid:   [@scope/atom, ...]
    // Domain-specific sub-fields (e.g. typography-required, motion-prescriptions)
    // are defined by the domain's corpus atoms and parsed by domain tooling.
    // They are NOT part of the protocol.
  }
}
```

**`composition:`** is available to any atom kind — not just `persona` or `pattern`. The protocol defines `must-include` and `must-avoid` as universal fields. Domains add typed sub-fields via their `domain.yaml`'s `contract:` block (see DOMAIN-EXTENSION-SPEC §3).

### §1.1 · Supported field types

| Type syntax | Example |
|---|---|
| String literal | `"Fraunces"` |
| Quoted block (`\|`) | multi-line string, preserves newlines |
| Triple-quoted string | `"""..."""` |
| Array | `["a", "b", "c"]` |
| Hyphen-keyword field | `font-display: "..."` |
| Function signature | `(input: AtomList) -> CompositionResult` |
| Union type | `"low" \| "med" \| "high"` |
| Range expression | `0.0-1.0` |
| Raw expression (catch-all) | any value that doesn't match above forms |

Parser: `packages/parser/src/{lexer,parser,errors}.ts`. 62 parser tests pass on `node --experimental-transform-types`.

### §1.2 · 28 atom kinds (5 layers)

**Data layer** — what is true / what things are:
- `fact` — empirical claim with confidence + source
- `term` — definition of a concept
- `value` — a named, typed value (numeric, boolean, or any scalar)
- `category` — a taxonomy category
- `example` — a positive exemplar
- `counter-example` — an anti-exemplar showing what NOT to do
- `source` — a citable reference (paper, spec, guideline)
- `metric` — a measurable threshold or benchmark

**Behavior layer** — what can be done:
- `step` — a discrete action in a sequence
- `check` — a pass/fail assertion on an artifact
- `transform` — a mapping from one form to another
- `tool` — a named software tool or API
- `method` — a multi-step procedure with inputs/outputs

**Composition layer** — how to assemble things:
- `rule` — a prescriptive constraint ("always X", "never Y")
- `taxonomy` — a classification hierarchy
- `pattern` — a reusable structural pattern with variants
- `anti-pattern` — a pattern to actively avoid
- `type` — a structural type definition

**Style / Param layer** — posture and voice parameters:
- `persona` — a coherent posture / point-of-view atom: a named perspective that other atoms reference for stylistic or methodological alignment. Examples: a design `persona` ("stripe-clean"), a security `persona` ("threat-modeller"), a culinary `persona` ("classical-french").
- `voice` — a writing register or tone contract
- `constraint` — a hard limit that cannot be overridden
- `template` — a reusable template (markup, document, procedure, recipe — domain determines content)
- `provocation` — a deliberate disruption to orthodoxy

**Meta layer** — knowledge organization:
- `collection` — a publishable bundle of atoms (maps to a Skill)
- `scope` — defines a named namespace boundary
- `tradeoff` — an explicit tension between two valid positions
- `principle` — a high-level heuristic (not directly actionable)
- `feedback` — a retrospective observation about prior decisions

---

## §2 · Edge Verbs

Edges are declared in the atom DSL and compiled into `graph.yaml` per atom. The `related:` field is the primary edge declaration site; additional verbs appear in kind-specific fields.

| Verb | Semantic | Example |
|---|---|---|
| `related` | General association — discoverable via graph traversal | `@recipes/method-make-pan-sauce related @recipes/fact-maillard-reaction` |
| `compatible` | Can be composed without conflict | `@security/persona-threat-modeller compatible @security/persona-red-team` |
| `conflicts` | Mutual exclusion — compositor MUST NOT load both | `@security/persona-threat-modeller conflicts @security/persona-optimist` |
| `see-also` | Informational cross-reference (no semantic constraint) | `@example/fact-water-boils-at-100c see-also @example/rule-altitude-affects-boiling` |
| `extends` | Inherits all fields of target, overrides specified | `@team/rule-strict-null-checks extends @team/rule-no-implicit-any` |
| `derived-from` | Non-inheriting derivative | `@team/rule-no-implicit-any derived-from @team/source-typescript-strict-docs` |
| `requires` | Strong dependency — if A is loaded, B MUST also load | `@recipes/method-make-pan-sauce requires @recipes/step-deglaze-pan` |
| `enhances` | Soft dependency — B improves A but is not required | `@security/persona-threat-modeller enhances @security/taxonomy-owasp-top10` |
| `validates-with` | A's correctness is verified against B | `@security/pattern-parameterised-query validates-with @security/source-owasp-a03-injection` |
| `supplies-to` | A provides values consumed by B | `@recipes/fact-maillard-reaction supplies-to @recipes/method-sear-steak` |
| `specializes` | A is a narrower subtype of B | `@security/rule-sql-injection-prevention specializes @security/rule-injection-prevention` |
| `contradicts` | A and B make semantically opposing claims (L3 flag) | `@team/rule-no-implicit-any contradicts @community/fact-typescript-infers-safely` |
| `relationships` | Generic catch-all (used in source atoms) | — |
| `includes` | Collection atom lists its member atoms | `@example/collection-tea-basics includes [@example/fact-water-boils-at-100c, ...]` |

---

## §3 · Composition Contract (Protocol-Level)

The protocol defines two universal composition-contract fields:

```
<kind> SomeName {
  ...
  composition: {
    must-include: [@scope/atom-a, @scope/atom-b]
    must-avoid:   [@scope/atom-c]
  }
}
```

- `must-include` — atoms that MUST appear in the agent's loaded atom set when this atom is selected.
- `must-avoid` — atoms that MUST NOT appear (conflicting constraints / aesthetic exclusions).

**L3 contract check** (`packages/validator-core/`, not shipped in v0.1.0): verifies `must-include` atoms were loaded and no `must-avoid` atoms were loaded before agent generation begins. The contract is enforced by the retriever but there is no standalone validator runner in v0.1.0.

Domain wrappers may define additional typed sub-fields (e.g. `typography-required`, `color-required`, `motion-prescriptions` in the frontend-design domain). These sub-fields are parsed by domain-specific tooling and live in the corpus atoms — not in the system-repo `AtomMeta` type. See [`FRONTEND-DESIGN-DOMAIN-v1.md`](./FRONTEND-DESIGN-DOMAIN-v1.md) §3 for the frontend domain's extended contract schema.

---

## §4 · Retrieval — `prime_query`

The protocol exposes **one MCP tool**: `prime_query`. Domain wrappers MAY ship additional tools on top; the bundled frontend-design wrapper ships five (documented in [`FRONTEND-DESIGN-DOMAIN-v1.md`](./FRONTEND-DESIGN-DOMAIN-v1.md) §5).

### `prime_query`

```
Input:
  scope:  "atoms" | "related" | "show"
  query?: string          — keyword search (scope=atoms)
  id?:    string          — atom id (scope=related | show)
  level?: "summary" | "core" | "full"   — projection level (default: "core")
  kind?:  string          — optional kind filter
  limit?: number          — top-N (default 10)

Output:
  {
    results: Array<{
      id:          string,
      kind:        string,
      description: string,
      tokens:      number,
      level:       "summary" | "core" | "full",
      path:        string,     // agent reads this file — server never sends content
    }>,
    total_index_tokens: number,
  }
```

**Scoring**: keyword-match × quality.overall. No kind is privileged. Domain wrappers that need kind-priority reranking apply it in their own layer after receiving `prime_query` results. For corpus-wide kind boosts, set `PRIME_KIND_BOOSTS='{"rule":0.5,"check":0.4}'` (JSON map; default: empty — equal treatment for all 28 kinds).

**Axis retrieval** is a domain-level concept, not a protocol guarantee. Domains declare their axes in `domain.yaml`; the protocol provides the underlying keyword-match + edge-graph engine. See [`DOMAIN-EXTENSION-SPEC.md`](./DOMAIN-EXTENSION-SPEC.md) §2.

---

## §5 · Projection Levels (L1 / L3)

Each compiled atom is emitted at up to three projection levels:

| Level | Content | Typical token count |
|---|---|---|
| `summary` | id, kind, description, tags | ~50 |
| `core` | All fields except body/examples | ~200 |
| `full` | Complete atom including body and all computed fields | ~800 |

The **L2 projection** (LLM-assisted semantic enrichment) is optional. When `ANTHROPIC_API_KEY` or `DEEPSEEK_API_KEY` is set at compile time, the compiler runs an LLM pass to enrich summary descriptions and detect cross-atom semantic conflicts. When no key is present, L2 is skipped and the corpus still compiles cleanly at L1+L3.

---

## §6 · HTTP Registry Contract

The package registry (`packages/registry/`) serves atoms over HTTP.

| Route | Method | Description |
|---|---|---|
| `GET /atoms` | GET | List all atom IDs and metadata |
| `GET /atoms/:id.prime` | GET | Fetch raw `.prime` source for atom `:id` |
| `GET /health` | GET | Liveness check |

`prime install @scope/name --remote <url>` fetches missing atoms from this endpoint and writes them into the local sources directory.

---

## §7 · Domains — Plugin Architecture

Prime ships **zero built-in domains**. All domains are loaded from `domain.yaml` files discovered at corpus startup via `createConfigDrivenRegistry(rootDir)`.

Domain plugin interface: `packages/runtime/src/domain-plugin.ts`
Config-driven loader: `packages/runtime/src/domain-config.ts`

Full `domain.yaml` schema: [`spec/DOMAIN-EXTENSION-SPEC.md`](./DOMAIN-EXTENSION-SPEC.md).

Example `domain.yaml` for a cooking corpus:

```yaml
id: cooking
version: "0.1.0"
label: Culinary techniques and recipes
axes:
  - id: technique
    label: Cooking technique
    matches: [step, method, transform]
  - id: ingredient
    label: Ingredient knowledge
    matches: [fact, term, value]
```

---

## §8 · Validation Layers

Prime implements a layered validation pipeline:

**L1 — Parser schema validation** (`packages/compiler/src/checker-l1.ts`):
- Validates `.prime` DSL syntax against grammar
- Checks required fields per atom kind
- Resolves `@scope/id` references to confirm targets exist
- Detects duplicate IDs

**L2 — LLM-assisted semantic validation** (`packages/compiler/src/checker-l2.ts`) — opt-in:
- Per-atom consistency check: "Is this atom internally self-consistent?"
- Cross-atom conflict detection
- Skipped when no LLM API key is configured

**L3 — Cross-atom graph consistency** (`packages/compiler/src/checker-l3-cross.ts`):
- Detects circular dependencies in `requires:` graph
- Flags `contradicts:` edges pointing to active atoms
- Validates `must-include` targets exist in corpus

**L5 — Output validation** — domain-dependent:
- The protocol defines the layer slot; the validation logic is domain-specific
- The bundled frontend-design domain implements HTML structure + aesthetic alignment checks (documented in [`FRONTEND-DESIGN-DOMAIN-v1.md`](./FRONTEND-DESIGN-DOMAIN-v1.md) §8)
- A legal-document domain would validate PDF/Markdown structure; a security domain would validate policy coverage

Note: there is no "L4" in the naming convention. L1–L3 are compile-time; L5 is runtime output validation.

---

## §9 · Lifecycle / Versioning

Atoms carry a `version` semver field. Lifecycle states:

- `active` — current, fully supported
- `deprecated` — retained for compatibility; compiler MUST emit a warning when a `deprecated` atom appears in a retrieval result
- `experimental` — may change without notice; compiler MAY emit informational note

**v1 limitation**: the compiler does not currently enforce lifecycle checks at build time. Enforcement is planned for v1.1.

**Semver registry** (`prime install`): atoms are distributed as source files in the `<corpus>/primes/sources/` directory tree. Cross-team distribution via `prime install @scope/name --remote <url>`.

---

## §10 · Build + Runtime

```bash
# Compile a corpus
prime compile --src primes/sources --out primes/compiled

# Start the MCP server (one tool: prime_query)
PRIME_DIR=/abs/path/to/compiled \
  bunx @prime-lang/mcp-server-core
```

Runtime dependencies: Node 22+ (native TS strip) or Bun. No esbuild required.

---

*Protocol version: 1.0 · Updated: 2026-05-09*
