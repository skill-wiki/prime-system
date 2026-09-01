# Kernary CLI

The `kernary` command is the fastest way to inspect a Model Package, build a
Corpus Package, run diagnostics, and exercise an Action locally.

```text
kernary v0.2.0 — model-driven ontology engine

Usage: kernary <command> [options]
```

Run `kernary --help` for the installed command surface. Subcommands also expose
their own help and exit codes.

## Commands at a glance

| Goal | Commands |
|---|---|
| Start or author a package | `init`, `compile`, `check`, `graph` |
| Inspect package data | `list`, `show`, `deps`, `install` |
| Publish and discover packages | `publish`, `search`, `info`, `ls` |
| Inspect a snapshot | `doctor` |
| Test actions and runs | `action preflight`, `action run`, `run inspect`, `run replay` |
| Work from an editor | `lsp diagnostics`, `lsp completion` |
| Decompose existing guidance | `decompose`, `compose` |

## A typical local workflow

```bash
# inspect a model and source package
kernary check ./my-domain/model
kernary deps ./my-domain/model

# compile the corpus with its model and release identity
kernary compile ./my-domain/corpus/sources/incident.prime \
  --output ./build/incident --dir --bundle

# verify the generated snapshot before mounting it
kernary doctor --dir ./build/my-domain --strict-manifest
```

Maintained Domain Packages may wrap these steps in a package-specific build
script when they need custom adapters, signing, or evaluation gates.

## Diagnostics and exit codes

`doctor` reports the snapshot identity, active/deprecated Unit counts, token
totals, and every diagnostic. `--json` is intended for CI:

```bash
kernary doctor --dir ./build/my-domain --strict-manifest --json
```

The command exits non-zero when the bundle is missing, its manifest does not
match the index or content, or a required Model Package cannot be loaded.

## Editor support

The `lsp` commands provide diagnostics and completion for Model and Corpus
declarations. They read the package that you point them at; they do not invent
domain fields and they do not build a runtime bundle inside the editor process.

## Query and Action boundaries

The CLI can inspect and exercise a package, but the generic Query Engine and
Action Runtime remain the same libraries used by the SDK, MCP, and HTTP
transports. Use those integrations when an application needs a long-running
server, tenant context, policy providers, or event evidence.

## Publication

`publish` changes an external package registry. Run it only after declaration
conformance, bundle verification, signing, and release review have passed.
The registry stores package metadata and immutable release references; it does
not change the Model or Corpus semantics.
