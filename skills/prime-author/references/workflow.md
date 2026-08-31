# Prime authoring workflow

Use the package's own scripts when present. For the reference frontend-design
domain the owning repository exposes:

```bash
bun run model:check
bun run corpus:build
bun run corpus:check
bun run corpus:verify
bun run smoke
```

The observable release invariants are:

- every source parses and normalizes against the selected external model;
- model and corpus declaration conformance pass;
- every emitted unit has protocol metadata and a licence required by policy;
- index and unit inventories agree;
- every graph edge targets a unit in the same immutable release;
- projection bytes and content digests verify;
- `model.lock` matches the exact Model Package files and semantic digest;
- production transports boot against the same snapshot.

Build into staging or the package's generated `dist/`; never compile over source.
If the corpus uses unresolved descriptive relation values, the compiler records
them as build diagnostics and does not fabricate unit edges.
