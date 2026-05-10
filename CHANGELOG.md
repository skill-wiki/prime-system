# Changelog

All notable changes to the Skill Wiki / Prime **system** repo. Corpus
repos (e.g. `prime-corpus-frontend`) maintain their own changelogs.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aspires to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The protocol is versioned independently from the implementation. `[spec: vX]`
tags mark which protocol version each release implements.

---

## [Unreleased]

### Planned
- Lifecycle enforcement: compiler emits warnings when a `deprecated` atom
  appears in a retrieval result.
- Structured AST for `type` expressions (function signatures, unions,
  ranges) — currently round-tripped as opaque strings.
- Formal domain plugin protocol — replace ad-hoc `domain:` metadata field
  with a registered plugin interface.
- L2 LLM checker stabilization (currently labeled experimental; gated by
  `DEEPSEEK_API_KEY`).

---

## [0.1.0] — 2026-05-09  · `[spec: v1.0]`

Initial release.

### Added

- `packages/parser/` — `.prime` lexer + recursive-descent parser (62 tests).
  Supports the 28 atom kinds, 14 edge verbs, hyphen-keyword fields,
  triple-quoted blocks, atom references (`@scope/id`), function-signature
  type expressions, union types, range expressions.
- `packages/types/` — shared TypeScript types for AtomKind, EdgeVerb,
  ProjectionLevel, AtomRef, CompositionContract.
- `packages/compiler/` — L1 structural checker (required fields, atom-kind
  schema, ref resolution, duplicate ID detection) and L3 cross-atom graph
  checker (cycle detection in `requires:`, `must-include` corpus presence,
  `contradicts:` flagging). L2 (per-atom DeepSeek semantic check) gated by
  `DEEPSEEK_API_KEY` and labeled experimental.
- `packages/runtime/` — atom loader, projection resolver
  (`summary` / `core` / `full`), domain plugin host stub.
- `packages/registry/` — HTTP package registry server with publish (PUT)
  and install (GET) endpoints. Token-based auth.
- `packages/cli/` — `prime` command with verbs: `init`, `compile`, `check`,
  `ls`, `show`, `graph`, `deps`, `publish`, `install`, `mcp`.
- `packages/mcp-server-core/` — ~200-line generic MCP server exposing one
  tool, `prime_query`, over any compiled corpus.
- `spec/PRIME-PROTOCOL-v1.md` — protocol specification, v1.0.
- `spec/FRONTEND-DESIGN-DOMAIN-v1.md` — frontend-design domain wrapper spec.
- `examples/hello-world/` — 5-atom corpus demonstrating the round-trip
  on a trivial domain (boiling water, making tea).
- `examples/recipes/` — 15-atom corpus across cooking technique, ingredients,
  procedures, and rules.
- `examples/coding-style/` — 12-atom corpus modeling team lint rules and
  anti-patterns.
- Documentation: `docs/getting-started.md`, `docs/architecture.md`,
  `docs/philosophy.md`, `docs/dsl-quickref.md`, `docs/cli.md`, `docs/mcp.md`,
  `docs/registry.md`, `docs/corpus-authoring.md`, `docs/comparison.md`,
  `docs/faq.md` — each in EN + 中文.
- CI workflow runs parser, compiler, runtime tests; smoke-compiles each
  example; runs the registry round-trip script.

### Decisions

- **Two-repo split.** System repo (this) carries protocol only.
  Frontend-design corpus (`prime-corpus-frontend`) carries 899 atoms +
  domain-specific intent / retrieval / composition / validator-html /
  5-tool MCP wrapper.
- **License: Apache-2.0.** Patent grant explicit. NOTICE preserved across
  repos.
- **No model lock-in.** L2 / intent / aesthetic validation use any LLM
  with a chat-completions-compatible API.
- **Node 22+ only.** Native TS strip via `--experimental-transform-types`.
  No bundler required to run; bun is supported as a faster install/test
  runner.

### Known gaps

- L2 semantic checker has no first-party regression suite.
- Registry has no end-to-end semver conflict resolution.
- Cross-LLM benchmarks are not in this repo's scope. An internal benchmark
  showing ~26% cost / 1.76× speedup vs raw Skills was run on a 20-task
  suite with the frontend-design corpus; N=1 per condition — directional
  only. See the corpus repo's `docs/benchmarks.md`.

---

[Unreleased]: https://github.com/skill-wiki/prime-system/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/skill-wiki/prime-system/releases/tag/v0.1.0
