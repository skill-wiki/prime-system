<!--
Thanks for the contribution. A short description below + the checklist is enough for most PRs. For larger changes, please open a feature-request issue first so the design conversation lives in one place.
-->

## What does this change

<!-- 1-3 sentences. Link to the issue this addresses, if any. -->

## Why

<!-- The motivation in one paragraph. -->

## How was it tested

<!-- Commands you ran, or which tests cover the change. -->

```
bun test
```

## Checklist

- [ ] Tests added or updated for the changed behavior
- [ ] `bun run typecheck` passes
- [ ] `bun test` passes locally
- [ ] If this changes the protocol, `spec/PRIME-PROTOCOL-v1.md` is updated and the change is noted in `CHANGELOG.md`
- [ ] If this changes the CLI surface, `docs/cli.md` (and `docs/cli.zh-CN.md`) are updated
- [ ] No `console.log` left in shipping code
- [ ] No absolute paths or developer-machine specifics committed
