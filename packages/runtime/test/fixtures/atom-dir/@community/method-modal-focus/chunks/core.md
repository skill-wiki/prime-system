# method-modal-focus

## Input
- `trigger`: Element that opened the modal
- `modal`: The dialog container element

## Steps
1. **OPEN**: Move focus to first focusable element inside modal
2. **TRAP**: Intercept Tab/Shift-Tab to cycle within modal only
3. **CLOSE**: Return focus to `trigger` element
4. **ESCAPE**: Listen for Escape key → trigger close

## Checks
- All interactive elements inside modal must be reachable via Tab
- Focus must not escape modal while open
- `trigger` must receive focus after modal closes
