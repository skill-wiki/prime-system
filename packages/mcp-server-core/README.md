# @skill-wiki/mcp-server-core

Generic [Model Context Protocol](https://modelcontextprotocol.io) server for any compiled [Prime](https://github.com/skill-wiki/prime-system) corpus. Exposes a single tool — `prime_query` — that browses atoms, traverses the edge graph, and returns projection-level paths the agent reads on demand.

The server **never returns atom body content**. It returns paths. The agent uses its own Read tool to load the projection (`summary`, `core`, or `full`) it actually needs.

## Install

```sh
npm install -g @skill-wiki/mcp-server-core
# or run on demand: npx @skill-wiki/mcp-server-core
```

Requires Node.js >= 22.

## Wire into Claude Code

```jsonc
{
  "mcpServers": {
    "skill-wiki": {
      "command": "npx",
      "args": ["@skill-wiki/mcp-server-core"],
      "env": { "PRIME_DIR": "/abs/path/to/compiled" }
    }
  }
}
```

`PRIME_DIR` must point at a directory containing `_index.xml` (the output of `prime compile`).

## Tool surface

```ts
prime_query({
  scope: "atoms" | "related" | "show",
  query?: string,             // for scope=atoms
  id?: string,                // for scope=related|show
  level?: "summary" | "core" | "full",
  kind?: string,
  limit?: number,
})
```

## License

Apache-2.0
