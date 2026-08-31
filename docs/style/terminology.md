# Kernary terminology

Use these terms consistently in current documentation.

| Term | Meaning |
|---|---|
| Kernary | The product and engine family |
| Agent Knowledge Runtime | Product category, not a protocol identifier |
| Model Package | External domain schema and behavior declarations |
| Corpus Package | External units, assets, provenance, and release policy |
| Adapter Package | External source or provider integration |
| Domain Package | Composition of model, corpus, adapters, tools, and optional Skills |
| Unit | Domain-neutral source/IR item |
| Projection | Model-defined view of a unit |
| Snapshot | Immutable compiled corpus release with verified identity |
| Selection Plan | Query result with scores, constraints, relations, load order, and budget |
| Execution Plan | Preflighted action effects and required approvals |
| Action | Model-declared, policy-gated operation |

## Compatibility terms

- **Prime**: use only for the `.prime` format, `prime/*` protocol identifiers,
  the legacy CLI alias, or a named historical document.
- **Skill Wiki**: use only for the former brand, current unrenamed remote/npm
  location, or a redirect source.
- **Atom**: use when a specific external model or v1 compatibility model declares
  it. Core operates on Unit IR.
- **Skill**: use for an optional Agent-facing workflow, never as the engine's
  schema or universal package unit.
- **Registry**: the discovery and distribution service for model, corpus,
  adapter, domain, and plugin packages. Do not call every entry a Prime.

## Avoid in current guides

- “28 kinds” or “14 verbs” without naming the v1 compatibility model.
- `domain.yaml` as the current extension mechanism.
- Frontend Design's retrieval axes or tools as generic runtime behavior.
- “MCP-native” when the same engine also supports embedded SDK and HTTP.
- “production-ready” without a named release support policy.
