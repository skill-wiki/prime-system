# Known Issues — v0.1.0

This file tracks known issues that ship in v0.1.0. Each one has a tracking workitem and a planned fix version. The list is short and honest: please file new issues for anything not covered here.

## Type system

### `tsc --noEmit` exits 0 across all packages

**Status**: resolved  
**Severity**: n/a

```
bun test           # 448 pass / 0 fail / 1366 expect() calls
```

### Test files import via `.ts` extensions

**Status**: known, deferred
**Severity**: cosmetic

`tsconfig.json` enables `allowImportingTsExtensions` to support test files that import siblings as `./foo.ts`. This is required for Bun's resolver but means the test files don't conform to strict ESM ts-without-extension conventions. Production source files use barrel imports without extensions and are unaffected.

## Registry

### The HTTP registry is a self-host stub, not a public service

**Status**: by design at v0.1.0
**Severity**: documented in `docs/registry.md`

The registry server in `scripts/registry-server.ts` and `packages/registry/` is a working reference implementation suitable for self-hosting. It has:

- HTTP routes for `GET/PUT /atoms/:id.prime`
- SQLite-backed storage
- A single shared bearer token for write access
- An end-to-end round-trip test

It does **not** have:

- Per-namespace authentication (one token controls the whole registry)
- Semver resolution at install time
- Mirroring or federation
- Audit logs, rate limiting, or signing

A public hosted registry is on the v0.5 roadmap. Until then, organizations should self-host. Use `PRIME_REGISTRY` env var or `--remote <url>` to point `prime install` / `prime publish` at your own host.

### `prime decompose` CLI is a pointer command

**Status**: intentional (v0.1.0)

The CLI subcommand points to the agent-driven `prime-decompose` Claude Code skill in `skills/prime-decompose/`.

If you have a SKILL.md you want decomposed, use the skill — not a regex.

## Validator

### L2 (semantic) checker is opt-in and requires an API key

**Status**: by design

L1 (structural) and L3 (cross-atom consistency) run deterministically with no network calls. L2 calls a small LLM to check semantics like fact-confidence calibration and rule decidability — it costs roughly USD 0.0001 per atom on a typical configuration.

L2 is opt-in: set `DEEPSEEK_API_KEY` (or another provider key, configured in `packages/compiler/src/ai-client.ts`) and pass `--enable-l2-llm` to the build script. Atoms are otherwise assumed semantically valid by their authors.

## Examples

### Example corpora are unsigned and ship without `compiled/` artifacts

The three example corpora (`examples/hello-world`, `examples/recipes`, `examples/coding-style`) ship with `primes/sources/` only. Run `bun run compile-examples` from the repo root to populate `primes/compiled/` for each. CI does this on every push.

This is intentional: shipping a build artifact under `examples/` would make `git diff` noisy on every source change.
