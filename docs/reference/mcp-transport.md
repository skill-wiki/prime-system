# MCP transport

`@skill-wiki/mcp-server-core` is the currently published compatibility package
for Kernary's generic MCP transport. It mounts one compiled snapshot and its
exact Model Package.

```bash
PRIME_DIR=/absolute/path/to/corpus/dist \
PRIME_MODEL_DIR=/absolute/path/to/model \
bun packages/mcp-server-core/src/index.ts
```

The environment names and `prime_*` tool prefix remain stable during v0.2.

## Tools

- `prime_query` runs a model-declared Retrieval Profile and returns selected
  projections plus the decisions that produced them.
- `prime_plan` returns the same selection arithmetic without rendering
  projections.
- `prime_resource` reads one exact projection through the runtime instead of
  asking the Agent to interpret a path.

All three tools have explicit input schemas. A request without a retrieval
signal, an unavailable profile SPI, a visibility violation, a missing
projection, or a model/bundle identity mismatch returns a refusal or diagnostic;
it is not converted into a zero-result success.

Domain Packages may expose additional model-projected tools. Those tools compose
the generic runtime; they do not replace it or add their schema to Core.
