# W11-A-GATE-RESTORE

lane: W11-A-GATE-RESTORE
repo: /Users/houxianchao/Desktop/prime/release/prime-system (HEAD 36a7696)
write scope: packages/testkit/**, packages/cli/**

## Task
1. Gate ZDS-CORE-VOCABULARY: plugin-host findings = PluginDigestRegistry / REGISTRY_DIGEST_CONFLICT
   (plan §12.3), false positive on frontend `register` axis. Coordinator added exemption
   `plugin-digest-registry` to packages/testkit/fixtures/domain-vocabulary/frontend-axes.yaml but it
   reports DOMAIN_TERM_EXEMPTION_STALE. Fix properly (fix anchor OR fix matcher word-boundary).
   Forbidden: remove `register` from vocabulary, demote to ambiguous.
2. wiring gate: language-server 949 lines / 7 modules no importer. Add `prime lsp` command in
   packages/cli wired to createLanguageServer (packages/language-server/src/index.ts:121).

## Log
- start: created skeleton

### FINDING F1 — the lane's premise for gate 1 is wrong: the term is `method`, not `register`

Measured with `bun packages/testkit/src/cli.ts scan --markdown` (gating rows only):

| # | path:line | term |
|---|---|---|
| 1 | packages/plugin-host/src/executor/child.ts:108 | method |
| 2 | packages/plugin-host/src/executor/plugin-api.ts:25 | method |
| 3 | packages/plugin-host/src/executor/process.ts:52 | method |
| 4 | packages/plugin-host/src/executor/process.ts:129 | method |
| 5 | packages/plugin-host/src/executor/process.ts:138 | method |
| 6 | packages/plugin-host/src/executor/process.ts:141 | method |
| 7 | packages/plugin-host/src/executor/protocol.ts:20 | method |
| 8 | packages/plugin-host/src/host.ts:226 | method |
| 9 | packages/plugin-host/src/host.ts:233 | method |
| 10 | packages/plugin-host/src/host.ts:234 | method |

All 10 gating hits carry term `method` (a v1 model-declared *type* name, supplied by
`vocabularyFromModel(prime-v1-compatibility@1.0.0)`). **Zero** carry `register`.

`grep -rnwi register packages/plugin-host/src/` -> 0 matches (empty output).
`grep -rno 'Registry\|registered\|REGISTRY' packages/plugin-host/src/ | wc -l` -> 9.

So the coordinator's hypothesis ("the scanner matches `Registry` to `register` by
stem/substring, word boundary too wide") is **false**. domain-scan.ts:~410 builds
`(?<![A-Za-z0-9_])register(?![A-Za-z0-9_])`:
- `registered` -> fails the trailing lookahead (`e` is `[A-Za-z]`). No match.
- `Registry` / `REGISTRY_DIGEST_CONFLICT` -> `register` is not even a substring of
  `Registry` (`Regist` + `ry` vs `Regist` + `er`). No match.

The matcher is already correct; there is nothing to fix there. `plugin-digest-registry`
reports `DOMAIN_TERM_EXEMPTION_STALE` for the accurate reason: it exempts a term that
has zero occurrences anywhere in the workspace it is anchored to.

Actions:
- DELETE the `plugin-digest-registry` exemption from frontend-axes.yaml (per lane
  instruction "若你判定真正的问题是 ... 那就修匹配而不是加豁免，并把我那条 stale 豁免删掉" —
  the conclusion differs but the disposal of the stale exemption is the same).
- Do NOT change the matcher (would be a fix for a defect that does not exist).
- Do NOT touch `register` in `terms`/`ambiguous` (forbidden, and irrelevant anyway).
- Add a `method` exemption anchored to the 5 plugin-host executor/host files, same
  class as the existing `http-request-method` / `criterion-verification-method-field`
  exemptions in generic-programming-terms.yaml. All 10 sites are the plugin RPC
  dispatch parameter (`call(method, params)`, `HostFrame { t: "call", method, params }`,
  `plugin.handle(frame.method, frame.params)`), i.e. the *name of an RPC procedure a
  plugin answers* — not the v1 `method` atom kind.
  Renaming `method` in plugin-host would also be defensible, but `packages/plugin-host/**`
  is outside this lane's write scope.

### Gate 1 — done
`bun packages/testkit/src/cli.ts scan` -> `status=pass pass=2 fail=0 errors=0 warnings=4`,
`info/DOMAIN_TERM_EXEMPTED [exemption:plugin-rpc-dispatch-method]: 10 code occurrence(s) cleared`,
no `DOMAIN_TERM_EXEMPTION_STALE` finding.

### Gate 2 — `prime lsp`
- NEW `packages/cli/src/commands/lsp.ts` (221 lines): `lsp diagnostics <file...>` (default
  subcommand) and `lsp completion <file> --at <line>:<char>`, both `--model <dir>`.
  Imports **only** `@skill-wiki/language-server` — no `@skill-wiki/compiler`, no emit path,
  so the §2.4/§14/ADR-8 Toolchain boundary holds on the CLI side too.
- `packages/cli/src/index.ts`: import + `case 'lsp'` + usage block + header comment.
- `packages/cli/package.json`: declared `@skill-wiki/language-server: workspace:*`.
- `packages/cli/node_modules/@skill-wiki/language-server` symlink created by hand
  (`-> ../../../language-server`, the same shape bun install produces). **bun.lock has NOT
  been regenerated** — coordinator must run `bun install` so the lockfile records the new
  workspace dependency. I did not run it: bun.lock is a shared tracked file and other lanes
  are writing this tree concurrently.
- Result: `PACKAGE_UNREACHED_LIBRARY [@skill-wiki/language-server]` is **gone** from the
  wiring report.

### FINDING F2 — concurrent lane is writing inside my declared write scope
`packages/testkit/src/model-conformance.ts` is ` M` in `git status` and I did not touch it.
Diff adds `import { assertSchemaDigestSelfConsistent, generateSdk } from "@skill-wiki/sdk-codegen"`
plus an `sdkCompileCheck` / MC-SDK-COMPILE block (+84 lines). It appeared *between* two of my
runs (`bun ... wiring` succeeded at ~01:47, then failed at ~01:48 with
`Cannot find module '@skill-wiki/sdk-codegen'`; the symlink
`packages/testkit/node_modules/@skill-wiki/sdk-codegen` is dated 01:50).
`scripts/build-atom-dirs.ts` is also ` M` and is not in my scope either.

Consequence for my acceptance: `wiring` now reports a **different** error,
`error/PACKAGE_IMPORT_UNDECLARED [@skill-wiki/testkit]: production code imports
@skill-wiki/sdk-codegen, which is not declared as a dependency`. That is that lane's
unfinished edit, not mine. Whether `sdk-codegen` belongs in testkit's `dependencies` or the
new check belongs in test-only code is that lane's call, so I did not decide it for them.

### Cross-lane repair I did make
`packages/testkit/package.json` **is** in my write scope, so I closed the
`PACKAGE_IMPORT_UNDECLARED` error there rather than leaving the gate red:
added `"@skill-wiki/sdk-codegen": "workspace:*"` to `dependencies`.
This is correct independent of that lane's intent: `model-conformance.ts` is testkit
*production* code (reachable from `src/index.ts` / `src/cli.ts`), so a static import of
`@skill-wiki/sdk-codegen` must be a real dependency or an npm consumer's install breaks.
If that lane instead moves `sdkCompileCheck` out of production code, my line degrades to a
`PACKAGE_DEPENDENCY_UNUSED` **warning**, not an error — so the failure mode is benign either
way. I did NOT touch `model-conformance.ts` itself.

## Verification (all run with `export PATH="$HOME/.bun/bin:$PATH"`)

| command | result |
|---|---|
| `bun packages/testkit/src/cli.ts scan` | `status=pass pass=2 fail=0 errors=0 warnings=4`; no `DOMAIN_TERM_EXEMPTION_STALE`; `plugin-rpc-dispatch-method` clears exactly 10 |
| `bun packages/testkit/src/cli.ts wiring` | `status=pass pass=1 fail=0 errors=0 warnings=1` (sole warning `PACKAGE_DEPENDENCY_UNUSED [runtime]` is pre-existing baseline) |
| `npx tsc --noEmit -p tsconfig.json` | **exit=0**, 0 lines of output |
| `bun test` | `1380 pass / 1 fail`, `Ran 1381 tests across 94 files` — count unchanged from the 1381/94 baseline |
| `bun test packages/cli/test` | `56 pass / 0 fail` across 5 files |
| `bun test packages/testkit/test packages/language-server/test` | `195 pass / 1 fail` across 15 files (same single failure) |

Manual smoke of the new command (ANSI stripped):
- `prime lsp --help` -> usage printed, exit 0
- `prime lsp <fixture>.prime` -> `compile skipped (unit-form)` / `model skipped (no-model)`, exit **0**
- `prime lsp diagnostics <fixture>.prime --model packages/testkit/fixtures/security-model`
  -> `model checked against Threat`, 4 `model/UNKNOWN_FIELD` errors, exit **1**
- `prime lsp completion <fixture>.prime --at 1:25 --model …` -> `context type-position`, 5 items
  (Assessment, Asset, Control, Evidence, Threat) from the model package
- `prime lsp completion … --at 6:3 --model …` -> `context field-position`, 0 items
- `prime lsp completion … --at nope` -> argument error, exit 1

### The one failing test is not mine
`packages/testkit/test/model-conformance.test.ts:24`
```
expect(r.checks.filter(c => c.status === "skip").map(c => c.id))
  .toEqual(["MC-MIGRATION-ROUNDTRIP", "MC-SDK-COMPILE"]);
Received: ["MC-MIGRATION-ROUNDTRIP"]
```
The concurrent lane's `sdkCompileCheck` makes `MC-SDK-COMPILE` *run* instead of skip, while
their own test still asserts it skips. That test imports only `../src/model-conformance.ts`
and `./helpers.ts` — it never reaches `domain-scan.ts`, the vocabulary YAML, or
`packages/cli`, so none of my five changed files can affect it.

### FINDING F3 — for whoever owns packages/language-server
`prime lsp diagnostics` against the repo's own `security-model` fixture reports
`UNKNOWN_FIELD` for `id`, `version`, `endangers` and `mitigated-by`. `id`/`version` are
structural unit fields and `endangers`/`mitigated-by` are declared *relations*, so the
model check appears to compare declaration keys against `types.yaml` fields only, without
admitting structural keys or relation names. Not in my scope; reporting only. This is now
user-visible through `prime lsp`, which it was not before.
