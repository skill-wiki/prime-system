---
description: Compile a Prime source directory into the typed atom artifact tree
argument-hint: <source path>
allowed-tools: Bash, Read
---

The user wants to compile a Prime source tree at:

> $ARGUMENTS

Do this:

1. Run the Prime compiler against that path:

   ```
   bun /Users/houxianchao/Desktop/prime/release/prime-system/packages/cli/src/index.ts compile $ARGUMENTS
   ```

   If the user passed flags (e.g. `--out`, `--strict`), forward them as given.
2. Stream the build output. Watch for parser errors, edge-graph violations, and L1 type failures — these block the build.
3. When the build finishes, report:
   - atoms compiled (count by kind)
   - edges resolved vs broken
   - output directory and whether `_index.xml` was written
   - any warnings worth surfacing
4. If the build failed, point at the offending file:line and quote the error. Do not auto-fix unless the user asks.
