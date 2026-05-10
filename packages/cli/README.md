# @skill-wiki/cli

The command-line interface for [Prime Language](https://github.com/skill-wiki/prime-system) — a knowledge-protocol DSL for AI agents.

## Install

```sh
npm install -g @skill-wiki/cli
# or: bun add -g @skill-wiki/cli
```

Requires Node.js >= 22.

## Quick start

```sh
prime init                      # scaffold a new .prime atom
prime compile path/to/file.prime  # compile .prime → .md projections
prime check  path/to/file.prime  # validate without emitting
prime list                      # list atoms in the local registry
prime show   @scope/name        # show atom details + dependencies
prime install @scope/name       # resolve + verify dep graph locally
```

Run `prime --help` for the full command surface (init, compile, check, test, graph, decompose, compose, list, show, deps, install, publish, search, info, ls).

## Docs

See the [Prime System repository](https://github.com/skill-wiki/prime-system) for the language spec, atom kinds, projection model, and architecture.

## License

Apache-2.0
