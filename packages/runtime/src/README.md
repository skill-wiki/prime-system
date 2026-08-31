# `@skill-wiki/runtime`

This compatibility-scoped package owns immutable Kernary Corpus activation and
projection reads. It does not compile source, run retrieval, or execute Actions.

## Public modules

| Module | Contract |
|---|---|
| `corpus-snapshot.ts` | Parse and validate the manifest, verify protocol/IR/emitter compatibility and canonical content digest, reject unsafe paths and files, and return a stable `SnapshotRef` |
| `atom-loader.ts` | Read the compatibility `_index.xml` and per-Unit `atom.yaml`, resolve declared projection artifacts, and keep deprecated Units out of active selection |

`src/index.ts` is the public import surface. Consumers must not import a module
path directly.

## Boundaries

- Compiler and Bundle packages create immutable artifacts.
- Runtime verifies and reads those artifacts.
- Query Engine turns their Unit metadata into a Selection Plan.
- Projection Engine admits and reads a requested projection.
- Action Runtime handles governed execution and Event evidence.

The `atom-loader` name and Atom-shaped artifact files belong to the v1
compatibility format. Kernary Core uses domain-neutral Unit IR and does not own a
fixed Atom kind list.

The generic MCP transport, Bundle finalizer, CLI diagnostics, and Frontend
Design Domain Package all use these same loaders. A second transport-specific
snapshot loader is a contract violation.
