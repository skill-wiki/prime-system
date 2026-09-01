# Package model

AOE is useful when your domain is more than a pile of documents: you need
named things, relationships, predictable retrieval, and safe operations. A
Package is the unit you own and publish. It tells AOE what your domain is,
what knowledge belongs to it, and which operations an Agent may request.

## The four packages you can use

```text
Model Package ─────── vocabulary and behaviour
Corpus Package ────── knowledge and evidence
Adapter Package ───── external source/provider connection
Domain Package ────── a deployable product made from the three
```

You can keep these in one repository while prototyping, then publish them
independently when different teams own the model, data, or providers.

## Model Package: describe your domain

The Model Package answers: “What can exist here, and what can be done with it?”
It declares:

- **Types and fields** — the objects an application can store or resolve.
- **Relations** — direction, cardinality, traversal, selection, load order,
  conflict handling, and cycle policy.
- **Projections** — which fields are returned at `summary`, `core`, or `full`
  detail, with token targets for each level.
- **Retrieval** — candidate generators, features, constraints, and rerankers.
- **Functions and Actions** — pure calculations versus state-changing work.
- **Policies and capabilities** — who may request an Action and under what
  conditions.
- **Validators and migrations** — how outputs are checked and releases evolve.

The declarations are data. AOE validates them against its meta-schema and
builds a lock with the exact model version and schema digest. It does not
contain a list of business types that every domain must reuse.

### A small mental model

Suppose you are building a support assistant. Your Model Package might declare:

```text
Incident ── affects ──> Service
Incident ── owned-by ─> Team
Incident ── blocks ───> Release
```

It can also declare that `summary` returns title and severity, `core` adds
impact and owner, and `full` adds the timeline and evidence. The same engine
can compile a completely unrelated Recipe or Compliance model.

## Corpus Package: publish your knowledge

The Corpus Package answers: “Which material is released against this model?”
It owns:

- source Units and assets;
- corpus identity and compatible model range;
- provenance, attribution, and licence metadata;
- visibility and publication policy;
- evaluation fixtures and golden queries;
- release version, signing configuration, and evidence.

Source is the thing a human edits. A build turns it into an immutable snapshot:

```text
corpus/sources/
      │
      ├─ normalized Units
      ├─ model-defined projections
      ├─ _index.xml
      ├─ corpus.manifest.json
      └─ model.lock
```

Do not edit those generated files by hand. Runtime recomputes and checks their
identity and content digest before serving a Unit.

## Adapter Package: connect the outside world

An Adapter Package connects a source catalogue, search provider, validator,
evaluation provider, or Action provider. It can add an integration, but it
cannot silently add a type or relation to the Model Package. This keeps an
external provider replaceable and makes its permissions visible.

## Domain Package: ship a usable experience

A Domain Package combines the pieces into something an Agent can use:

```text
domain-package/
├── model/       # the domain contract
├── corpus/      # versioned knowledge
├── adapters/    # imports and providers
├── tools/       # optional domain tools
└── skills/      # optional Agent-facing guidance
```

The optional Skill is an instruction layer. It can teach an Agent how to ask
good questions or how to author a package; it does not replace the Model,
grant a capability, or bypass Action policy.

## Package versions and ownership

Model and Corpus releases carry their own versions. A Corpus declares the model
range it was built for; the compiler records the exact resolved model in
`model.lock`. A host can therefore answer three practical questions before
mounting a release:

1. Is this the model the corpus expects?
2. Is this snapshot complete and untampered?
3. Which owner and licence apply to the bytes being returned?

For the publication workflow, read [Compilation and snapshots](./compilation-and-snapshots.md).
For a working external package, see the
[Frontend Design Domain Package](https://github.com/skill-wiki/kernary-frontend-design).
