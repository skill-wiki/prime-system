# Build your first domain runtime

Kernary gives an application a domain it can actually use. You provide a
Model Package (the vocabulary and rules) and a Corpus Package (the knowledge
and evidence). Kernary compiles them into a verified snapshot that an Agent or
application can query, inspect, and act through.

You do not need to put an entire handbook in a prompt, teach the engine what a
Ticket is, or write a second retrieval system for every domain.

## Choose your starting point

| You want to… | Start here |
|---|---|
| Use an existing package from an Agent or app | [Connect an Agent](../guides/connect-agent.md) |
| Define types, relations, queries, or actions for a new domain | [Package model](../concepts/package-model.md) |
| Turn source material into a versioned knowledge release | [Compilation and snapshots](../concepts/compilation-and-snapshots.md) |
| Control what an Agent can change | [Actions and policies](../guides/actions-and-policies.md) |
| Promote, roll back, or migrate a release | [Releases and migrations](../operations/releases-and-migrations.md) |

## What you get

Every successful build produces a release that can be moved between machines:

```text
Model Package + Corpus Package
              │
              ▼
       compile · check · sign
              │
              ▼
       verified runtime snapshot
          │                 │
      query / plan       action / evidence
```

The snapshot contains compiled Unit artifacts, Model-defined projections, an
index, a manifest, and a model lock. Runtime verifies the identity and content
before it serves anything. A changed file is a failed release, not a silent
best-effort read.

## The five-minute path

### 1. Install the engine

```bash
git clone https://github.com/skill-wiki/kernary-engine.git
cd kernary-engine
bun install --frozen-lockfile
```

### 2. Build an example

The repository includes a tiny example so you can see the complete path before
creating a domain of your own:

```bash
bun scripts/build-atom-dirs.ts \
  --src examples/hello-world/primes/sources \
  --out examples/hello-world/primes/compiled \
  --model compat/prime-v1-model \
  --corpus org.example/hello-world \
  --release 2026-08-31
```

The explicit model path is important: the example vocabulary belongs to the
example package, not to Kernary Core.

### 3. Connect a client

For MCP clients, mount the exact snapshot and model used to build it:

```bash
PRIME_DIR=examples/hello-world/primes/compiled \
PRIME_MODEL_DIR=compat/prime-v1-model \
bun packages/mcp-server-core/src/index.ts
```

For an embedded integration, use the SDK. For a separate process or service,
use the HTTP transport. All three expose the same query and action contracts.

## Create a domain package

Start a separate repository rather than adding domain files to the engine:

```text
my-domain/
├── model/                 # types, fields, relations, projections, actions
├── corpus/                # units, sources, provenance, release metadata
├── adapters/              # optional importers and external providers
├── tools/                 # optional domain-specific tools
└── README.md
```

The Model Package tells Kernary what a valid object and relationship look like.
The Corpus Package supplies the objects and their sources. An Adapter can
import an external catalogue or bind a provider. A Domain Package is the
deployable composition of those pieces.

## A request from an application

At query time, the application sends a domain-neutral request. The model decides
which fields, relations, projections, and retrieval profile are meaningful:

```json
{
  "corpus": "com.example/support",
  "query": "open incidents affecting the checkout service",
  "topK": 8,
  "projection": "core"
}
```

The response includes a Selection Plan: selected units, why they matched,
which constraints were applied, and which bytes the client may load next. The
application can log or test that plan instead of reverse-engineering a ranking
algorithm from a list of results.

## A governed write

If the application needs to change state, it calls a declared Action rather than
turning a retrieved paragraph into an improvised tool call. The Action contract
defines its input, output, capabilities, preconditions, policy, approval mode,
idempotency, and evidence. Query access and write authority stay separate.

## Before you publish

Run the checks that match your package:

```bash
bun run typecheck
bun run test
bun run build
```

For a Corpus Package, also run declaration conformance and bundle verification.
Never edit `_index.xml`, `corpus.manifest.json`, or `model.lock` by hand; rebuild
them from source so the digest and provenance remain trustworthy.

## Next

- [Understand the Package model](../concepts/package-model.md)
- [Compile a verified snapshot](../concepts/compilation-and-snapshots.md)
- [Connect an Agent](../guides/connect-agent.md)
- [Operate releases](../operations/releases-and-migrations.md)
