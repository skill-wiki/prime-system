# `.prime` DSL — minimal grammar + 6 real examples

## Grammar

```
File          := WS* Atom WS*                         (one atom per file)
Atom          := <kind> <PascalName> "{" Field* "}"
Field         := <hyphen-keyword> ":" Value
Value         := String | TripleString | PipeBlock
              |  Array  | Number  | Boolean
              |  AtomRef | EnumLiteral | RawExpr
String        := "\"" ... "\""
TripleString  := "\"\"\"" ... "\"\"\""           (preserves newlines)
PipeBlock     := "|" "\n" indented-lines          (pipe-prefixed multi-line)
Array         := "[" Value ("," Value)* "]"
AtomRef       := "@" <scope> "/" <kebab-id>
                  (bare, no quotes — the parser distinguishes from string)
RawExpr       := anything that doesn't match above (catch-all)
```

Comments: `//` to end of line. Trailing commas: allowed.

## Required fields (every kind)

```
id: "@<scope>/<kebab-name>"
version: "<semver>"
description: "..."
related: [@scope/atom, ...]
```

## 6 real examples (copied from `primes-v3/sources/@community/`)

### 1 — `value`

```
value TouchTargetMin {
  id: "@community/value-touch-target-min"
  version: "1.0.0"
  name: "touch-target-min"
  constant: "44px"
  type: css-length
  domain: accessibility
  rationale: "Apple HIG minimum touch target. Eliminates an entire class of mis-tap a11y bugs and aligns with Fitts' Law."
  related: [
    @community/metric-target-size,
    @community/check-touch-target-min,
    @community/fact-fitts-law,
  ]
  supplies-to: [
    @community/rule-touch-target-min,
  ]
}
```

### 2 — `rule`

```
rule SpacingRhythm {
  id: "@community/rule-spacing-rhythm"
  version: "1.0.0"
  applies-to: @community/type-html-artifact
  domain: visual-design
  description: "All vertical spacing MUST be drawn from a single 8-point scale: 4, 8, 12, 16, 24, 32, 48, 64, 96, 128 px."
  claim: "Every spacing CSS value resolves to a multiple of 4 from the documented scale."
  severity: medium
  validates-with: [
    @community/fact-consistency-standards,
  ]
  checks: [
    @community/check-spacing-rhythm,
  ]
  related: [
    @community/fact-consistency-standards,
    @community/rule-grid-baseline-aligned,
    @community/anti-pattern-cramped-ui,
    @community/principle-vertical-rhythm,
  ]
}
```

### 3 — `anti-pattern`

```
anti-pattern CrampedUi {
  id: "@community/anti-pattern-cramped-ui"
  version: "1.0.0"
  label: "Cramped UI"
  domain: frontend-design
  description: "Overly tight spacing that impairs scanning and makes tap targets touch or overlap."
  trap: "Trying to show more above the fold by packing elements with minimal gaps. On touch devices, targets that touch cause mis-taps."
  remediation: [
    "Increase spacing using the next token step up on the defined scale.",
    "Verify all tap targets meet minimum 44px height (@community/rule-touch-target-min).",
  ]
  related: [
    @community/rule-touch-target-min,
    @community/rule-spacing-rhythm,
    @community/tradeoff-density-vs-comfort,
  ]
}
```

### 4 — `fact`

```
fact MotionAsFeedback {
  id: "@community/fact-motion-as-feedback"
  version: "1.0.0"
  description: "Effective UI motion communicates state changes and causality, not decoration."
  statement: "Animation must communicate one of: cause-and-effect, origin/continuity, state change, or spatial relationship — animation that does none of these is decorative overhead."
  confidence: strong
  source: [
    "Pasquale D'Silva, 'Transitional Interfaces' (2013)",
    "Material Design Motion principles",
    "Apple HIG — Motion section",
  ]
  applies-to: [
    "modal open / close, drawer slide, dropdown reveal",
    "list reorder, optimistic update confirmation",
    "form save / validation feedback",
  ]
  counter-conditions: [
    "Brand-expressive marketing motion trades the rule for emotional value.",
    "Loading / progress animations communicate state — they pass.",
  ]
  related: [
    @community/fact-easing-cubic-bezier,
    @community/fact-duration-perception-thresholds,
    @community/constraint-animation-pref-respected,
  ]
}
```

### 5 — `check`

```
check SkipLink {
  id: "@community/check-skip-link"
  version: "1.0.0"
  signature: (html: string, context?: object) -> CheckResult
  predicate: |
    body = document.body
    firstFocusable = body.querySelector('a[href], button, [tabindex]:not([tabindex="-1"])')
    if firstFocusable.tagName !== 'A':
      yield { fail: 'first-focusable-not-link' }
  domain: accessibility
  description: "Validates that a skip-to-main-content link is the first focusable element in <body>."
  validates: @community/rule-skip-link
  severity: high
  evaluation-method: "automated + manual"
  tools: ["axe-core", "playwright", "lighthouse"]
  related: [
    @community/rule-skip-link,
    @w3c/source-wcag-22,
  ]
}
```

### 6 — `principle`

```
principle VerticalRhythm {
  id: "@community/principle-vertical-rhythm"
  version: "1.0.0"
  domain: frontend-design
  statement: "Spacing between sections must be greater than spacing between items within a section."
  rationale: "Differentiated spacing communicates containment + hierarchy without explicit borders. Direct application of Gestalt law of proximity."
  applies-to: ["frontend-design", "design-systems"]
  examples: [
    "Section margin-top: 64px; item gap: 16px — ratio 4:1, clear grouping",
    "Form with 24px between fields and 48px between groups — double-gap rule",
  ]
  counter-examples: [
    "Every margin set to 16px regardless of section vs item",
    "Using border-bottom: 1px solid to separate sections instead of spacing",
  ]
  related: [
    @community/fact-fitts-law,
    @community/anti-pattern-cramped-ui,
    @community/rule-spacing-rhythm,
    @community/principle-white-space-as-design-element,
  ]
}
```

## Common mistakes

- Quoting an `@scope/id` reference (`"@community/foo"`) — DO NOT. Atom refs are bare tokens.
- Forgetting trailing `}` — every atom is exactly one block.
- Missing `description` — required on every kind.
- Using `relationships:` in new atoms — use specific verbs (`related:`, `requires:`, etc.).
- Inventing atom IDs in edges — every cited ID must exist.
