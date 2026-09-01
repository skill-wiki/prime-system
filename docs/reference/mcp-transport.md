# MCP transport

AOE's MCP transport exposes a compiled Model + Corpus snapshot to any MCP
client. It is a thin transport: the Model Package owns domain vocabulary and the
Query/Action runtimes own semantics.

```bash
AOE_CORPUS_DIR=/absolute/path/to/corpus/dist \
AOE_MODEL_DIR=/absolute/path/to/model \
bun packages/mcp-server-core/src/index.ts
```

## Core tools

- `aoe_query` runs the Model-declared retrieval profile and returns selected
  projections plus the decisions that produced them.
- `aoe_plan` returns the same selection arithmetic without rendering
  projections.
- `aoe_resource` resolves one exact projection URI through the Runtime.

All tools advertise explicit input schemas. Requests fail loudly when the
retrieval signal is missing, a profile provider is unavailable, a projection is
unknown, visibility is denied, or the Model and Bundle identities disagree.
Returning an empty list would hide a deployment error, so it is not used as a
fallback.

## Mounting more than one corpus

An embedded host can create one server per mounted snapshot or compose the
snapshots through the SDK/HTTP host. Keep tenant, workspace, corpus, release,
and model identity explicit in the host configuration; do not infer them from a
directory basename.

## Domain tools

A Domain Package may add Model-projected tools for its own providers. Those tools
call the same Runtime and policy boundaries; they do not replace the generic
query/resource tools or move domain schema into Core.
