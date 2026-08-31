# CLI compatibility

`kernary` is the preferred command in v0.2. The published compatibility package
also installs `prime`; both binaries execute the same entry point.

```text
kernary v0.2.0 — model-driven knowledge runtime for agents

Usage: kernary <command> [options]
```

## Current commands

| Group | Commands |
|---|---|
| Author and check | `init`, `compile`, `check`, `test`, `graph` |
| Legacy Skill composition | `decompose`, `compose` |
| Local package data | `list`, `show`, `deps`, `install` |
| Compatibility registry | `publish`, `publish-marketplace`, `search`, `info`, `ls` |
| Bundle diagnostics | `doctor` |
| Actions and runs | `action preflight`, `action run`, `run inspect`, `run replay` |
| Editor toolchain | `lsp diagnostics`, `lsp completion` |

Run `kernary --help` and the relevant subcommand help for the authoritative
syntax. Some subcommand messages still print the `prime` alias while their v0.2
help is migrated; scripts should accept both binaries during this window.

## Important limits

- `compile <file>` is the compatibility single-source command. Maintained corpus
  releases use their owning package build script so model, corpus identity,
  release date, signing, and strict verification stay bound together.
- The CLI does not replace the Query Engine. Generic runtime queries are exposed
  through SDK, MCP, and HTTP.
- `lsp` provides editor diagnostics and completion. It does not build a runtime
  bundle in the editor process.
- Publication changes an external registry. Run it only after conformance,
  signing, and explicit release authorization.

## Compatibility identifiers

`.prime`, `PRIME_*`, `prime/*`, `prime.dev`, `.primes/`, and `@skill-wiki/*`
appear in the current command surface. They do not make Prime the product name.
Each changes only through a versioned migration or verified external rename.
