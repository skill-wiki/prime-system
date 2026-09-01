# AOE CLI

`@aoe/cli` provides the AOE command line for Agent Ontology Engine
packages. It installs the `aoe` binary.

The CLI requires Bun because the Action run surface uses the Bun SQLite runtime.

```bash
bun add --global @aoe/cli
aoe --help
```

The command surface covers source authoring and checks, package management,
bundle diagnostics, Action preflight and execution, Event run inspection, and
Language Server diagnostics.

Maintained Corpus releases should use their owning package scripts rather than a
single-file command. Those scripts bind the exact Model Package, Corpus identity,
release date, signing policy, and strict verification.

See the [CLI reference](../../docs/reference/cli.md) for the command surface.
AOE is Apache-2.0 licensed.
