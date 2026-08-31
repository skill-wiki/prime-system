# `@skill-wiki/runtime` — what this package owns

Two modules, both production-wired. There is no experimental tier left in this
package: the projection-era graph/search/bundle layer (`loader.ts`,
`corpus-graph.ts`, `corpus-index.ts`, `index-manager.ts`, `skill-bundler.ts`), the
Method-execution group (`executor.ts`, `evaluator.ts`, `ai-step-executor.ts`,
`method-loader.ts`) and the domain-plugin group (`domain-plugin.ts`,
`domain-config.ts`) were all **deleted** rather than deprecated. `src/index.ts`
records why for each group; the short version is that every one of them carried
model-declared closed-set literals or read Parser AST, and their responsibilities
now sit in `packages/query-engine`, `packages/constraint-solver`,
`packages/projection-engine`, `packages/action-runtime` and
`packages/model-schema`.

An earlier revision of this file described those modules as "experimental
(tests only)" and named `mcp-server/index.ts` — the parent repo's legacy server —
as the production consumer of `atom-loader.ts`. Both statements were stale even
then: that file had not been the production entry since `.mcp.json` was pointed at
`mcp-server-core`, and it did not import this package at all. Round 13 (lane
L13-E) deleted it outright, together with its copy under
`projects/prime-frontend-design/app/mcp-server-frontend/`; the behaviour of
its five orphaned `prime_query` scopes is recorded in the parent repo at
`docs/analysis/legacy-scope-spec.md`. `atom-loader.ts` reaches production through
this package's own `src/index.ts:46` re-export and through
`packages/projection-engine/src/adapters/atom-loader.ts` (re-exported at
`projection-engine/src/index.ts:94` as `atomLoaderAdapter`); `mcp-server-core`
names it only in comments.

## Modules

| Module | Purpose |
|---|---|
| `corpus-snapshot.ts` | Immutable bundle activation: manifest parsing, protocol/IR/emitter version compatibility, `contentDigest` verification, containment checks. A bundle that fails any of these refuses to activate. |
| `atom-loader.ts` | Reads `_index.xml` into a `GlobalIndex`, reads per-unit `atom.yaml` metadata, resolves projection-level artifact paths and collections. Routes deprecated units to a separate bucket so retrieval never serves them. |

`src/index.ts` is the only public surface; nothing outside this package imports a
module path directly.

## Production consumers

Measured with `grep -rn "from ['\"]@skill-wiki/runtime['\"]"` over
`projects/prime-system` and `domains`, excluding `*.test.ts` and `test/`:

| Consumer | What it uses |
|---|---|
| `packages/mcp-server-core/src/index.ts` | `loadCorpusSnapshot`, `loadIndex`, `loadAtomMeta`, `type BundleDiagnostic`, `type GlobalIndex`, `type SnapshotRef` — this is the production MCP server, the one `.mcp.json` launches |
| `packages/mcp-server-core/src/emit-diagnostics.ts` | `loadCorpusSnapshot`, `loadIndex`, `loadAtomMeta` |
| `packages/mcp-server-core/src/query-response.ts` | `type SnapshotRef` |
| `packages/bundle/src/index.ts` | `compareCanonicalStrings`, `computeCorpusContentDigest`, `loadCorpusSnapshot`, `validateCorpusManifest`, `type CorpusManifest`; also re-exports `computeCorpusContentDigest` |
| `packages/cli/src/audit/corpus.ts` | bundle reading for `prime audit corpus` |
| `packages/cli/src/commands/doctor.ts` | `loadCorpusSnapshot`, `loadIndex`, `PrimeBundleError`, `type SnapshotRef` |
| `projects/prime-frontend-design/mcp/src/server.ts` (parent repo) | `loadCorpusSnapshot`, `loadIndex`, `loadAtomMeta` — the domain MCP server builds its corpus binding from the same loaders the kernel uses, so both serve one graph over one snapshot |

## The rule this file exists to enforce

If you add a module here, add its row above and name its production consumer. A
module with no production consumer does not belong in this package — that is the
clause the three deleted groups were removed under, and it is the reason this
README is a consumer table rather than a roadmap.
