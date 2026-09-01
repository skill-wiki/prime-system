# ADR 0001: AOE is the product; domain semantics stay external

- Status: accepted
- Date: 2026-08-31
- Decision owner: product maintainer

## Decision

The product is named **AOE**. Its category is **Agent Ontology Engine**.

AOE compiles external domain ontologies and corpora into versioned runtimes
that agents and applications can query, plan against, and act through. The engine owns the declaration
meta-schema, stable IR, compilation contracts, snapshot verification, query and
action runtimes, SDKs, transports, and conformance tools. It does not own a
production ontology or corpus.

The public description is:

> AOE compiles domain models and corpora into versioned runtimes agents can
> query, plan against, and act through.

The short category line is:

> An Agent Ontology Engine for domain-aware software.

## Package boundary

- A **Model Package** defines types, fields, relations, projections, retrieval
  profiles, actions, policies, and validators.
- A **Corpus Package** defines units, assets, provenance, licence policy, and
  release identity.
- An **Adapter Package** connects external sources or providers.
- A **Domain Package** may compose a model, corpus, adapters, tools, and optional
  Agent Skills.
- A **Skill** is an optional Agent-facing workflow. It is not Core schema, a
  publication unit, or an authorization mechanism.

Frontend Design is a reference Domain Package. Ticket, Recipe, Security, and any
future examples have the same architectural status. None is built into Core.

## Compatibility names

The name change does not silently rewrite stable identities.

- `.prime` remains the source extension during the v0.2 compatibility window.
- Existing `prime/*` protocol identifiers remain valid until a versioned
  migration defines replacements.
- `prime` remains a CLI alias while `aoe` becomes the preferred command.
- Published `@aoe/*` packages remain compatibility packages until the
  `@aoe/*` scope is created and dual publishing is verified.
- Existing GitHub repositories and Pages URLs keep their current remote names
  until external rename and redirect operations are completed.

Documentation must label these as compatibility surfaces. It must not describe
AOE or Prime System as the current product.

## Repository target names

The intended remote layout is:

```text
aoe-engine
aoe-frontend-design
aoe-registry
aoe-docs
aoe-workspace
```

Local submodule paths are not renamed before their remotes exist. This avoids a
workspace-only rename that breaks clone and update instructions.

## Consequences

- Public documentation starts from packages, snapshots, selection, and action;
  it no longer starts from Atom or Skill decomposition.
- Domain schemas and fixed kind/relation counts can appear only in a named model
  or compatibility appendix.
- The website treats Frontend Design as a case study, not a flagship built-in.
- Reference documentation is owned by the repository that owns the code or
  schema. The website renders versioned documentation artifacts instead of
  maintaining a second handwritten reference.
- Remote organization, domain, npm scope, and redirect work remains an explicit
  release operation with separate verification.

## Rejected alternatives

- **AOE** describes a narrower, mostly read-only product and overstates
  the role of Skills.
- **Prime** is retained for compatibility but is too overloaded to distinguish
  the current product.
- **RunTome** and **Noetrail** were considered during naming. AOE was selected
  for a more infrastructure-oriented identity.
