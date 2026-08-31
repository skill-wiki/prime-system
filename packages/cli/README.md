# Kernary CLI

`@skill-wiki/cli` is the currently published compatibility package for the
Kernary command line. It installs `kernary` as the preferred binary and `prime`
as a v0.2 compatibility alias.

The CLI requires Bun because the Action run surface uses the Bun SQLite runtime.

```bash
bun add --global @skill-wiki/cli
kernary --help
```

The current command surface covers source authoring and checks, compatibility
package management, bundle diagnostics, Action preflight and execution, Event
run inspection, and Language Server diagnostics.

Maintained Corpus releases should use their owning package scripts rather than a
single-file command. Those scripts bind the exact Model Package, Corpus identity,
release date, signing policy, and strict verification.

See [CLI compatibility](../../docs/reference/cli.md) for the migration boundary.
Kernary is Apache-2.0 licensed.
