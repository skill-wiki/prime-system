# Releases and migrations

A Kernary release changes an immutable package or snapshot identity. Publishing,
activation, migration, and rollback are separate operations.

## Build and verify

Pin the Model Package, corpus declaration, source inventory, release date, and
signing policy. Build into staging, verify the generated manifest and model lock,
then move the completed directory into its release location atomically.

Run the owning package's conformance commands. The reference Frontend Design
package uses:

```bash
bun run model:check
bun run corpus:build
bun run corpus:check
bun run corpus:verify
bun run smoke
```

## Activate and roll back

Activate by pointing a runtime instance at a verified immutable directory. Do
not compile over the active release. Keep the previous snapshot addressable so a
rollback is a binding change, not a reverse mutation of generated files.

## Migrate a model

A migration belongs to the Model Package and names its source and target model
versions. Run it against source or a migration workspace, build a new snapshot,
and compare inventories and identities before activation.
