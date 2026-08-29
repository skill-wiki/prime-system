# Prime Frontend-Design Domain — v1.0

> The bundled frontend-design corpus's domain contract: 6-axis retrieval, composition sub-schema (typography / color / motion), IntentObject, HTML output validation, and the 5-tool MCP surface.

**Status**: Draft — reflects the `prime-corpus-frontend` reference implementation (899 atoms).

> **Prerequisite.** This document describes the frontend-design *domain wrapper* that layers on top of the universal Prime protocol. Read [`spec/PRIME-PROTOCOL-v1.md`](./PRIME-PROTOCOL-v1.md) first for the protocol primitives (28 atom kinds, 14 edge verbs, `prime_query`, composition contract, domain plugin architecture). Everything here is *on top of* that foundation.
>
> If you are building a non-frontend domain (security, legal, recipes, ML, …), this document is informational. Your domain defines its own axes in `domain.yaml` and its own `composition:` sub-fields in the corpus. See [`spec/DOMAIN-EXTENSION-SPEC.md`](./DOMAIN-EXTENSION-SPEC.md).

---

## §1 · Frontend-Design Domain Overview

The frontend-design corpus provides 899 atoms covering visual design, typography, color, layout, motion, and accessibility. It is distributed separately as `prime-corpus-frontend` and is not bundled with the system repo.

Atom kinds heavily used in this domain:
- `persona` — a coherent design school (e.g. "stripe-clean", "magazine-editorial", "vercel-minimal") with font / color / density / motion contracts
- `pattern` — structural UI patterns (toast-stack, metric-card, pricing-toggle…)
- `template` — reusable code / markup templates (easing configs, OKLCH palettes, shadcn components)
- `rule`, `check`, `constraint` — quality and a11y constraints (WCAG, contrast ratios…)
- `fact`, `value` — design constants (color tokens, spacing scale, Miller's rule…)
- `voice` — writing register (concise-technical, friendly-approachable…)

In this domain, `persona` is defined as: *a coherent design school with font, color, density, and motion contracts — a named aesthetic posture that other atoms reference for stylistic alignment.* (Note: the protocol-level definition of `persona` is more general; see PRIME-PROTOCOL-v1 §1.2.)

---

## §2 · Frontend-Domain `domain.yaml`

The `prime-corpus-frontend` corpus ships a `domain.yaml` that registers six retrieval axes:

```yaml
id: frontend-design
version: "0.1.0"
label: Frontend design — typography, color, layout, motion, a11y
axes:
  - id: register
    label: Design school / persona
    matches: [persona, voice]
  - id: pattern
    label: Structural UI patterns
    matches: [pattern, template, anti-pattern]
  - id: motion
    label: Animation and transition guidance
    matches: [template, pattern]
    tags: [motion, easing, spring, stagger]
  - id: typography
    label: Font, scale, and text layout
    matches: [fact, rule, constraint]
    tags: [typography, font, scale]
  - id: color
    label: Palette, OKLCH tokens, contrast rules
    matches: [template, rule, value]
    tags: [color, oklch, contrast, palette]
  - id: rules
    label: Quality constraints and a11y checks
    matches: [rule, check, metric]
    tags: [a11y, wcag, quality]
```

---

## §3 · Composition Contract — Frontend Extension

The frontend domain extends the protocol's universal `composition:` block with three typed sub-fields:

```
persona Stripe {
  id: "@impeccable/persona-stripe"
  version: "1.2.0"
  description: "Clean, confident B2B SaaS aesthetic."

  composition: {
    typography-required: {
      display: "Söhne | SF Pro Display"
      weight: 300
    }
    color-required: {
      heading: "#061b31"
      shadow: "rgba(83,58,253,0.18)"
    }
    motion-prescriptions: "subtle, purposeful; max 200ms for transitions"
    must-include: [
      @community/template-shadcn-pricing-toggle,
      @community/pattern-metric-card,
    ]
    must-avoid: [
      @impeccable/template-fade-stagger-aggressive,
    ]
  }
}
```

**Frontend-specific sub-fields**:

| Field | Type | Description |
|---|---|---|
| `typography-required` | block | Font family and weight constraints. Enforced by L3 validator against the agent's generated output. |
| `color-required` | block | Named color token constraints (hex, OKLCH, rgba). |
| `motion-prescriptions` | string | Prose description of motion intent. Not machine-enforced in v1; serves as agent guidance. |

**Storage in `AtomMeta`**: The system-repo `AtomMeta` type does not carry these fields directly. They are stored in `compositionExtras: Record<string, string>` (a generic bag). Frontend tooling reads `compositionExtras["motion-prescriptions"]` etc. This keeps the protocol's `AtomMeta` clean for non-frontend domains.

---

## §4 · Multi-Axis Retrieval

The frontend-design MCP wrapper performs 6-axis retrieval after Layer 1 intent classification.

| Axis | What it selects | Atom kinds targeted |
|---|---|---|
| `register` | Primary design school / persona | `persona`, `voice` |
| `pattern` | Structural UI patterns for this task type | `pattern`, `template`, `anti-pattern` |
| `motion` | Animation and transition guidance | `template` (easing/spring configs), `pattern` (stagger/reveal) |
| `typography` | Font, scale, and text layout rules | `fact`, `rule`, `constraint` |
| `color` | Palette, OKLCH tokens, contrast rules | `template`, `rule`, `value` |
| `rules` | Quality constraints and a11y checks | `rule`, `check`, `metric` |

**Budget constraints per task type** (from `primes/taxonomy/`):

| Task type | Max register atoms | Max rule/check atoms | Total cap |
|---|---|---|---|
| marketing-landing | 2 | 3 | 12 |
| blog-article | 1 | 2 | 8 |
| product-ui | 2 | 4 | 16 |
| interaction | 2 | 3 | 12 |
| dev-tool | 2 | 4 | 14 |

---

## §5 · MCP Tools

### §5.1 · The production surface

Six tools across two `.mcp.json` servers. The parent repo's legacy `mcp-server/`
entry and its copy `release/prime-corpus-frontend-design/app/mcp-server-frontend/`
were **deleted in round 13** (lane L13-E). They had already stopped being the
production entry when `.mcp.json` was pointed at `mcp-server-core` — `grep
PRIME_BACKEND|IS_V3` over the wired path returned 0 — and their five orphaned
`prime_query` scopes (`template` `mandate` `checklist` `gallery` `scout`) are
recorded in `docs/analysis/legacy-scope-spec.md` before removal.

| Server | Entry | Tools |
|---|---|---|
| `prime-wiki` | `release/prime-system/packages/mcp-server-core/src/index.ts` | `prime_query` (`scope=atoms\|related\|show`), `prime_plan`, `prime_resource` |
| `prime-design` | `domains/prime-frontend-design/mcp/src/server.ts` | `prime_design_plan`, `prime_design_resolve`, `prime_design_validate` |

The three `prime_design_*` tools are not hand-written: they are projected from
`domains/prime-frontend-design/model/tools/` by `sdk-codegen`'s `emitMcpTools`, so
their names, input schemas and annotations come from the Model Package (§11.2).
Two servers rather than one because §15.4 is one-way — the kernel cannot import a
domain, so an aggregated process would have to be owned by a domain package.

`prime_design_*` input keys are deliberately identical to the retired tools they
replace (`design-actions.yaml`), and `prime_design_plan` is byte-identical to the
retired `prime_intent` on the briefs exercised by
`scripts/shadow-mcp/run.ts`.

### §5.2 · The retired v1 surface (historical)

Everything below describes the five tools of `mcp-server/index.ts` as it stood
before the cutover. It is kept for provenance and is **not** a description of any
running server. Two of the descriptions were also wrong about that server:
`prime_validate` took `(html_path, brief)` and not `(html_path, register,
contract)`, and `prime_resolve` took a `brief` and returned a typed design spec —
resolving an atom id to content at a projection level is what the current
`prime_query scope=show` and `prime_resource` do.

### `prime_compile`
Primary entry point. Brief → 6-axis atom retrieval plan.

```
Input:
  brief: string          — free-form brief ("邮件订阅, 简单就行")
  mode: "browse"|"push"  — browse returns index for agent to self-select;
                           push injects full atom content
  skip_intent: bool      — bypass Layer 1, use raw keyword search (legacy)
  persona_school: enum   — override register (legacy compat)
  budget: number         — token budget cap (legacy)
  max_atoms: number      — max index entries (legacy)

Output (browse mode):
  {
    intent: IntentObject,
    axes: {
      register: { primary: AtomRef, alternates: AtomRef[] },
      pattern:  AtomRef[],
      motion:   AtomRef[],
      typography: AtomRef[],
      color:    AtomRef[],
      rules:    AtomRef[],
    },
    contract: { must_include: string[], must_avoid: string[] },
    path_template: string,
    turn_budget_hint: number,
  }
```

### `prime_query`
Graph and corpus traversal (wraps the protocol-level `prime_query` from `mcp-server-core`).

```
Input:
  scope: "atoms" | "related" | "template" | "mandate" | "checklist" |
         "gallery" | "scout"
  id: string              — atom ID for related/template/mandate/checklist
  query: string           — search string for atoms/scout/gallery
  limit: number

Output: varies by scope
```

### `prime_intent`
Layer 1 intent classification only (without retrieval).

```
Input:  brief: string
Output: IntentObject
```

### `prime_validate`
Layer 5 output validation.

```
Input:
  html_path: string       — path to generated HTML file
  register: string        — expected register ("warm-institutional", ...)
  contract: object        — must_include / must_avoid atom lists

Output:
  {
    l1: { pass: bool, issues: string[] },   // HTML structure + semantic tags
    l2: { pass: bool, score: number },      // LLM aesthetic alignment
    l3: { pass: bool, missing: string[] },  // composition contract honored
    feedback: string,                        // retry prompt if any fail
  }
```

### `prime_resolve`
Resolve atom ID → full atom content at specified projection level.

```
Input:
  id: string
  level: "summary" | "core" | "full"
Output: { content: string, tokens: number }
```

---

## §6 · IntentObject (Layer 1 Classification)

`prime_compile` calls DeepSeek (or falls back to keyword heuristic when `DEEPSEEK_API_KEY` is absent) to produce an `IntentObject`:

```typescript
interface IntentObject {
  task_type: string;           // "marketing-landing" | "product-ui" | ...
  sub_type: string;            // "waitlist" | "pricing-b2b" | ...
  register_candidates: Array<{ school: string; weight: number; rationale: string }>;
  vibe: string[];              // ["approachable", "friendly"]
  motion_priority: "low" | "med" | "high";
  density: "tight" | "comfy" | "loose";
  domain: string;              // "consumer-saas" | "fintech" | "security" | ...
  required_axes: string[];
  ambiguity_flags: string[];
}
```

Fallback: if `DEEPSEEK_API_KEY` is not set, Layer 1 falls back to keyword heuristic matching.

---

## §7 · Frontend Domain Tags

Atom counts by domain tag within the frontend-design corpus (899 atoms):

| Domain tag | Atom count | Notes |
|---|---|---|
| `frontend-design` | 410 (core) + ~299 adjacent | Visual design, typography, color, layout, motion |
| `visual-design` | 85 | Brand, editorial, aesthetic atoms |
| `accessibility` | 62 | WCAG, a11y checks, focus patterns |
| `security` | 32 | OWASP, auth flows, input validation |
| `ux-design` | 23 | Interaction design, mental models |
| `motion` | 13 | Easing, spring configs, stagger patterns |
| Others | ~14 | typography, forms, design-system, etc. |

---

## §8 · Output Validation — L5 (Frontend HTML)

The frontend domain's L5 validator checks generated HTML output:

- **`l1-structure.ts`**: parse HTML AST, check semantic tags (`<main>`, `<nav>`, `<h1>`, ARIA labels)
- **`l2-semantic.ts`**: LLM call — "Does this HTML look like `{register}` aesthetic at 0.8+ confidence?"
- **`l3-composition.ts`**: verifies all `must-include` atoms from composition contract are reflected in output
- **`feedback-builder.ts`**: constructs structured retry prompt on failure → agent re-generates

**Validation loop**: agent generates → calls `prime_validate` → if any layer fails, receives structured feedback → re-generates. Maximum 2 retry cycles.

For non-frontend domains, L5 validation is domain-defined: a legal-document domain validates PDF/Markdown structure; a security domain validates policy coverage. The protocol reserves the L5 slot — the implementation is up to the domain wrapper.

---

*Domain spec version: 1.0 · Updated: 2026-05-09 · Corpus: 899 atoms*
