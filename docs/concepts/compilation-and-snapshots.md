# Compilation and snapshots

Compilation is a release operation. The runtime never turns mutable source into
artifacts while serving a query or action.

## Pipeline

1. Resolve the exact Model Package and compute its semantic digest.
2. Parse source syntax and normalize it into domain-neutral Unit IR.
3. Validate fields and relations against the loaded model.
4. Render the projections declared by that model.
5. Check cross-Unit relation and corpus invariants.
6. Emit Unit artifacts, the global index, manifest, lock, and optional signature
   through an atomic staging transaction.
7. Load the finished snapshot in strict mode before activation.

The same sources, model, corpus identity, and release input must produce the
same bytes. Output location is not part of identity.

## Snapshot identity

`model.lock` binds the exact model files and semantic digest.
`corpus.manifest.json` binds the global index and canonical corpus content
digest. Strict runtime loading recomputes those values and rejects tampering,
missing projections, unsafe links, and non-regular files.

The release date is a declared build input. Passing `--release` or
`SOURCE_DATE_EPOCH` prevents wall-clock time from making artifacts
irreproducible.

## Generated files

Do not edit a compiled Unit, projection, `_index.xml`, manifest, signature, or
lock. Change the owning Model or Corpus source and build a new release. Runtime
activation should point to the new immutable directory only after verification.
