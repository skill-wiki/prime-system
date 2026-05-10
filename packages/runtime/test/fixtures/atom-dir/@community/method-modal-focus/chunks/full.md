# method-modal-focus (full)

## Input
- `trigger`: Element that opened the modal
- `modal`: The dialog container element

## Steps
1. **OPEN**: Move focus to first focusable element inside modal
2. **TRAP**: Intercept Tab/Shift-Tab to cycle within modal only
3. **CLOSE**: Return focus to `trigger` element
4. **ESCAPE**: Listen for Escape key → trigger close

## Implementation Notes

Use `querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')` to collect focusable elements.

On Escape, call close() without relying on pointer events so keyboard-only users can dismiss.

## Sources
- WCAG 2.1 SC 2.1.2 No Keyboard Trap
- ARIA Authoring Practices Guide: Modal Dialog Pattern
- https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/

## Examples
- Radix UI Dialog — gold standard implementation
- Headless UI Dialog (Tailwind Labs)
