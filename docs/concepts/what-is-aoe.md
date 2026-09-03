# What AOE is

AOE compiles a domain you declare into a runtime that an application or an Agent
can query and act through. You own the vocabulary and the knowledge. The engine
owns compilation, snapshot identity, retrieval, and the authorization path for
writes.

The name is the category: an Agent Ontology Engine. An ontology here is the
ordinary engineering kind, a declared set of types, fields, and relations that
your software already implies. AOE asks you to write it down once, in a form
both your application and an Agent can read.

## The problem it addresses

Most systems hand an Agent either a prompt full of documents or a similarity
index over chunks of text. Both return passages. Neither can answer what an
object is, which objects it relates to, which release the answer came from, or
whether the Agent may change it.

That gap shows up as familiar work: a second retrieval stack per domain, an
Agent that invents a tool call from a retrieved paragraph, a ranking you cannot
reproduce after the corpus changes, and no way to prove which bytes produced an
answer.

## What you get

A build produces a snapshot that carries its own identity:

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

A query returns a Selection Plan rather than a list. The plan records the
selected Units, the score contributions behind their order, the constraint
decisions that applied, which relations were expanded or excluded, the
projections loaded, the budget consumed, and the snapshot identity that
answered. Your application can log that plan, diff it between releases, and
write tests against it.

A write goes through a declared Action. The runtime validates inputs, principal,
capability, preconditions, provider binding, side-effect class, idempotency, and
policy, then returns an Effect Plan before executing anything. Execution waits
for any required approval, and the run and its evidence append to the Event
Store.

## When to use it

AOE fits when your domain has named things, relationships that matter for
retrieval, and operations that must stay governed. A support domain with
incidents, services, teams, and releases fits. So does a compliance domain with
controls and evidence, or an operations domain whose risky steps should be
declared Actions instead of prose an Agent improvises.

It is a poor fit when a single unstructured corpus and a similarity search
already answer your questions, when nothing in the domain is written, or when
you need a hosted service today. The public site here is a static discovery
page, not a Registry API.

## What the engine does not decide

Core fixes the declaration meta-schema and the stable IR. Atom kinds, field
names, relation names, retrieval profiles, actions, and validators are data in
your Model Package. There is no built-in list of business types, which is why a
support model, a recipe model, and a design-system corpus all compile through
the same path.

The reference packages in the registry, including the 797-unit Frontend Design
corpus, are external packages published against these contracts. Read them for
a working example; replace them when your domain differs.

## Where to go next

- [Package model](./package-model.md) for the four packages you can own.
- [Compilation and snapshots](./compilation-and-snapshots.md) for how a release
  is built and verified.
- [Selection and execution](./selection-and-execution.md) for the read and write
  contracts in detail.
- [What you can build](../guides/use-cases.md) for worked domain shapes.
- [Glossary](../reference/glossary.md) for the terms used across these pages.
- [Build your first domain runtime](../start/index.md) to run the five-minute
  path.
