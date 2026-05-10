# MCP server

This page is about `packages/mcp-server-core/` — the **generic** MCP
server that ships in this repo. It is deliberately small (~200 lines)
and exposes a single tool, `prime_query`, over any compiled Prime
corpus.

If you want a richer, domain-aware MCP — multiple tools, intent
classification, multi-axis retrieval — that lives in the corpus repo,
not here. Pointer at the bottom of this page.

---

## What problem does this solve

A compiled corpus is a directory tree:

```
compiled-v3-final/
├── _index.xml                       # the agent's main view (~3 KB)
├── @community/
│   ├── persona-stripe/
│   │   ├── summary.md               # ~30 tokens
│   │   ├── core.md                  # ~150 tokens
│   │   ├── full.md                  # ~400 tokens
│   │   └── meta.json                # edges + tags + version
│   ├── pattern-card-elevated/...
│   └── …
```

The agent doesn't get this filesystem; it gets a process running on
stdio that exposes one tool. The tool returns paths or content
projections. The agent then uses its own `Read` tool to pull whichever
file it picked.

That inversion is the whole point — **the MCP server returns pointers,
the agent dereferences them**. There is no need to stream all atom
content through the MCP boundary. The boundary is structural.

---

## Tool surface — `prime_query`

```typescript
prime_query({
  scope: "atoms" | "related" | "scout" | "template",
  query?: string,    // free text — used by atoms / scout
  id?: string,       // atom id — used by related / template
  level?: "summary" | "core" | "full",   // default "summary"
  depth?: number,    // for related; default 1
  limit?: number,    // default 20
}) → {
  results: Array<{
    id: string,                  // "@community/persona-stripe"
    kind: string,                // "persona"
    level: "summary" | "core" | "full",
    path: string,                // absolute path to the projection .md
    summary?: string,            // inlined when level === "summary"
  }>;
  count: number;
  hint?: string;                 // optional next-step suggestion
}
```

The four scopes:

| Scope | What it does | Typical agent use |
|---|---|---|
| `atoms` | Lexical / tag match against the index. | First call when the agent has a query string. |
| `related` | Walk the edge graph from `id`, depth-limited. | Once a primary atom is picked, find neighbors. |
| `scout` | Returns a tiny set of "good starting points" — `persona`, `principle`, `pattern` atoms that hint at the corpus shape. | Cold start when the agent doesn't know the corpus. |
| `template` | Return a `template`-kind atom in `full` projection. | When a brief asks for scaffolding. |

No mutation. No retrieval-side embedding. Everything is structural —
edge walks, kind filters, simple substring match against the index.

---

## What the server actually loads

```bash
PRIME_DIR=/abs/path/to/compiled bunx @prime-lang/mcp-server-core
# or, during local development directly from source:
PRIME_DIR=/abs/path/to/compiled bun packages/mcp-server-core/src/index.ts
```

On boot:

1. Read `<corpus>/_index.xml` into memory (a few KB).
2. Lazily resolve `<corpus>/<scope>/<name>/<level>.md` only when
   `prime_query` returns a path.
3. Maintain an in-memory adjacency map for `related` traversal.

That's it. There is no DB, no embedding store, no warming step. Boot
time on a 900-atom corpus is ~80 ms.

```bash
$ PRIME_DIR=./compiled-v3-final bunx @prime-lang/mcp-server-core
[prime-mcp-core] 899 atoms · 51234 tokens · 12 clusters
[prime-mcp-core] ready · tool: prime_query · stdio transport active
```

---

## Wiring into Claude Code

`.mcp.json` at the project root:

```json
{
  "mcpServers": {
    "skill-wiki": {
      "command": "bunx",
      "args": ["@prime-lang/mcp-server-core"],
      "env": {
        "PRIME_DIR": "/abs/path/to/compiled-v3-final"
      }
    }
  }
}
```

After Claude Code restarts the MCP host, the tool appears as
`mcp__skill-wiki__prime_query`. The agent calls it with `scope: "atoms"`
and receives a list of paths; it then uses its own `Read` tool to
fetch the specific projection it wants.

A typical first turn looks like:

```
agent → prime_query({ scope: "atoms", query: "warm institutional" })
       ← { results: [{ id: "@community/persona-stripe", ...,
                        path: "/.../@community/persona-stripe/summary.md" }] }
agent → Read("/.../@community/persona-stripe/summary.md")
       ← "Stripe register — restrained color, generous type..."
agent → prime_query({ scope: "related",
                      id: "@community/persona-stripe",
                      depth: 1 })
       ← { results: [{ id: "@community/rule-contrast-aaa", ...,
                        path: "/.../@community/rule-contrast-aaa/core.md" }, …] }
agent → Read(...) on the ones it needs
```

The agent reads the full content; the MCP boundary only ever passes
paths and tiny summary strings. Bandwidth and token cost are bounded
by the agent's reading discipline, not by the server.

---

## Wiring into other MCP-speaking agents

The MCP protocol is JSON-RPC over stdio (or SSE). Any client that
speaks it works.

**Continue** (`config.yaml`):

```yaml
mcpServers:
  - name: skill-wiki
    command: bunx
    args: ["@prime-lang/mcp-server-core"]
    env:
      PRIME_DIR: /abs/path/to/compiled
```

**Cline / Cursor / any custom runtime**: spawn `bunx @prime-lang/mcp-server-core`
as a subprocess with `PRIME_DIR` set, and send JSON-RPC framed by
`Content-Length`. The `mcp-server-core` package depends on the upstream
`@modelcontextprotocol/sdk` so any client conforming to MCP v1 protocol works.

**Programmatic** (your own runtime):

```typescript
import { spawn } from "child_process";
import { Client } from "@modelcontextprotocol/sdk/client";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio";

const transport = new StdioClientTransport({
  command: "bunx",
  args: ["@prime-lang/mcp-server-core"],
  env: { ...process.env, PRIME_DIR: "/abs/path/to/compiled" },
});
const client = new Client({ name: "my-agent", version: "0.1.0" }, {});
await client.connect(transport);

const out = await client.callTool({
  name: "prime_query",
  arguments: { scope: "atoms", query: "warm institutional", limit: 5 },
});
console.log(JSON.parse(out.content[0].text));
```

---

## The "agent reads paths" model

The single most important design choice in this server: **content is
not in the tool response**. The tool returns a path (or, for `summary`
level, a few-token snippet). The agent, which already has a `Read`
tool, fetches what it actually needs.

Why this matters:

1. **Bounded MCP traffic.** A `prime_query` call is a few hundred
   bytes regardless of how many atoms match. The token cost lives in
   the agent's later `Read` calls, where it has full visibility and
   can stop reading when it has enough.
2. **No projection coupling.** The server doesn't know what
   "appropriate level" is for a given turn — only the agent does.
   Returning paths lets the agent freely pick `summary` vs `core` vs
   `full` per atom.
3. **Caches naturally.** Filesystem reads cache; MCP responses don't
   need to.
4. **Composes with other tools.** The agent can pipe a `prime_query`
   result into `Grep`, `Edit`, anything else in its toolbelt. The
   atoms are just files.

The inversion is what makes a 200-line server enough.

---

## What this server does NOT do

- **No intent classification.** "Brief in → IntentObject out" is a
  domain concern. The frontend corpus has it; the generic core
  doesn't.
- **No multi-axis retrieval.** Picking "register, pattern, motion,
  type, color, rules" axes for a frontend brief is domain-specific
  composition logic. The generic `prime_query` returns whatever the
  query string and edge graph say; ranking against axes is for a
  wrapper.
- **No L5 output validation.** A validator runtime (`packages/validator-core/`,
  not in v0.1.0) is a separate concern; the MCP server does not import it.
- **No write path.** Atoms are immutable from the MCP side. To author,
  edit `.prime` source and re-`prime compile`.
- **No auth.** stdio transport is local-trust by default. If you want
  remote MCP with auth, run the server behind an SSE bridge with your
  own auth layer; the core doesn't ship one.

---

## Domain-specific MCP wrappers

The frontend corpus repo (`prime-corpus-frontend`) ships a richer
server that **wraps** `mcp-server-core` and adds five tools (per
`FRONTEND-DESIGN-DOMAIN-v1.md` §5):

| Tool | What it adds over the generic core |
|---|---|
| `prime_compile` | Brief → IntentObject → 6-axis retrieval plan with `must_include` / `must_avoid` contract. |
| `prime_query` | Same shape as the core; the wrapper extends `scope` with frontend-specific values like `mandate`, `checklist`, `gallery`. |
| `prime_intent` | Layer 1 only — `brief → IntentObject` without retrieval. |
| `prime_resolve` | atom id + projection level → full content. |
| `prime_validate` | Layer 5 — validate generated HTML against a contract. |

These tools encode frontend-design domain rules. They are not part of
the protocol. Build your own wrapper for your own domain — see
[corpus-authoring.md](./corpus-authoring.md) §6.

The system repo stops at `prime_query`. That single tool, plus `Read`, is
enough to express any read-only retrieval pattern over a Prime corpus.

---

## Operational notes

- **Logs go to stderr** (the server emits structured boot lines to stderr;
  stdout is reserved for MCP framing).
- **Reload on corpus change** is not automatic — restart the server
  after `prime compile`. A file-watcher mode is on the roadmap.
- **Multiple corpora**: register multiple servers in `.mcp.json`, each
  with a different name (`skill-wiki-frontend`, `skill-wiki-cooking`,
  …). They don't share state.
- **Memory**: a 1000-atom corpus uses ~6 MB resident. The server is
  fine to leave running.
- **Crash semantics**: the server is stateless. If it dies, restart
  it; nothing on disk is at risk.

---

## Quick smoke test

```bash
# Boot (from the prime-system repo root)
$ PRIME_DIR=examples/hello-world/primes/compiled \
    bun packages/mcp-server-core/src/index.ts &
[prime-mcp-core] 5 atoms · 348 tokens · 1 clusters
[prime-mcp-core] ready · tool: prime_query · stdio transport active

# Send one tool call (use any MCP client; this snippet uses the SDK)
$ node --experimental-transform-types <<'EOF'
import { Client } from "@modelcontextprotocol/sdk/client";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio";

const transport = new StdioClientTransport({
  command: "bun",
  args: ["packages/mcp-server-core/src/index.ts"],
  env: { ...process.env, PRIME_DIR: "./examples/hello-world/primes/compiled" },
});
const client = new Client({ name: "smoke", version: "0.1.0" }, {});
await client.connect(transport);

const r = await client.callTool({
  name: "prime_query",
  arguments: { scope: "atoms", query: "tea", limit: 3 },
});
console.log(r.content[0].text);
EOF

# Expected:
# {
#   "results": [
#     {
#       "id": "@example/method-make-tea",
#       "kind": "method",
#       "level": "summary",
#       "path": "/.../@example/method-make-tea/summary.md",
#       "summary": "Heat water to 100°C, steep leaves 3-5min."
#     },
#     ...
#   ],
#   "count": 2
# }
```

If you see `"count": 0`, your `--corpus` path probably points at the
`primes/sources/` dir instead of `primes/compiled/`. The server only
reads compiled output.

---

## Pointer

- `docs/cli.md` — how to compile a corpus.
- `docs/corpus-authoring.md` §6 — when (and how) to write a domain-specific
  MCP wrapper around this core.
- `spec/FRONTEND-DESIGN-DOMAIN-v1.md` §5 — the frontend corpus's 5-tool surface,
  documented here for cross-reference (those tools live in
  `prime-corpus-frontend`, not in this repo).
