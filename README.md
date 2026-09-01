# AOE — Agent Ontology Engine

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/aoe-logo-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/aoe-logo.svg">
    <img src="docs/assets/aoe-logo.svg" alt="AOE" width="540">
  </picture>
</p>

<p align="center">
  <strong>Agent Ontology Engine for software that needs to know, decide, and act.</strong>
</p>

<p align="center">
  <a href="./README.zh-CN.md">中文</a> ·
  <a href="https://kernary-aoe.github.io/docs">Documentation</a> ·
  <a href="https://github.com/kernary-aoe/aoe-engine/actions/workflows/ci.yml"><img src="https://github.com/kernary-aoe/aoe-engine/actions/workflows/ci.yml/badge.svg" alt="CI"></a> ·
  <a href="LICENSE">Apache-2.0</a>
</p>

AOE (Agent Ontology Engine) turns an external domain
model and corpus into a deterministic, versioned, verifiable runtime. An
application or Agent can then discover what exists, ask for a constrained
selection plan, resolve the right projection, and invoke governed actions
through one contract exposed by an embedded SDK, MCP, or HTTP.

The short version: **AOE is the engine; a domain's vocabulary and data are
packages around it.** There is no production Ticket schema, design ontology, or
fixed list of atom kinds hidden inside Core.

## Why this exists

Most Agent knowledge systems start with a document or a skill file. That is a
fine authoring format, but it becomes a poor runtime boundary when a system has
to answer four harder questions:

1. What does this domain mean, exactly? Which types and relations are valid?
2. Which pieces of knowledge are relevant for this request, and why?
3. Can the runtime prove that the loaded snapshot is the one that was built?
4. What may an Agent read, and what may it actually change?

AOE makes those questions explicit without making the core domain-specific.
The model declares the vocabulary. The corpus supplies the units and evidence.
The compiler produces a verified snapshot. Query returns an explainable plan.
Action execution has its own authorization and evidence path.

## The boundary

```text
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│  Model Package   │  │  Corpus Package  │  │ Adapter / Tools  │
│ types, relations │  │ units, sources   │  │ providers, evals │
└────────┬─────────┘  └────────┬─────────┘  └────────┬─────────┘
         └─────────────────────┼─────────────────────┘
                               ▼
                    ┌────────────────────┐
                    │       AOE         │
                    │ parse → IR → build │
                    │ verify → snapshot  │
                    └─────────┬──────────┘
                              │
             ┌────────────────┴────────────────┐
             ▼                                 ▼
       Selection Plan                    Governed Action
             │                                 │
             └──────────────┬──────────────────┘
                            ▼
                    SDK · MCP · HTTP
```

### What belongs where

| Boundary | Owns | Does not own |
|---|---|---|
| AOE Core | meta-schema, IR, parser, compiler, snapshot verification, query/action contracts | domain type names, business rules, corpus content |
| Model Package | types, fields, relations, projections, retrieval profiles, functions, actions, policies, migrations | compiled corpus bytes |
| Corpus Package | units, assets, provenance, licences, releases, signatures | engine implementation |
| Adapter Package | source importers, provider bindings, validators, evaluators | Core schema decisions |
| Domain Package | a deployable composition of model + corpus + adapters + tools + optional Agent Skill | changing Core to accommodate one domain |

If replacing `Ticket` with `Recipe` requires a new branch in the engine, the
boundary is wrong. In a healthy Domain Package, the engine only sees declared
types and contracts.

## How the runtime works

### 1. Model-driven compilation

The compiler reads a Model Package and source units, normalizes them into a
shared IR, emits model-defined projections, and writes a deterministic bundle:

```text
model/ + corpus/sources/
          │
          ├─ parser + structural checks
          ├─ IR normalization
          ├─ projection / relation compilation
          ├─ corpus index + manifest + model lock
          └─ optional signature
                    │
                    ▼
          immutable verified snapshot
```

`_index.xml`, projection artifacts, `corpus.manifest.json`, and `model.lock` are
generated outputs. They must not be edited by hand. Runtime verifies identity,
paths, signatures (when required), and the canonical content digest before it
serves a snapshot.

### 2. Explainable query

The query path does not return a mysterious list of strings. It returns a
`SelectionPlanIR` that records:

- candidate generators and feature contributions;
- visibility and principal filtering before ranking;
- hard constraints and soft preferences;
- relation closure, expansion, exclusion, cycle policy, and load order;
- projection levels and token budget decisions;
- diagnostics when an external generator or relation semantic is unavailable.

The plan is useful to an Agent, but also to a test, an audit log, or a human
debugging why a result was selected.

### 3. Governed action

Read and write are intentionally different paths. An action must declare its
input/output, side effects, capabilities, preconditions, idempotency, and
approval requirements. The runtime can then perform preflight and dry-run,
authorize a principal, evaluate policy, request human approval, retry within a
bound, and append evidence to an event store. Reading a unit never implies
permission to mutate external state.

## Quick start

The repository is a TypeScript workspace and uses [Bun](https://bun.sh/) for
installation, builds, and tests. Node.js 22+ is useful for consumers of the
HTTP and MCP entry points.

```bash
git clone https://github.com/kernary-aoe/aoe-engine.git
cd aoe-engine
bun install --frozen-lockfile

# confidence check
bun run typecheck
bun run test
bun run build
```

Run the CLI without installing a global binary:

```bash
bun packages/cli/src/index.ts --help
bun packages/cli/src/index.ts --version
```

### Build and mount the smallest example

The engine repository carries small example packages so that the full path is
easy to inspect. They are not built-in Core ontology:

```bash
bun scripts/build-atom-dirs.ts \
  --src examples/hello-world/primes/sources \
  --out examples/hello-world/primes/compiled \
  --model compat/prime-v1-model \
  --corpus org.example/hello-world \
  --release 2026-08-31
```

The output is a verified snapshot containing an index, projections, manifest,
and lock. To expose it through the generic MCP transport:

```bash
AOE_CORPUS_DIR=examples/hello-world/primes/compiled \
AOE_MODEL_DIR=compat/prime-v1-model \
bun packages/mcp-server-core/src/index.ts
```

The MCP entry point reads the mounted Corpus and Model paths from its environment
configuration. New integrations should use the `aoe` CLI and the package
contracts documented below.

## Author a domain without changing the engine

A Domain Package normally looks like this:

```text
my-domain/
├── model/
│   ├── model.yaml              # types, relations, projections, actions
│   └── policies.yaml           # declared policy sets
├── corpus/
│   ├── sources/                # source declarations / unit inputs
│   └── corpus.yaml             # identity, provenance, publication policy
├── adapters/                   # optional source/provider integrations
├── tools/                      # optional domain MCP or HTTP handlers
└── README.md
```

The exact declaration format is intentionally a package contract rather than a
Core constant. Start with:

- [Package model](docs/concepts/package-model.md)
- [Define and run a domain](docs/start/index.md)
- [Connect an Agent](docs/guides/connect-agent.md)
- [Actions and policies](docs/guides/actions-and-policies.md)
- [Releases and migrations](docs/operations/releases-and-migrations.md)

The reference [Frontend Design Domain Package](https://github.com/kernary-aoe/aoe-frontend-design)
is one example of this boundary. Security, backend, mobile, and cooking
corpora in the workspace are additional conformance fixtures, not Core
features.

## Package map

The workspace is organized by contract, not by a single framework package:

| Area | Packages | Responsibility |
|---|---|---|
| Declarations | `model-schema`, `corpus-schema` | Load and validate external package data |
| Language / IR | `parser`, `types`, `ir` | Parse source syntax and carry stable contracts |
| Build | `compiler`, `bundle` | Compile units, projections, indexes, manifests, locks |
| Read path | `runtime`, `query-engine`, `constraint-solver`, `projection-engine` | Verify snapshots and produce selections |
| Write path | `action-runtime`, `policy-engine`, `event-store` | Govern actions and record evidence |
| Integration | `sdk`, `sdk-codegen`, `mcp-server-core`, `http-server`, `cli` | Expose the same contracts to hosts |
| Extension / quality | `plugin-host`, `registry`, `observability`, `evaluation-engine`, `testkit`, `language-server` | Host adapters, distribution, telemetry, evaluation, tooling |

The workspace packages are implementation modules for AOE. Their names are
listed here so a host can choose the layer it needs; domain users normally
depend on the SDK or a transport rather than importing every module.

## Security and reproducibility invariants

AOE is designed to fail closed at the boundaries that matter:

- canonical digests are independent of checkout location and object order;
- manifest and projection tampering fails before content is returned;
- lexical traversal, absolute paths, symlink escapes, FIFOs, and other
  non-regular artifacts are rejected;
- visibility is applied before ranking and relation expansion;
- hard constraints cannot be outweighed by a larger score;
- capability and policy checks happen before effectful execution;
- idempotency is scoped by tenant/workspace and conflicting replays fail;
- unavailable external providers produce diagnostics, not fabricated passes.

Run `bun run test` to exercise these invariants. The integration workspace runs
the stronger cross-package check with `bun run verify`.

## Project status

The v0.2 engine, SDK, generic query planner, governed action runtime, MCP and
HTTP transports, model/code generation, language-server foundation, and
reference Domain Package are implemented and tested. The hosted Registry,
first-party evaluation service, and production observability deployment are
extension products, not hidden assumptions in Core.

The next work should deepen package distribution and migration tooling rather
than add domain-specific branches to the engine.

## Contributing

Engine changes belong here. Domain vocabulary and corpus content belong in a
Domain Package. Before opening a pull request:

```bash
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run build
```

Read [CONTRIBUTING](.github/CONTRIBUTING.md), or the
[中文贡献指南](.github/CONTRIBUTING.zh-CN.md). For a security issue, use
[SECURITY.md](.github/SECURITY.md).

## License

AOE Engine is licensed under [Apache-2.0](LICENSE). External Domain and
Corpus Packages carry their own source attribution and licence terms.
