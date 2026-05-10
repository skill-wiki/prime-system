# Prime — Claude Code slash commands

Five `/prime-*` commands that wrap the most common Prime workflows so Claude Code users can drive them in one keystroke.

| Command | What it does |
|---|---|
| `/prime-resolve <brief>` | Resolves a task brief into concrete typed atoms via the `prime_resolve` MCP tool, with a manual fallback if MCP is not wired up. |
| `/prime-compile <src>` | Runs the Prime compiler on a source directory and reports atoms, edges, and any build errors. |
| `/prime-validate <artifact> <brief>` | Validates a built artifact against a Prime brief contract via `prime_validate` and returns a structured pass/fail. |
| `/prime-author <kind> <name>` | Scaffolds a new `.prime` file for the given kind, asking three clarifying questions before filling fields. |
| `/prime-publish <src>` | Compiles a corpus and prints the YAML + GitHub edit URL needed to open a draft PR against `skill-wiki.github.io`. |

## Install

### Project-level (recommended for contributors to this repo)

The commands are already in place at `.claude/commands/`. Open this repo in Claude Code and they appear automatically.

### Global (use `/prime-*` from any project)

```bash
mkdir -p ~/.claude/commands
cp -r .claude/commands/prime-*.md ~/.claude/commands/
```

After copying, every Claude Code session — anywhere on disk — will surface the five commands.

## Pairing with the MCP server

`/prime-resolve` and `/prime-validate` call MCP tools. To enable them, register the Prime MCP server in your Claude Code config — see [`docs/mcp.md`](../../docs/mcp.md) for the snippet. Without MCP wired up, both commands fall back to manual atom lookup and flag this in the output.

## Editing

Each command is a single Markdown file with YAML frontmatter (`description`, `argument-hint`, `allowed-tools`) followed by the prompt body. Tweak the body to change behavior — `$ARGUMENTS` is replaced with whatever the user types after the command name.
