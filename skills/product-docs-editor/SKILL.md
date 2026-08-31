---
name: product-docs-editor
description: Write or revise Kernary README, guides, concepts, reference, migration, and operations documentation from repository-owned facts. Use when product documentation must stay domain-neutral, runnable, version-accurate, and consistent with the external Model/Corpus package boundary. Do not use for marketing essays or release narratives.
---

# Product Docs Editor

Write for a reader who is trying to complete one task. Establish the page type,
reader state, expected result, and owning source before drafting.

## Ground the page

Read the relevant code, schema, CLI help, or package declaration. Do not copy a
claim from another prose page when a machine-readable or executable owner exists.
Keep these boundaries explicit:

- Kernary fixes the meta-schema, stable IR, artifact contracts, and runtime.
- A Model Package owns domain types, relations, projections, retrieval, actions,
  policies, and validators.
- A Corpus Package owns units, assets, provenance, licence policy, and releases.
- Frontend Design, Ticket, Security, and Recipe are examples, not Core schema.
- A Skill is an optional Agent UX layer. It is not a package type or permission
  boundary.

Read [references/page-types.md](references/page-types.md) when choosing a page
shape. Read [references/release-language.md](references/release-language.md) for
brand migration, compatibility terminology, or public stability claims.

## Draft and verify

- Open with the result or task. Do not repeat the title as a warm-up paragraph.
- Put prerequisites and destructive or security-relevant limits before the step
  they constrain.
- Use only commands that can be run in the current repository. Capture their
  observable success signal.
- Keep conceptual explanation out of reference tables; keep exhaustive fields
  out of tutorials.
- Link to the owning repository instead of maintaining a second handwritten
  copy of reference material.
- Treat skipped checks as skipped, not as passing.

Before finishing, run the relevant examples and scan for stale public facts:
fixed 28/14 domain vocabulary, `domain.yaml` as the current extension mechanism,
old five-tool Frontend Design surfaces, `prime_compile`, `compiled-v3-final`,
899-unit claims, Skill Wiki as the current product name, or Frontend Design as a
built-in/flagship.

Do not force prose through punctuation bans or a universal sentence length.
Technical accuracy, useful ordering, and a named human owner matter more than an
AI-detector score.
