# Connect an Agent

Connect an Agent only after you have a verified bundle and the exact Model
Package that produced its lock.

## MCP

The generic MCP server reads a compiled snapshot. It does not compile source and
does not import a domain package implicitly.

```bash
PRIME_DIR=/absolute/path/to/corpus/dist \
PRIME_MODEL_DIR=/absolute/path/to/model \
bun packages/mcp-server-core/src/index.ts
```

Both paths are currently exposed through compatibility environment names. The
server fails closed when the model lock, manifest, or content digest does not
match.

## HTTP and embedded SDK

The HTTP server and SDK expose the same snapshot, plan, query, resource, action,
and event contracts. Choose a transport for deployment reasons; do not copy
domain logic into a transport wrapper.

Before production use, bind authentication, a Request Context, tenant and
workspace identity, and only the action providers required by that deployment.
An unbound provider or missing policy is a refusal, not an empty success.

## Optional Skill

A Domain Package may include a Skill that explains its query profiles, tools,
or authoring workflow to an Agent. The Skill is optional. SDK, MCP, and HTTP
clients remain complete without it.
