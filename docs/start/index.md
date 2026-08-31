# Build a knowledge runtime

Kernary turns an external Model Package and Corpus Package into an immutable
runtime snapshot. An existing Agent can use that snapshot through the embedded
SDK, MCP, or HTTP without importing the whole corpus into its prompt.

Choose the path that matches the work you are doing:

- **Connect an Agent** when a maintained Domain Package already exists.
- **Model a domain** when you need new types, relations, projections, retrieval,
  or actions.
- **Publish knowledge** when the model exists and you own the corpus sources,
  provenance, and release policy.
- **Operate a runtime** when you need locks, signing, activation, migration,
  observation, or event replay.

## What a successful build produces

A release contains compiled Unit artifacts, model-defined projections,
`_index.xml`, `corpus.manifest.json`, and `model.lock`. The runtime verifies the
bundle identity and content before serving it. It does not compile sources on a
request path.

```text
model/ + corpus/sources/
          │
          ▼
      compile + check
          │
          ▼
  immutable snapshot
     │           │
 query plan   action plan
```

The current maintained example uses the v1 compatibility model:

```bash
bun scripts/build-atom-dirs.ts \
  --src examples/hello-world/primes/sources \
  --out examples/hello-world/primes/compiled \
  --model compat/prime-v1-model \
  --corpus org.example/hello-world \
  --release 2026-08-31
```

Success ends with a verified bundle in
`examples/hello-world/primes/compiled`. The model path is explicit so the
example does not imply that its Atom vocabulary belongs to Core.

## Next

Read [Package model](../concepts/package-model.md) before defining a domain, or
[Connect an Agent](../guides/connect-agent.md) when you already have a bundle.
