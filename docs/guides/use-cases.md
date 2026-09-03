# What you can build

Each shape below needs the same three things: a vocabulary the application
shares with the Agent, material whose sources stay traceable, and writes that
stay under policy. The differences are in the types, the relations that matter
for retrieval, and which operations deserve to be Actions.

Use these as starting sketches. The declarations shown are illustrative, not a
schema you must adopt.

## Support assistant

An assistant that follows impact instead of guessing from ticket text.

```text
Incident ── affects ──> Service
Incident ── owned-by ─> Team
Incident ── blocks ───> Release
```

Relations carry the work here. "Which open incidents affect checkout" is a
traversal, not a similarity match, so the Selection Plan can show which links it
followed and which it excluded. Projections keep responses small: `summary`
returns title and severity, `core` adds impact and owner, `full` adds the
timeline and evidence.

Actions worth declaring: acknowledge, reassign, escalate, resolve. Each needs a
capability and a precondition, and resolve is a good candidate for approval.

## Compliance review

A review that can cite the exact snapshot it read.

Controls, evidence, and exceptions are typed Units under a versioned release.
Because snapshot identity binds model, corpus, release, and digest, a finding
recorded in March can be reproduced in September against the same bytes. Licence
and provenance metadata travel with the material, which matters when evidence
comes from a third party.

Keep the review read-only at first. Granting an exception is the Action to
declare later, with approval required and evidence appended.

## Operations knowledge base

Runbooks where the risky steps are declared rather than described.

Procedures become Units with preconditions. The steps that change production
become Actions with a side-effect class, an idempotency key, and a policy. An
Agent can then ask for the rollback procedure and request the rollback, and the
runtime decides whether that principal may run it. The Effect Plan comes back
before anything executes, so a human sees what would change.

## Data catalogue

Datasets, owners, lineage, and access rules retrieved through a profile you
configure.

Lineage is a relation with direction and cardinality, so "what breaks if this
table changes" is answerable. Visibility is enforced before candidate providers
receive data, which is what keeps a private dataset from leaking through a
relation or a score.

## Design system guidance

The reference [Frontend Design](https://github.com/kernary-aoe/aoe-frontend-design)
package publishes 797 Units of patterns, anti-patterns, rules, and examples that
an Agent consults while writing interface code. It also ships a validator and an
optional Skill, which makes it the most complete external package to read before
you author your own.

Browse its Units in the [registry](https://kernary-aoe.github.io/marketplace) or
read the [case study](https://kernary-aoe.github.io/docs/examples/frontend-design).

## Choosing what becomes an Action

A Unit describes. An Action changes. When you are unsure, ask whether a wrong
call needs an audit trail. If it does, declare it as an Action so it passes
capability, policy, idempotency, and approval checks, and appends evidence. A
Selection Plan can recommend an Action; it cannot grant the capability to run
it.

## Next

- [Package model](../concepts/package-model.md) to declare the types and
  relations these sketches imply.
- [Actions and policies](./actions-and-policies.md) for the write path.
- [Connect an Agent](./connect-agent.md) to mount the result.
