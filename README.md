# Prime System

Prime System is the domain-neutral protocol, compiler, runtime and SDK for
model-driven knowledge engines.

It does **not** ship a production ontology or corpus. Atom kinds, fields,
relations, projections, retrieval profiles, actions and validators come from an
external Model Package; units and assets come from an external Corpus Package.

```text
Model Package + Corpus Package + Adapters
                    │
                    ▼
 parser → IR → compiler → immutable bundle
                    │
       query · constraint · action runtime
                    │
          MCP · HTTP · SDK · CLI
```

## Install and verify

```bash
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run build
```

## Build an example

The examples intentionally use small external models and corpora. The v1 model
under `compat/` is a compatibility fixture, not Core schema.

```bash
bun scripts/build-atom-dirs.ts \
  --src examples/hello-world/primes/sources \
  --out examples/hello-world/primes/compiled \
  --model compat/prime-v1-model \
  --corpus org.example/hello-world \
  --release 2026-08-31
```

Run the generic transport with an explicit bundle and model:

```bash
PRIME_DIR=examples/hello-world/primes/compiled \
PRIME_MODEL_DIR=compat/prime-v1-model \
bun packages/mcp-server-core/src/index.ts
```

## External declaration boundary

The engine fixes only the meta-schema, for example `TypeDefinitionSchema` and
`RelationDefinitionSchema`. It does not enumerate domain types or verbs. Both of
these parse and compile without an engine change when the loaded model declares
them:

```prime
unit INC_42 : Ticket { title: "Database unavailable" }
Widget DashboardCard { title: "Revenue" }
```

`compat/prime-v1-model` currently declares the historical 28 kinds and 14
relations so older corpora can migrate. A new domain should own its model rather
than editing that fixture.

## Packages

- `model-schema`, `corpus-schema`: external package declarations and resolution
- `parser`, `ir`, `compiler`, `bundle`: deterministic source-to-bundle pipeline
- `runtime`, `query-engine`, `constraint-solver`, `projection-engine`
- `action-runtime`, `policy-engine`, `evaluation-engine`, `event-store`
- `sdk`, `sdk-codegen`, `language-server`, `plugin-host`
- `mcp-server-core`, `http-server`, `cli`, `registry`, `observability`
- `testkit`: model, corpus, bundle, wiring and invariant conformance

## Non-negotiable invariants

- Runtime loads compiled bundles only; it never compiles source on request.
- Model and bundle digests are verified at boot.
- Generated bundle files and locks are never edited by hand.
- Selection does not grant action capabilities.
- External writes require Action definitions, policy, preflight, idempotency and
  event evidence.
- Domain packages depend on Prime System; Prime System never imports a domain.

See the protocol and architecture material under `spec/` and `docs/`.
