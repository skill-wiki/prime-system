---
name: prime-decompose
description: Convert a markdown protocol document (a SKILL.md, design-system spec, team rulebook, etc.) into a set of typed `.prime` source atoms for the Prime knowledge corpus. Trigger when the user asks to "decompose", "atomize", "convert to prime", or "extract atoms from" any markdown document.
---

# prime-decompose

You ingest one markdown document and emit a candidate set of `.prime` atoms.
You are an authoring assistant; the human reviews + edits before merging.

## Inputs

- One source path (a `.md` file, a directory of `.md`, or pasted markdown text).
- One target scope (e.g. `@my`, `@team-foo`). Default `@my`.
- One target directory for output (default `./out-prime/`).

If any input is missing, ask once, then proceed with defaults.

## Workflow

### 1 · Read the source

Use the Read tool. If it's a directory, list it; pick the most knowledge-dense
file first (largest non-index `.md` is a good proxy).

### 2 · Identify atom candidates

Walk the document section by section. Tag each load-bearing claim with one of
the **28 atom kinds** (see `reference/atom-kinds.md`). Be aggressive — it is
better to over-extract and merge than to under-extract.

Default mappings as you read:

| You see | Likely atom kind |
|---|---|
| "Always X" / "Never Y" / "MUST" / "MUST NOT" | `rule` |
| Numeric / dimensional value, named constant | `value` |
| Empirical claim with a citation | `fact` |
| "Avoid …" with a reason | `anti-pattern` |
| "Use …" reusable structural template | `pattern` or `template` |
| Definition of a term | `term` |
| A pass/fail assertion against an artifact | `check` |
| A measurable threshold | `metric` |
| A multi-step procedure with inputs/outputs | `method` |
| A named bundle of style choices (design lineages, writing voices, brand systems) | `persona` |
| A writing-tone contract | `voice` |
| A high-level heuristic that is NOT directly actionable | `principle` |
| An explicit tension between two valid positions | `tradeoff` |
| Citable spec or paper | `source` |

Rules of thumb:
- If a claim is **directly actionable + binary pass/fail**, it is a `rule`, not a `principle`.
- If you have a `rule`, you also need a `check` that validates it — emit both.
- If you have a `value` (e.g. "44px touch target"), you also need a `rule` that consumes it.
- Personas/voices come last — they bundle other atoms via `composition:`.

### 3 · Emit `.prime` files

For each candidate, write `<target>/<kind>-<kebab-name>.prime`. Use the DSL grammar in
`reference/dsl-syntax.md`. Required fields per atom:

```
<kind> <PascalName> {
  id: "@<scope>/<kebab-name>"
  version: "1.0.0"
  description: "..."

  // kind-specific fields — see reference/atom-kinds.md

  related: [..., ..., ...]   // ≥ 3 entries
  // ≥ 1 of: extends / derived-from / requires / enhances / specializes
}
```

### 4 · Cross-link via edges

After all atoms are drafted, do a **second pass for edges**. For each new
atom:

- Add **at least 3 `related:`** edges to discoverable peers (other atoms you
  just wrote, or atoms in the existing corpus if known).
- Add **at least 1 of**: `extends`, `derived-from`, `requires`, `enhances`,
  `specializes`. Use the "use when" guidance in `reference/verb-cheatsheet.md`.

If the source document cites WCAG, OWASP, Nielsen, etc., add a
`derived-from: @w3c/...` or `derived-from: @nielsen/...` edge. Do not invent
atom IDs you don't know exist; if unsure, omit and note it.

### 5 · Validate

Run the validator script:

```
bun run release/skills/prime-decompose/scripts/validate-output.ts <target-dir>
```

It will print parse errors and edge counts. Fix any errors before reporting back.

### 6 · Report

Print:
- Count by kind (e.g. "12 rules, 8 facts, 3 anti-patterns, ...")
- The full path of each emitted file
- Any source claims you could **not** atomize, with reason
- Any external atom IDs you cited but couldn't verify exist

## Concrete example

**Input** (one line of source markdown):
> "Use a 4-pixel base spacing grid; multiples of 4 only."

**Output** (3 atoms):

`value-spacing-base.prime`:
```
value SpacingBase {
  id: "@my/value-spacing-base"
  version: "1.0.0"
  name: "spacing-base"
  constant: "4px"
  type: css-length
  domain: frontend-design
  rationale: "4px base unit yields the 8-point scale (4, 8, 12, 16, 24, 32, 48, 64, 96, 128) which aligns with iOS/macOS conventions and is finely-divisible enough for dense UI."
  related: [
    @my/rule-spacing-rhythm,
    @my/principle-eight-point-grid,
    @community/rule-spacing-rhythm,
  ]
  supplies-to: [
    @my/rule-spacing-rhythm,
  ]
}
```

`rule-spacing-rhythm.prime`:
```
rule SpacingRhythm {
  id: "@my/rule-spacing-rhythm"
  version: "1.0.0"
  domain: frontend-design
  description: "All spacing values (margin, padding, gap) MUST be multiples of 4px drawn from the documented scale."
  claim: "Every spacing CSS value resolves to N×4px where N ∈ {1,2,3,4,6,8,12,16,24,32}."
  severity: medium
  validates-with: [
    @my/principle-eight-point-grid,
  ]
  related: [
    @my/value-spacing-base,
    @my/principle-eight-point-grid,
    @community/anti-pattern-cramped-ui,
  ]
  derived-from: @community/rule-spacing-rhythm
}
```

`principle-eight-point-grid.prime`:
```
principle EightPointGrid {
  id: "@my/principle-eight-point-grid"
  version: "1.0.0"
  domain: frontend-design
  statement: "A single base unit (4px) and its multiples create visual rhythm without requiring per-component spacing decisions."
  rationale: "Constraining the spacing space to a discrete scale removes a class of decisions and makes drift visible. Industry baseline since iOS/macOS adopted 8pt; Tailwind, Material, and Apple HIG all share this premise."
  related: [
    @my/value-spacing-base,
    @my/rule-spacing-rhythm,
    @community/principle-vertical-rhythm,
  ]
}
```

Notice:
- Three atoms, three different kinds (value · rule · principle).
- Each has ≥ 3 `related:` edges.
- Two have a non-`related` verb (`supplies-to`, `derived-from`).
- The `value` is consumed by the `rule` via `supplies-to` ↔ targets back.
- The `principle` is the high-level heuristic — not directly actionable.

## Hard rules

- Never paraphrase atom kinds — use the 28 listed in `reference/atom-kinds.md`.
- Never invent atom IDs in edges. If you cite an external atom, you must know it exists.
- Never emit an atom with fewer than 3 `related:` edges.
- Never emit an atom without exactly one of {`extends`, `derived-from`, `requires`, `enhances`, `specializes`}.
- Never run the Prime MCP server. This skill is self-contained markdown + Read/Write/Bash.
