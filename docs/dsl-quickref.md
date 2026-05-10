# DSL Quick Reference

> The `.prime` source language: lexical structure, atom declarations,
> 28 kinds, 14 edge verbs. Worked examples from `examples/recipes/`,
> `examples/coding-style/`, a security-domain illustration, and one
> annotated frontend-domain example (clearly marked).

[← back to README](../README.md) · [Architecture](./architecture.md) · [Philosophy](./philosophy.md) · [Getting started](./getting-started.md)

---

## Lexical structure

A `.prime` source file is UTF-8 text containing exactly one atom
declaration.

| Lexical element | Form | Example |
|---|---|---|
| Whitespace | spaces, tabs, newlines | not significant inside fields |
| Line comment | `// to end of line` | `// authored 2026-04-15` |
| Block comment | `/* ... */` | spans multiple lines |
| Identifier | `[a-zA-Z_][a-zA-Z0-9_-]*` | `displayFont`, `must-include` |
| Hyphen-keyword field | `kebab-name:` | `applies-to:`, `validates-with:` |
| String literal | `"..."` | `"Pure water boils at 100°C"` |
| Triple-quoted block | `"""..."""` | preserves newlines and indentation |
| Pipe-quoted block | `\|`-prefixed lines | line-oriented multi-line value |
| Reference literal | `@scope/atom-id` | `@community/fact-spacing-token-progression` |
| Number | `123`, `0.99`, `1.5em`, `4 px` | numeric or unit-suffixed |
| Boolean | `true`, `false` | |
| Range | `0.0-1.0`, `100–300ms` | inclusive low–high |
| Array | `[...]` with comma or newline separators | `[a, b, c]` |
| Object | `{ key: value, ... }` | nested any depth |
| Union type | `"low" \| "med" \| "high"` | |
| Enum value | `strong`, `medium`, `severe` | bare identifier in value position |
| Function signature | `(input: Type) -> Output` | for `method` body specs |

The parser implements **error recovery**: a syntax error in one field
doesn't stop the parse. It skips to the next `key:` and continues,
collecting all errors for the diagnostic.

---

## Atom declaration shape

Every atom file declares one atom. The general shape:

```
<kind> <PascalCaseName> {
  id:          "@<scope>/<kebab-name>"
  version:     "<semver>"
  description: "..."

  // kind-specific fields ...

  related:     [@scope/atom, @scope/another, ...]

  // for persona / high-level pattern only:
  composition: { must-include: [...], must-avoid: [...], ... }
}
```

Three rules the parser enforces:

1. The `kind` keyword must match one of the 28 keywords.
2. The `id:` must be `@<scope>/<kebab-name>` and unique across the corpus.
3. Each kind has its own required fields. The parser fails early if any
   are missing.

The `<PascalCaseName>` is for human readability and editor lookup. The
`id:` is the canonical reference.

---

## The 28 atom kinds

Each kind belongs to one of five layers. The mandatory body field varies
by kind.

### Data layer — what's true / what things are

| Kind | One-line use | Mandatory body field |
|---|---|---|
| `fact` | An empirical claim with confidence + source | `statement` |
| `term` | Definition of a concept | `definition` |
| `value` | A named, typed value (numeric, boolean, or any scalar — e.g. a threshold, a timeout, a flag) | `value` |
| `category` | A taxonomy category | `members` or `criteria` |
| `example` | A positive exemplar | `description` + reference / artifact |
| `counter-example` | An anti-exemplar of what NOT to do | `description` + the thing it negates |
| `source` | A citable reference (paper, spec, guideline) | `citation` |
| `metric` | A measurable threshold or benchmark | `threshold` or `range` |

### Behavior layer — what can be done

| Kind | One-line use | Mandatory body field |
|---|---|---|
| `step` | One discrete action in a sequence | `action` |
| `check` | A pass/fail assertion on an artifact | `assertion` |
| `transform` | A mapping from one form to another | `from` + `to` |
| `tool` | A named software tool or API | `name` + `interface` |
| `method` | A multi-step procedure with inputs/outputs | `body` (steps) |

### Composition layer — how to assemble things

| Kind | One-line use | Mandatory body field |
|---|---|---|
| `rule` | A prescriptive constraint ("always X" / "never Y") | `claim` + `applies-to` |
| `taxonomy` | A classification hierarchy | `members` |
| `pattern` | A reusable design pattern with variants | `problem` + `solution` |
| `anti-pattern` | A pattern to actively avoid | `problem` + `failure-mode` |
| `type` | A structural type definition | `shape` |

### Style / Param layer — voice + aesthetic

| Kind | One-line use | Mandatory body field |
|---|---|---|
| `persona` | A coherent posture / point-of-view atom — a named perspective that other atoms reference for stylistic or methodological alignment. Examples: a design `persona` ("stripe-clean"), a security `persona` ("threat-modeller"), a culinary `persona` ("classical-french"). | `implies` + `composition` |
| `voice` | A writing register or tone contract | `register` + `prohibitions` |
| `constraint` | A hard limit that cannot be overridden | `target` + `severity` |
| `template` | A reusable template — markup, document structure, procedure, recipe. Domain determines the content type. | `template` (the body) |
| `provocation` | A deliberate disruption to orthodoxy | `claim` + `reasoning` |

### Meta layer — knowledge organization

| Kind | One-line use | Mandatory body field |
|---|---|---|
| `collection` | A publishable bundle of atoms (maps to a Skill) | `includes` |
| `scope` | Defines a named namespace boundary | `name` + `members` |
| `tradeoff` | Explicit tension between two valid positions | `position-a` + `position-b` |
| `principle` | A high-level heuristic (not directly actionable) | `claim` |
| `feedback` | Retrospective observation about prior decisions | `observation` |

---

## The 14 edge verbs

![Atom data model — kinds and edges](./assets/atom-data-model.png)

Edges declare typed relationships between atoms. The parser knows each
verb's semantics; the L3 checker reasons over them.

| Verb | Semantic | Allowed source kinds | Allowed target kinds | Example |
|---|---|---|---|---|
| `related` | General association — discoverable | any | any | `pattern → fact` |
| `requires` | Strong dependency — A loaded ⇒ B MUST load | `method`, `pattern`, `persona`, `rule` | any | `method → step` |
| `enhances` | Soft dependency — B improves A but is optional | any | any | `persona → voice` |
| `validates-with` | A's correctness verified against B | `rule`, `fact`, `pattern` | `source`, `metric`, `check` | `rule → source` |
| `supplies-to` | A provides values consumed by B | `template`, `value` | `persona`, `pattern` | `template → persona` |
| `specializes` | A is a narrower subtype of B | any | same kind as A | `persona → persona` |
| `extends` | A inherits all fields of B and overrides specified | any | same kind as A | `persona → persona` |
| `derived-from` | Non-inheriting derivative | any | any | `rule → source` |
| `compatible` | Can be composed without conflict | `persona`, `pattern` | `persona`, `pattern` | `persona → persona` |
| `conflicts` | Mutual exclusion — never load both | `persona`, `pattern` | `persona`, `pattern` | `persona → persona` |
| `contradicts` | A and B make semantically opposing claims (L3 flag) | `fact`, `rule` | `fact`, `rule` | `rule → fact` |
| `see-also` | Informational cross-reference | any | any | `fact → fact` |
| `includes` | Collection lists members | `collection` | any | `collection → method` |
| `relationships` | Generic catch-all (legacy) | any | any | — |

The "allowed source/target kinds" column is enforced by the parser only
where it makes sense — `includes` only on `collection`, for instance.
Other verbs accept any kind pair. The validator may surface domain-specific
warnings via plugin heuristics.

### Choosing the right verb

```
Is loading A obligatory if I load X?    → requires
Is loading A nice-to-have with X?       → enhances
Should A and X never load together?     → conflicts
Do A and X make opposing claims?        → contradicts
Is X verified by A?                      → validates-with
Is A a narrower form of X?              → specializes
Did A inherit fields from X?             → extends
Is A a non-inheriting variant of X?     → derived-from
Did A produce values for X?              → supplies-to
Are A and X explicitly composable?      → compatible
Does X just see also A (for browsing)?  → see-also
None of the above, just association?    → related
```

---

## Six worked examples

Examples 1–4 use cooking, team coding standards, and security to show the DSL
across different domains. Examples 5–6 use the frontend-design domain
(clearly marked as such).

### Example 1 — `fact`

From `examples/recipes/` (shipped in this repo):

```prime
fact MeatRestingJuices {
  id: "@recipes/fact-meat-resting-juices"
  version: "1.0.0"

  description: "Resting meat after cooking allows myoglobin-bound juices to redistribute."

  statement: "Resting meat 5-10 minutes after removing from heat lets muscle fibres relax, allowing juices to redistribute and raising serving moisture by ~10% vs cutting immediately."

  confidence: 0.92
  source: [
    "McGee, H. 'On Food and Cooking' (2004), Ch. 3.",
    "America's Test Kitchen internal moisture-loss tests.",
  ]

  applies-to: [
    "beef steaks and roasts",
    "pork tenderloin and chops",
    "poultry breast and thigh",
  ]

  quantitative: {
    rest-time-range: "5-10 min",
    moisture-gain: "~10% vs immediate cut",
  }

  related: [
    @recipes/term-myoglobin,
    @recipes/rule-carry-over-cooking,
  ]
}
```

What each field does:
- `statement` — the central claim, surfaced at every projection level
- `confidence` — `strong`, `med`, `weak`, or numeric `0.0-1.0`
- `source` — citations; if these are atoms, use `validates-with` instead
- `applies-to` — bounds the claim's scope
- `quantitative` — structured numerics for downstream validators
- `related` — discoverable association

### Example 2 — `rule`

From `examples/coding-style/` (shipped in this repo):

```prime
rule NoImplicitAny {
  id: "@team/rule-no-implicit-any"
  version: "1.0.0"

  applies-to: ["TypeScript source files in this repository"]

  description: "All TypeScript declarations must have explicit type annotations..."
  claim: "No variable, parameter, or return type may rely on TypeScript's implicit `any` inference. All public API boundaries must carry explicit types."
  severity: high

  validates-with: [@team/source-typescript-strict-mode-docs]
  checks: [@team/check-no-implicit-any-tsconfig]

  remediation: [
    "Enable `noImplicitAny: true` in `tsconfig.json`.",
    "Run `tsc --noEmit` in CI; fail on error count > 0.",
  ]

  exceptions: [
    {
      case: "Third-party type stubs",
      allowed-when: "An external package ships no `.d.ts` and a community `@types/` package does not exist.",
    }
  ]

  related: [@team/rule-strict-null-checks, @team/anti-pattern-type-assertion-abuse]
}
```

What each field does:
- `claim` — the prescription; exact and machine-greppable
- `severity` — `low` / `medium` / `high` / `critical`
- `applies-to` — scopes the rule to a specific artifact class
- `validates-with` — sources backing the claim
- `checks` — link to executable check atoms
- `remediation` / `exceptions` — actionable detail at the full projection level

### Example 3 — `pattern`

A security-corpus example showing a problem/solution pair with typed edges:

```prime
pattern ParameterisedQuery {
  id: "@security/pattern-parameterised-query"
  version: "1.0.0"

  domain: security

  problem: "Interpolating user input directly into SQL strings allows attackers to inject arbitrary SQL, bypassing auth checks or exfiltrating data (OWASP A03: Injection)."
  solution: "Always separate query structure from data by using parameterised statements (prepared statements). The database driver handles quoting and escaping; the developer's code never builds query strings by concatenation."

  structure: """
    // Unsafe:
    db.query(`SELECT * FROM users WHERE id = ${userId}`);

    // Safe (parameterised):
    db.query("SELECT * FROM users WHERE id = ?", [userId]);
  """

  behavior: [
    "Treat ALL user-supplied values as parameters, not query fragments.",
    "Use ORM query builders that enforce parameterisation by default.",
  ]

  examples: [
    @security/example-node-mysql2-prepared,
    @security/example-python-psycopg2-execute,
  ]

  compatible: [@security/pattern-input-validation]
  requires: [@security/check-no-string-concat-in-queries]
  validates-with: [@security/source-owasp-a03-injection]
  related: [@security/anti-pattern-dynamic-query-concat]
}
```

What each field does:
- `problem` / `solution` — the canonical pattern pair
- `structure` — triple-quoted to preserve code verbatim
- `behavior` — actionable list at the full projection level
- `examples` — concrete instances the agent can read
- `compatible` / `requires` / `validates-with` / `related` — typed edges

### Example 4 — `persona`

A security-corpus `persona`:

```prime
persona ThreatModeller {
  id: "@security/persona-threat-modeller"
  version: "1.0.0"

  description: "The attacker's lens: assume breach, enumerate attack surfaces, prioritise exploitability over likelihood."

  implies: {
    stance: "adversarial — ask 'how would I break this?' before 'does this work?'"
    scope: "network boundary, authentication, data flows, external dependencies"
    output-format: "STRIDE table + ranked risk register"
  }

  compatible: ["red-team", "penetration-tester"]
  conflicts: ["optimist", "happy-path-tester"]

  composition: {
    must-include: [
      @security/taxonomy-stride,
      @security/check-attack-surface-enumerated,
      @security/principle-defence-in-depth,
    ]
    must-avoid: [
      @security/persona-optimist,
    ]
  }

  related: [@security/method-threat-model-review, @security/taxonomy-owasp-top10]
}
```

What each field does:
- `implies` — domain-specific structured contract; content is corpus-defined (not fixed by protocol)
- `compatible` / `conflicts` — composition relationships
- `composition.must-include` / `must-avoid` — universal protocol contract clauses enforced by L3
- The `typography-required` / `color-required` / `motion-prescriptions` sub-fields seen in the **frontend corpus** are frontend-domain extensions, not part of the protocol — see [`spec/FRONTEND-DESIGN-DOMAIN-v1.md §3`](../spec/FRONTEND-DESIGN-DOMAIN-v1.md)

### Example 5 — `method`

From `examples/recipes/` (shipped in this repo):

```prime
method MakePanSauce {
  id: "@recipes/method-make-pan-sauce"
  version: "1.0.0"

  input:  { pan: "skillet with fond", liquid: "wine | stock | both", serving: number }
  output: { sauce: "deglaised reduction, ~2 tbsp per serving" }

  domain: cooking

  description: "A classic pan sauce that lifts fond from a sear and reduces to a glossy coating."

  uses: [
    @recipes/step-deglaze-pan,
    @recipes/step-reduce-liquid,
    @recipes/step-mount-butter,
  ]

  body: [
    @recipes/step-deglaze-pan(pan, liquid) -> deglaised
    @recipes/step-reduce-liquid(deglaised, target: "50%") -> reduced
    if serving > 2:
      increase liquid proportionally
    @recipes/step-mount-butter(reduced) -> finished
  ]

  success-criteria: [@recipes/check-sauce-coats-spoon]

  related: [@recipes/fact-maillard-reaction, @recipes/term-fond, @recipes/method-make-stock]
}
```

What each field does:
- `input` / `output` — typed I/O contract for the method
- `uses` — references to step atoms — typed dependency
- `body` — pseudo-code mixing typed step calls with control flow
- `success-criteria` — check atoms validating the method ran correctly

### Example 6 — `constraint`

*(This example is from the frontend-design corpus — the `constraint` kind
works identically in any domain; the specific sub-fields below are
frontend-specific.)*

```prime
constraint OklchOnlyColor {
  id: "@community/constraint-oklch-only-color"
  version: "1.0.0"

  // Example (frontend domain): the 'target' and 'values' fields
  // are generic; the specific CSS syntax below is domain content.
  target: ["color values in author CSS", "design-token primitives"]
  severity: high
  domain: visual-design

  description: "All new color declarations must use the oklch() color function..."

  values: [
    {
      forbidden: "#rrggbb / #rgb hex literals",
      reason: "non-perceptual sRGB encoding",
    }
    {
      required: "oklch(L C H [/ A])",
    }
  ]

  rationale: "OKLCH is perceptually uniform: equal numerical changes in L produce equal perceived lightness changes across all hues."

  exceptions: [
    "Vendor / third-party CSS shipped by external libraries.",
  ]

  enforcement: "Stylelint plugin: `color-no-hex`, `color-named: never`."

  related: [
    @community/check-color-oklch-required,
    @community/transform-rgb-to-oklch,
    @community/term-oklch,
  ]
}
```

What each field does:
- `target` — what code/artifact/system the constraint applies to
- `severity` — `low` / `medium` / `high` / `critical` (constraint vs
  rule: constraints are non-overrideable; rules can have exceptions)
- `values` — structured list with `forbidden` / `required` / `allowed`
- `rationale` — explains the constraint; surfaced at full projection
- `enforcement` — how the constraint is mechanically checked

---

## Composition contract syntax

Any atom can declare a composition contract. The **protocol defines two
universal fields** — `must-include` and `must-avoid`. Domain corpora may
add typed sub-fields via their `domain.yaml`'s `contract:` block; these
sub-fields are domain-specific and not part of the protocol.

**Protocol-level (any domain):**

```prime
composition: {
  must-include: [@scope/atom-id, ...]   // must be loaded when this atom is active
  must-avoid:   [@scope/atom-id, ...]   // must NOT be loaded when this atom is active
}
```

**Frontend-domain extensions** (in `prime-corpus-frontend-design`; not
protocol — documented in
[`spec/FRONTEND-DESIGN-DOMAIN-v1.md §3`](../spec/FRONTEND-DESIGN-DOMAIN-v1.md)):

```prime
composition: {
  must-include: [...]
  must-avoid:   [...]

  // Frontend-domain sub-fields (corpus-specific, not protocol):
  typography-required: { display: "font name | alternative", body: "font name" }
  color-required: { background: "#f8f6f1", accent: "#a4451c" }
  motion-prescriptions: "subtle, purposeful; max 200ms for transitions"
}
```

**Protocol-level contract enforcement:**

| Field | Enforced at | What happens on violation |
|---|---|---|
| `must-include` | L3 (compile) + L5 (output validate) | Compile fails if target missing; output fails if not reflected |
| `must-avoid` | L3 (compile) + L5 (output validate) | Compile fails if both selected; output fails if avoided atom appears |
| Domain-specific sub-fields | L5 only (domain validator) | Domain wrapper validates output against its own sub-field schema |

---

## Field types in the DSL

| Type | Form | Notes |
|---|---|---|
| String | `"..."` | Unicode; standard escapes |
| Triple-quoted | `"""..."""` | Preserves newlines + indentation |
| Pipe-quoted | leading `|` per line | Line-oriented |
| Number | `42`, `0.99`, `200ms`, `4px` | Unit suffix preserved as part of value |
| Boolean | `true`, `false` | |
| Range | `0-1`, `100–300ms` | Em-dash or hyphen |
| Array | `[a, b, c]` | Trailing comma OK |
| Object | `{ k: v, ... }` | Nested any depth |
| Reference | `@scope/atom-id` | Verified at L1 |
| Union | `"a" \| "b" \| "c"` | String union; opaque to parser today |
| Function sig | `(input: T) -> Output` | Body specs only |
| Enum value | bare `strong`, `medium`, `high` | identifiers in value position |

---

## Extending {#extending}

The 28 kinds and 14 verbs are fixed in the parser today. Adding either
takes a small parser-level patch and a Tier-2 RFC review.

### Add a new atom kind

Path through the codebase:

1. **Type** — add the kind name to `packages/types/src/ast.ts`:
   ```ts
   export type AtomKind =
     | "fact" | "rule" | "method" | …
     | "your-new-kind";
   ```

2. **Lexer** — register the keyword in `packages/parser/src/lexer.ts`.

3. **Parser** — register the schema in `packages/parser/src/parser.ts`.
   If your kind shares shape with an existing one (e.g. `fact`'s
   `statement` + tags), reuse the handler; otherwise add a parser branch
   and declare required fields.

4. **Chunker** — add a case in `packages/compiler/src/chunker.ts` so
   `summary` / `core` / `full` projections produce the right slices.

5. **Fixture** — one example atom under `examples/<corpus>/` that
   exercises the new kind. Must parse and compile clean.

6. **Tests** — parser test in `packages/parser/test/` and chunker test
   in `packages/compiler/test/`.

7. **Governance** — open a Tier-2 RFC per [community/governance](./community/governance.md)
   describing why the kind is needed, what's already close, and the
   test coverage you added.

Total diff is usually 30–80 lines plus tests. Review focuses on whether
the new kind is genuinely novel vs reusable as one of the existing 28.

### Add a new edge verb

Smaller surface than a kind:

1. `packages/types/src/ast.ts` — add to the `EdgeVerb` union
2. `packages/parser/src/parser.ts` — register in the relations parser
3. `packages/compiler/src/edge-resolver.ts` — declare semantics
   (forward / backward, required vs optional)
4. Tests + RFC

### Roadmap: YAML-declared custom kinds

A `custom-kinds:` block in `domain.yaml` will let a corpus declare new
kinds without patching the parser. Plan in [community/roadmap](./community/roadmap.md).

---

## Where to go next

- [Architecture](./architecture.md) — how the pipeline turns these atoms into agent context
- [Philosophy](./philosophy.md) — why this DSL has these primitives
- [Corpus authoring](./corpus-authoring.md) — writing your own corpus end-to-end
- [Protocol Spec §1](../spec/PRIME-PROTOCOL-v1.md) — the formal grammar

---

*DSL quick reference v1.0 — covers the v1 frozen grammar. Future verbs
or kinds will be additions, not changes.*
