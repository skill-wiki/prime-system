# Connect an Agent

This guide gets an Agent from “I have a domain package” to “I can ask a
question and receive a verified answer”. The same Runtime can be embedded in a
process, mounted as an MCP server, or exposed over HTTP.

## Before you start

You need two things built from the same release:

- a Model Package that declares the types, relations, projections, and actions;
- a compiled Corpus Snapshot with its manifest, lock, and (if required) signature.

If the model and bundle do not match, AOE refuses to start. This is easier
to fix before an Agent connects than after it has cached a result.

## MCP: connect in one command

The generic MCP server reads compiled artifacts. It does not compile source on a
request and it does not guess which domain package you intended.

```bash
AOE_CORPUS_DIR=/absolute/path/to/corpus/dist \
AOE_MODEL_DIR=/absolute/path/to/model \
bun packages/mcp-server-core/src/index.ts
```

The server exposes three core tools:

| Tool | Use it for |
|---|---|
| `aoe_query` | Retrieve projections for a natural-language request |
| `aoe_plan` | Inspect ranking, constraints, relations, and budget without loading content |
| `aoe_resource` | Resolve one exact projection URI |

Every request is checked against the loaded Model and Snapshot. A missing
retrieval signal, unknown projection, visibility violation, unavailable
provider, or digest mismatch returns a diagnostic/refusal instead of an empty
success.

### MCP client configuration

Point your MCP client at the server and pass the two absolute paths through its
environment configuration. Keep the Model path and Corpus path from the same
release; do not silently swap one while leaving the other pinned.

## Embedded SDK

Use the SDK when the Agent and Runtime live in the same process. The client
surface is intentionally small:

```ts
const client = new PrimeClient({ transport });

const plan = await client.plan({
  corpus: 'com.example/support',
  query: 'open incidents affecting checkout',
  topK: 8,
  projection: 'core',
});

const result = await client.query({
  corpus: 'com.example/support',
  query: 'open incidents affecting checkout',
  topK: 8,
  projection: 'core',
});
```

`plan()` and `query()` use the same selection contract. `preflight()` and
`execute()` use the Action contract and never inherit permission from a query.
`events(runId)` returns the append-only evidence for an execution.

## HTTP

Use HTTP when the Agent runs separately from the Runtime or when several
clients share one activated Snapshot. Bind authentication, tenant/workspace
identity, and the action providers required by that deployment. Keep the
service loopback-only until the bearer and policy configuration is ready.

The HTTP surface mirrors the SDK: snapshot, plan, query, resource, preflight,
execute, and events. A transport changes how bytes travel, not what a relation,
constraint, or Action means.

## Add a domain Skill only when it helps

A Domain Package may include a Skill that teaches an Agent the best questions to
ask, the package's terminology, or a workflow for authoring new Units. The Skill
is a guide at the edge. Model declarations, Snapshot verification, Query
constraints, and Action authorization remain enforced by the Engine.

## Production checklist

- Pin the Model version and schema digest in the release lock.
- Require a manifest and signature for production snapshots.
- Set an explicit tenant and workspace Request Context.
- Register only the Action providers this deployment needs.
- Exercise preflight and dry-run before allowing effectful execution.
- Store run, policy, approval, and effect evidence in an Event Store.
- Alert on digest mismatch, unavailable providers, and repeated authorization
  failures.
