# 14 Edge Verbs — Use-When Cheat Sheet

| Verb | Use when | Example |
|---|---|---|
| `related` | The two atoms inform each other but neither is required by the other. **Default verb.** Aim for ≥ 3 per atom. | `pattern-toast-stack related @community/template-spring-config` |
| `compatible` | Two atoms (usually `persona`) can be co-loaded without conflict. The compositor may use both. | `persona-vercel-clean compatible persona-swiss-modernist` |
| `conflicts` | Two atoms are mutually exclusive. The compositor MUST pick one. Use sparingly — only for genuine aesthetic / semantic clashes. | `persona-brutalist conflicts persona-magazine-editorial` |
| `see-also` | Pure cross-reference. No semantic constraint. Use when "you might also want to read X" but X is not load-bearing. | `fact-miller-rule see-also fact-hick-law` |
| `extends` | A inherits all fields of B and overrides specified ones. **Personas only**, in practice. | `persona-tokyo-minimal extends @impeccable/persona-notion-warm` |
| `derived-from` | A is a non-inheriting derivative of B (typically a citation). Use when your atom is based on an external spec or paper. | `rule-contrast-aa derived-from @w3c/wcag-2.2-1.4.3` |
| `requires` | If A is loaded, B MUST also load. **Strong dependency.** Use sparingly; the compositor enforces it. | `method-heuristic-review requires @nielsen/taxonomy-10-heuristics` |
| `enhances` | B improves A but is not required. **Soft dependency.** | `persona-editorial enhances voice-precise-technical` |
| `validates-with` | A's correctness is verified against B. Use on `rule` → `source` or `rule` → `check`. | `rule-color-contrast validates-with @w3c/wcag-2.2-1.4.3` |
| `supplies-to` | A is a value/resource consumed by B. Inverse of `requires` from the value side. | `value-touch-target-min supplies-to rule-touch-target-min` |
| `specializes` | A is a narrower subtype of B. | `persona-magazine-editorial specializes @impeccable/persona-editorial` |
| `contradicts` | A and B make semantically opposing claims. **L3 flag** — the cross-checker emits a warning when both load. Use deliberately. | `rule-no-pure-white contradicts fact-white-is-neutral` |
| `relationships` | Generic catch-all from older atoms. **Avoid in new authoring** — pick a specific verb. | — |
| `includes` | A `collection` atom enumerates its members. Only used by `collection` kind. | `collection-frontend-design includes [pattern-..., rule-...]` |

## Authoring rule

Every new atom MUST have:

1. **≥ 3 `related:` edges** (any verb that is not `related` does NOT count toward this quota — `related:` is its own field).
2. **≥ 1 of**: `extends`, `derived-from`, `requires`, `enhances`, `specializes`.

If you cannot find 3 related peers, your atom is either:
- Mis-scoped (split into multiple smaller atoms), or
- An island (the source document didn't have enough context — flag this and ask the human).
