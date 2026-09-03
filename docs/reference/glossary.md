# Glossary

Terms used across the AOE documentation, with the page that defines each one in
full.

## Product and packages

**AOE** — the product and engine family. Short for Agent Ontology Engine.

**Agent Ontology Engine** — the product category: a compiler and runtime for
external domain models and corpora. See [What AOE is](../concepts/what-is-aoe.md).

**Model Package** — external declarations of a domain's schema and behaviour:
types, fields, relations, projections, retrieval profiles, functions, actions,
policies, validators, and migrations. See
[Package model](../concepts/package-model.md).

**Corpus Package** — external units, assets, provenance, licence policy, and
release configuration published against a model range.

**Adapter Package** — an external source or provider integration. It can add an
importer, search provider, validator, evaluation provider, or action provider,
and it cannot add a type or relation to the model.

**Domain Package** — the deployable composition of model, corpus, adapters,
optional tools, and optional Skills. This is the boundary a reader or Agent
installs.

**Registry** — the discovery and distribution service for Model, Corpus,
Adapter, Domain, and Plugin Packages. The public site is a static discovery
page rather than a Registry API.

## Content and compilation

**Unit** — the domain-neutral source and IR item. A Model Package may give a
Unit a more specific type name; Core does not need to know that name in
advance.

**Projection** — a model-defined view of a Unit. Levels such as `summary`,
`core`, and `full` each carry a token target.

**Snapshot** — an immutable compiled corpus release with verified identity. See
[Compilation and snapshots](../concepts/compilation-and-snapshots.md).

**Snapshot identity** — the binding of tenant, corpus, release, and content
digest that the runtime recomputes before serving.

**model.lock** — the generated record of the exact resolved model version and
schema digest a corpus was compiled against. Never edit it by hand.

**Manifest** — the generated `corpus.manifest.json` describing a release and its
digests. Also generated, also never hand-edited.

**IR** — the stable intermediate representation the compiler emits. Core fixes
the IR and the declaration meta-schema; everything domain-specific stays in
packages.

## Query and execution

**Retrieval Profile** — the model-declared configuration of candidate
generators, features, constraints, and rerankers that a query is evaluated
against.

**Selection Plan** — the query result. It records selected Units, score
contributions, constraint decisions, relation expansion or exclusion, projection
loads, budget use, and diagnostics. See
[Selection and execution](../concepts/selection-and-execution.md).

**Action** — a model-declared, policy-gated operation. It defines input, output,
capabilities, preconditions, policy, approval mode, idempotency, and evidence.

**Execution Plan** — the preflighted effects and required approvals returned
before an Action runs. Also called an Effect Plan.

**Principal** — the identity on whose behalf a request is made.

**Capability** — the permission required to request a specific Action.

**Idempotency** — the guarantee that a repeated Action call with the same key
does not repeat its effect.

**Event Store** — the append-only record of Action runs and their evidence, which
keeps in-flight, awaiting-approval, completed, failed, timed-out, and replayed
states distinguishable.

**Evidence** — the retained proof of what an Action did and what authorized it.

## Agent-facing

**Skill** — an optional Agent-facing workflow or instruction layer. A Skill can
teach an Agent when to request an Action. It is not a schema, a package
boundary, or an authorization mechanism, and it cannot bypass the Action
runtime.

**MCP** — Model Context Protocol, one of the three transports. See
[MCP transport](./mcp-transport.md).

**Transport** — how a client reaches the runtime: embedded SDK, MCP, or HTTP.
All three share the same query, plan, and action contracts. See
[HTTP and Registry](./http-and-registry.md).

## Distinctions worth keeping

A **Unit** is the neutral runtime item, while a type name is a Model Package
concern. A **Selection Plan** can recommend an Action but cannot grant the
capability to execute it. A **Domain Package** is the product boundary; engine
packages are its implementation layers.

Avoid presenting one example domain's type counts, retrieval axes, or tools as
universal behaviour. State the owning package when a detail is domain-specific.
Writers should also read the
[terminology guide](https://github.com/kernary-aoe/aoe-engine/blob/main/docs/style/terminology.md)
before adding new terms here.
