# Kernary

<img src="docs/assets/kernary-logo.svg" alt="Kernary" width="540">

Kernary is a model-driven ontology engine. It compiles external domain
ontologies and corpora into versioned runtimes for agents and applications.
An agent can query an immutable snapshot, receive a constrained selection plan,
and call policy-gated actions through an embedded SDK, MCP, or HTTP.

Kernary does not ship a production ontology. Types, fields, relations,
projections, retrieval profiles, actions, policies, and validators belong to an
external Model Package. Units and assets belong to a Corpus Package. Ticket,
Recipe, Security, and Frontend Design are examples built on the engine; none is
built into Core.

```text
Model Package + Corpus Package + Adapters
                    │
                    ▼
        parser → IR → compiler → snapshot
                    │
          query plan      action plan
                    │          │
       constraints      policy + evidence
                    └────┬─────┘
                 SDK · MCP · HTTP
```

## Verify the engine

Kernary currently uses Bun for the workspace toolchain.

```bash
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run build
```

The test suite loads several external models, including Ticket, Recipe, and
Security. This is a conformance property: adding a domain type or relation must
not require an engine change.

## Build the maintained example

The repository still carries the `.prime` v1 compatibility syntax while the
v0.2 package CLI is being consolidated. The maintained build entry point today
is:

```bash
bun scripts/build-atom-dirs.ts \
  --src examples/hello-world/primes/sources \
  --out examples/hello-world/primes/compiled \
  --model compat/prime-v1-model \
  --corpus org.example/hello-world \
  --release 2026-08-31
```

The command emits an immutable bundle, `model.lock`, `_index.xml`, and
`corpus.manifest.json`. `compat/prime-v1-model` owns the historical Atom schema;
it is a compatibility Model Package, not Kernary Core.

Start the generic MCP transport against that exact model and bundle:

```bash
PRIME_DIR=examples/hello-world/primes/compiled \
PRIME_MODEL_DIR=compat/prime-v1-model \
bun packages/mcp-server-core/src/index.ts
```

`PRIME_*`, `.prime`, `prime/*`, the `prime` CLI alias, and the published
`@skill-wiki/*` npm scope are compatibility identifiers. New documentation uses
Kernary for the product. See the [naming ADR](docs/adr/0001-kernary-name-and-product-boundary.md)
for the migration boundary.

## Package model

- **Model Package**: types, relations, projections, retrieval, functions,
  actions, policies, validators, and migrations.
- **Corpus Package**: units, assets, provenance, licence policy, and release
  identity.
- **Adapter Package**: external source or provider integration.
- **Domain Package**: a deployable composition of a model, corpus, adapters,
  tools, and optional Agent Skills.

A Skill can explain how an Agent should use a Domain Package. It does not own
schema, grant capabilities, or replace the SDK and transports.

## Query and action are separate paths

Query planning resolves candidates, features, hard and soft constraints,
relation semantics, projection load order, and token budgets. A Selection Plan
explains what the runtime selected and why.

Actions use a separate authorization path. External writes require a declared
Action, principal and capability checks, preflight, policy and human approval
where required, idempotency, and append-only event evidence. Being able to read
a unit never grants permission to change state.

## Packages

- Declarations: `model-schema`, `corpus-schema`
- Compile pipeline: `parser`, `ir`, `compiler`, `bundle`
- Read path: `runtime`, `query-engine`, `constraint-solver`, `projection-engine`
- Write path: `action-runtime`, `policy-engine`, `event-store`
- Integration: `sdk`, `sdk-codegen`, `mcp-server-core`, `http-server`, `cli`
- Tooling: `language-server`, `plugin-host`, `registry`, `observability`, `testkit`

## Documentation

- [Start here](docs/start/index.md)
- [Package model](docs/concepts/package-model.md)
- [Compilation and snapshots](docs/concepts/compilation-and-snapshots.md)
- [Selection and execution](docs/concepts/selection-and-execution.md)
- [Terminology](docs/style/terminology.md)
- [Legacy Prime v1 specifications](spec/PRIME-PROTOCOL-v1.md)

Kernary is Apache-2.0 licensed. Current remote and npm names remain unchanged
until their external rename and dual-publish steps are complete.
