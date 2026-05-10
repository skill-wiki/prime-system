# rule-focus-ring-required (full)

## Checks
- `computed-style(':focus-visible').outline !== 'none'` → block if fail
- `wcag-contrast(ring-color, adjacent) >= 3.0` → block if fail

## Severity
any-fail → block

## Exemptions
- `tabindex="-1"` with no event handlers (non-focusable)

## Sources
- WCAG 2.4.11 Focus Not Obscured
- WCAG 2.4.7 Focus Visible
