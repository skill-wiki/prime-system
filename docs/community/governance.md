# Governance

This document describes how decisions are made in the Skill Wiki / Prime project. The model is intentionally light: we are pre-1.0 and most decisions can be made fast by whoever's doing the work. The structure below is the escalation path for the cases where it matters.

## v0.1.0 — interim governance

**The structure described below is the target state.** It activates at v0.2.0
when public maintainership opens. For v0.1.0:

- The project has a single author. There is no Technical Committee yet.
- All Tier-1, Tier-2, and Tier-3 decisions are author-led.
- RFC issues (use the "Feature request" template) are read and considered;
  resolution is at author discretion.
- Public review periods (Tier 3) start at v0.2.0.

The tiered process below is what you'll see when the project graduates to
multi-maintainer governance. Read it as documentation of intent, not as a
description of v0.1.0 day-to-day operation.

See [MAINTAINERS.md](./maintainers.md) for the explicit v0.1.0 status and
how to volunteer when v0.2.0 opens public maintainership.

---

## Target governance (activates v0.2.0)

## Decision tiers

### Tier 1 — In-PR decisions (anyone with a merged PR)

The default. If your change is contained to one package, has a test, doesn't change a public API, and gets a thumbs-up from one other contributor, ship it. No formal process.

Examples:
- Bug fix that doesn't change a documented behavior
- Adding a new test
- Improving error messages
- New atom kind in `examples/` corpora
- Documentation improvements
- Lint / type-check fixes
- Internal refactoring with no external surface area change

### Tier 2 — Spec-touching decisions (Technical Committee)

When a change touches:
- The `.prime` DSL grammar
- The 28 declared atom kinds
- The 14 declared edge verbs
- The 3 projection levels
- The 5-layer pipeline
- Any field in `_index.xml` or `atom.yaml`
- The MCP `prime_query` tool's I/O signature
- The HTTP registry's REST contract
- `domain.yaml` schema (per `spec/DOMAIN-EXTENSION-SPEC.md`)

… open an RFC issue first. Use the "Feature request" template with **Scope: Spec change**. The Technical Committee (currently the maintainers in `MAINTAINERS.md`) reviews; need a simple majority to merge. Default response time: one week.

### Tier 3 — Charter-changing decisions (rough consensus, public)

Reserved for:
- Changing the project's mission statement
- Changing the license (currently Apache-2.0)
- Renaming the project
- Adding or removing a member from the Technical Committee
- Adopting a Code of Conduct

These get a public 14-day comment period. Decision needs explicit consent from > 50% of active maintainers and zero hard blocks from anyone who has merged a PR in the last 6 months.

## Roles

### Contributors

Anyone who has merged at least one PR. No further commitment expected.

### Maintainers

Listed in `MAINTAINERS.md`. Can review and merge PRs. Expected to respond to issues mentioning them within ~7 days.

### Technical Committee (TC)

A subset of maintainers responsible for spec-level decisions (Tier 2). The TC starts as the founding maintainers; future seats are added by majority vote of the existing TC after a candidate has been a maintainer for ≥ 3 months.

## How to escalate

If you believe a Tier 1 decision should have been Tier 2:

1. Open an issue titled `[escalate] <PR number or commit hash>`
2. State which spec invariant you believe was changed without RFC
3. The TC has 7 days to respond. The default outcome of silence is "the change stays."

## Voting

When the TC votes (Tier 2 decisions), votes are public in the issue thread. Every TC member can register one of:
- `+1` (in favor)
- `+0` (no objection)
- `-1` (oppose, with reason)

A `-1` blocks merge until the proposer either addresses the reason or the TC votes 2/3 to override.

## Conflicts of interest

If you stand to gain from a decision (employer's product is affected, you'd benefit financially, …), abstain from voting on that issue and disclose the COI in the thread.

## Spec versioning

The protocol spec (`spec/PRIME-PROTOCOL-v1.md`) versions independently of the implementation. Implementation can be `0.1.7` while spec is `1.0.0`. SemVer rules:

- **Patch**: clarifications, typo fixes, no behavioral change
- **Minor**: additive changes (new atom kind, new edge verb, new optional field). Existing atoms still parse and compile under the new spec.
- **Major**: breaking changes (removed kind, renamed verb, changed required field). Migration tooling required.

A spec change at minor or major level is a Tier 2 decision and requires the TC's explicit `+1`.

## Changing this document

This document is governed by Tier 3 rules — public comment, 14-day period, > 50% maintainer consent.
