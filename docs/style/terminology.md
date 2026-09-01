# Kernary terminology

Use these terms consistently in current documentation.

| Term | Meaning |
|---|---|
| Kernary | The product and engine family |
| Model-driven Ontology Engine | Product category; Kernary's external model compiler and runtime |
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

## Use these distinctions

- **Unit** is the neutral runtime item. A Model Package may give a Unit a more
  specific type name; Core does not need to know that name in advance.
- **Skill** is an optional Agent-facing workflow. It is not a schema, a package
  boundary, or an authorization mechanism.
- **Registry** is the discovery and distribution service for Model, Corpus,
  Adapter, Domain, and Plugin Packages.
- **Domain Package** is the product boundary that a reader or Agent installs;
  Engine packages are its implementation layers.

Avoid presenting one example domain's type counts, retrieval axes, or tools as
universal behavior. State the owning Package when a detail is domain-specific.
