# Kernary MCP transport

`@skill-wiki/mcp-server-core` is the currently published compatibility package
for Kernary's generic MCP transport. It mounts a compiled Corpus snapshot and
the exact external Model Package bound by `model.lock`.

```bash
PRIME_DIR=/absolute/path/to/corpus/dist \
PRIME_MODEL_DIR=/absolute/path/to/model \
bunx @skill-wiki/mcp-server-core
```

The package installs `kernary-mcp` and the compatibility alias
`prime-mcp-core`. Environment variables and tool names remain compatibility
identifiers in v0.2.

## Tools

- `prime_query`: execute a model-declared Retrieval Profile and render selected
  projections.
- `prime_plan`: return the same selection decisions without rendering.
- `prime_resource`: read one exact verified projection.

The transport returns explicit refusals for unavailable profile providers,
visibility violations, invalid requests, missing projections, and Model/Snapshot
identity mismatches. Domain Packages may project additional tools without adding
their schema to Kernary Core.

See [MCP transport](../../docs/reference/mcp-transport.md). Apache-2.0.
