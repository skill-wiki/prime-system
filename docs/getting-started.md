# Getting Started

> Hello-world in 30 seconds. Real loop in 5 minutes. Wired into Claude
> Code in 10. This page walks you from `git clone` to a typed corpus your
> agent can query.

[← back to README](../README.md) · [Architecture](./architecture.md) · [Philosophy](./philosophy.md) · [DSL quick reference](./dsl-quickref.md)

---

## Prerequisites

| Requirement | Why |
|---|---|
| **Node 22+** | We use the native TypeScript strip flag `--experimental-transform-types`. No transpiler step. |
| **git** | For cloning. |
| **Bun** *(optional)* | Faster install + run. Everything works on `npm`/`pnpm` too. |
| **Claude Code MCP support** *(optional)* | For the wired-into-agent step. Skip if you only want CLI usage. |
| **DEEPSEEK_API_KEY** *(optional)* | Enables the L2 semantic compiler check (~$0.0001/atom). System works without it. |

Verify Node:

```bash
node --version
# v22.x.x or higher
```

If you're on 20 or 18, the parser fails to load with
`Unknown option: --experimental-transform-types`. Upgrade.

---

## 30-second hello-world

The repo ships three example corpora. The smallest is
`examples/hello-world/` — five atoms about boiling water and making tea.

```bash
git clone https://github.com/skill-wiki/prime-system.git
cd prime-system
bun install        # or npm/pnpm install
bun run build      # compiles all 7 packages
```

Compile the hello-world corpus:

```bash
cd examples/hello-world
bun ../../scripts/build-atom-dirs.ts --src primes/sources --out primes/compiled
# [build] 5 atoms compiled
# [build] L1 checks: PASS
# [build] L3 checks: PASS · 0 cycles · 0 contradictions
# [build] emitted 5 atom dirs to primes/compiled
# done in ~80ms
```

What just happened:
- The parser read 5 `.prime` files
- The L1 checker confirmed each declared the required fields for its kind
- The edge resolver wired up the 7 cross-references and confirmed all targets exist
- The chunker emitted `summary.md`, `core.md`, `full.md` for each atom
- The atom-dir emitter created one directory per atom, plus `_index.xml`

Inspect what's there:

```bash
prime list
# @example/fact-water-boils-at-100c    fact     "Pure water boils at 100°C at 1 atm."
# @example/term-celsius                term     "The Celsius temperature scale."
# @example/rule-altitude-affects-boiling rule  "Boiling point drops ~0.5°C per 150m elevation."
# @example/method-make-tea             method   "Heat water to 100°C, steep leaves 3-5min."
# @example/collection-tea-basics       collection "Bundles the four atoms above."
```

Read an atom's details:

```bash
prime show @example/method-make-tea
# id:      @example/method-make-tea
# kind:    method
# version: 1.0.0
# ...related refs listed below...
```

Walk the edge graph for a source file:

```bash
prime graph primes/sources/@example/method-make-tea.prime
# ┌──────────────────────┐
# │  method-make-tea     │
# ├── REQUIRES ──→ fact-water-boils-at-100c
# ├── REQUIRES ──→ term-celsius
# └── ENHANCES - -→ rule-altitude-affects-boiling
```

That's the entire feedback loop without an agent: write atoms, compile,
inspect.

---

## 5-minute full loop with an agent

Boot the generic MCP server against the corpus:

```bash
PRIME_DIR=primes/compiled bun ../../packages/mcp-server-core/src/index.ts
# [prime-mcp-core] Loading corpus index...
# [prime-mcp-core] 5 atoms · 712 tokens · 1 clusters
# [prime-mcp-core] domains: 0 (no domain.yaml found — plain ranking active)
# [prime-mcp-core] ready · tool: prime_query · stdio transport active
```

The server speaks Model Context Protocol on stdio. Any MCP-compatible
client — including Claude Code — can call the `prime_query` tool.
There is no separate CLI query command; queries go through the MCP tool.

---

## Wiring into Claude Code

Add to your `.claude/config.json` (or wherever you configure MCP
servers):

```json
{
  "mcpServers": {
    "skill-wiki": {
      "command": "bunx",
      "args": ["@prime-lang/mcp-server-core"],
      "env": { "PRIME_DIR": "/abs/path/to/your/compiled" }
    }
  }
}
```

Restart your agent. The tool `prime_query` will appear in the agent's
tool list. From inside a session:

> *Use prime_query to find atoms about making tea, then write a recipe.*

The agent calls `prime_query("make tea")`, gets back atom IDs at chosen
levels, calls `Read` on the chunk paths, and synthesizes a recipe from
the typed inputs.

You'll find the agent's prompts get visibly tighter with this wired in
— no more guessing at exact values from memory; the agent reads
`chunks/full.md` for the relevant atom and quotes the field directly.

---

## Try a bigger corpus

Once hello-world works, you have two paths:

### Path A — Write your own corpus (recommended starting point)

A 5-atom corpus is roughly 30 minutes to write. See
[corpus-authoring.md](./corpus-authoring.md) for the walkthrough and the
[DSL quick reference](./dsl-quickref.md) for the syntax.

A typical first corpus (team coding standards):

```
my-corpus/
├── primes/sources/@my/
│   ├── rule-no-any-types.prime
│   ├── rule-imports-sorted.prime
│   ├── rule-tests-required.prime
│   ├── pattern-react-component.prime
│   └── method-pull-request.prime
└── package.json
```

Or, pick your own domain — security policies, GDPR clauses, recipe
methods, SRE runbooks. The protocol makes no assumption about content
type.

Then `bun scripts/build-atom-dirs.ts --src primes/sources --out primes/compiled` and you're
running.

### Path B — Pull the frontend-design corpus

The 899-atom frontend-design corpus ships in a separate repo. This is
**one example** of what a production Skill Wiki corpus looks like; its
design-domain conventions (`register`, `motion_priority`, 6-axis
retrieval, HTML output validator) are specific to that domain and not
part of the protocol.

```bash
git clone https://github.com/skill-wiki/prime-corpus-frontend.git
cd prime-corpus-frontend
bun install
bun run build           # compiles the 899 atoms
PRIME_DIR=compiled bun ../prime-system/packages/mcp-server-core/src/index.ts
```

This corpus has its own MCP wrapper (5 tools instead of 1, with intent
classification and 6-axis retrieval). See
[the corpus repo's README](https://github.com/skill-wiki/prime-corpus-frontend)
for the wired-up integration.

---

## Common gotchas

| Symptom | Cause | Fix |
|---|---|---|
| `Unknown option: --experimental-transform-types` | Node version too old | Upgrade to Node 22+ |
| `Cannot find module '@prime-lang/types'` | Packages not built | Run `bun run build` from repo root |
| `parse error: unexpected token at line 12` | Syntax error in .prime file | Run `prime check <file>` for the precise location |
| `unresolved reference: @example/foo` | Atom ID typo or atom not in corpus | Check the `id:` line in the target atom; ensure file is in the source dir |
| `[L3] cycle detected: A → B → A` | Two atoms `requires` each other | Pick one direction; replace the other with `enhances` |
| `[L3] contradicts edge between active atoms` | Two atoms claim opposing things and both are active | Mark one `deprecated` or remove the contradicts edge if intentional |
| Empty `chunks/full.md` for a persona | Chunker doesn't know about a custom field | Filed as known limitation — see [ROADMAP.md](../ROADMAP.md). Add field name to chunker include-list. |
| `prime_query` returns nothing | Index not loaded / wrong --corpus path | Confirm `_index.xml` exists in the path |
| MCP server starts but agent can't see the tool | MCP transport mismatch / server not registered in agent config | Check agent's MCP server logs for connection errors |
| L2 semantic check is slow | Each atom triggers an LLM call | Set `PRIME_L2_BATCH=true` to batch (faster) or unset `DEEPSEEK_API_KEY` to skip entirely |

---

## Day-2 troubleshooting

```bash
# Just one .prime file — fastest feedback during authoring
prime check path/to/atom.prime

# What does this atom reference?
prime show @scope/atom-id
prime show @scope/atom-id --json    # machine-readable

# What edges does a source file declare?
prime graph path/to/atom.prime

# What's required transitively if I load this atom?
prime deps @scope/atom-id

# Recompile the full source directory
bun scripts/build-atom-dirs.ts --src primes/sources --out primes/compiled

# Verbose build for diagnostics
bun scripts/build-atom-dirs.ts --src primes/sources --out primes/compiled --verbose
```

---

## Where to go next

| If you want to … | Go to |
|---|---|
| Understand the design | [architecture.md](./architecture.md) |
| Understand the *why* | [philosophy.md](./philosophy.md) |
| Write atoms | [dsl-quickref.md](./dsl-quickref.md) and [corpus-authoring.md](./corpus-authoring.md) |
| Use the CLI | [cli.md](./cli.md) |
| Configure the MCP server | [mcp.md](./mcp.md) |
| Publish your corpus | [registry.md](./registry.md) |
| Compare to RAG / Skills / etc. | [comparison.md](./comparison.md) |
| Read the protocol spec | [PRIME-PROTOCOL-v1.md](../spec/PRIME-PROTOCOL-v1.md) |

---

## A note on what you've seen

The 30-second loop is the entire system, in miniature:

1. **Authoring** — five `.prime` files, plain text, version-controlled
2. **Compile** — parser + L1 + L3 + chunker + emitter
3. **Runtime** — load the index, walk the graph
4. **Query** — retrieve by ID, project at the right level

Every Skill Wiki corpus, regardless of size, runs the same loop. The
899-atom frontend corpus differs from the 5-atom hello-world only in
volume — same parser, same compiler, same runtime.

If something in this guide doesn't behave as described, file a bug. The
guide is wrong before the code is.
