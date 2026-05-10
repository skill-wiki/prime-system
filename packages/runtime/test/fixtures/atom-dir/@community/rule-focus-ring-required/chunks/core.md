# rule-focus-ring-required

## Checks
- `computed-style(':focus-visible').outline !== 'none'` → block if fail
- `wcag-contrast(ring-color, adjacent) >= 3.0` → block if fail

## Severity
any-fail → block
