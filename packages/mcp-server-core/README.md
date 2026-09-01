# AOE MCP transport

`@aoe/mcp-server-core` provides AOE's Agent Ontology Engine transport. It
mounts a compiled Corpus snapshot and
the exact external Model Package bound by `model.lock`.

```bash
AOE_CORPUS_DIR=/absolute/path/to/corpus/dist \
AOE_MODEL_DIR=/absolute/path/to/model \
bunx @aoe/mcp-server-core
```

The package installs the `aoe-mcp` executable. Environment variables and tool
names use the AOE protocol surface.

## Tools

- `aoe_query`: execute a model-declared Retrieval Profile and render selected
  projections.
- `aoe_plan`: return the same selection decisions without rendering.
- `aoe_resource`: read one exact verified projection.

The transport returns explicit refusals for unavailable profile providers,
visibility violations, invalid requests, missing projections, and Model/Snapshot
identity mismatches. Domain Packages may project additional tools without adding
their schema to AOE Core.

See [MCP transport](../../docs/reference/mcp-transport.md). Apache-2.0.
