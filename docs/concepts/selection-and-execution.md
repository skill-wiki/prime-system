# Selection and execution

Reading knowledge and changing state are separate contracts in Kernary.

## Selection Plan

A query request is evaluated against an external Retrieval Profile. Candidate
generators may use lexical, facet, graph, or plugin-provided signals. Features,
hard constraints, soft constraints, relation semantics, reranking, projection
choice, load order, and token budget produce a Selection Plan.

The plan records selected Units, score contributions, constraint decisions,
relation expansion or exclusion, projection loads, budget use, and diagnostics.
Visibility is enforced before candidate providers receive data so a private Unit
cannot leak through a relation or score.

## Execution Plan

An Action starts from a model declaration and a Request Context. The runtime
validates inputs, principal, capability, preconditions, provider binding,
side-effect class, idempotency, and policy. Preflight returns an Effect Plan
without executing the provider.

Execution proceeds only after required policy or human approval. The run and its
evidence are appended to the Event Store so in-flight, awaiting-approval,
completed, failed, timed-out, and replayed states remain distinguishable.

## The boundary

A Selection Plan can recommend a Unit or Action. It cannot grant the capability
to execute it. A Skill can teach an Agent when to request an Action. It cannot
bypass the Action Runtime.
