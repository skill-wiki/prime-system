---
name: prime-author
description: Author or revise `.prime` source units against the external Model and Corpus Packages in the current project. Use for adding typed knowledge, fixing corpus diagnostics, decomposing source material into model-valid units, or preparing a gated corpus build. Do not use merely to query or consume a compiled corpus.
---

# Prime Author

Author source declarations; never hand-edit compiled artifacts.

## Establish the contract

Locate the owning `prime-corpus.yaml` and its Model Package before choosing a
type, field or relation. Read definitions from that model. Do not assume the v1
compatibility model, a fixed kind list, or relation names remembered from another
corpus.

Use existing sources only as style examples after the model establishes what is
legal. If the requested concept has no suitable declared type or field, report
the model gap or update the external model when that is in scope; do not patch
Parser, Compiler or Runtime to add domain semantics.

## Write source

- Write into the Corpus Package's source directory.
- Preserve declared namespace and ID conventions.
- Use only fields and relations the loaded model declares.
- Put redistribution terms and provenance in the protocol `_meta` object when
  the corpus policy requires them.
- Keep citations and upstream attribution accurate; never infer a licence from
  silence.
- Do not write `_index.xml`, `atom.yaml`, projection chunks,
  `corpus.manifest.json` or `model.lock`.

## Validate and build

Prefer the owning package's scripts because they bind the correct model, corpus
identity and release policy. The repository-specific commands and failure rules
are in [references/workflow.md](references/workflow.md); read it when a build,
release or diagnostic repair is requested.

Review diagnostics by source and code. A skipped optional stage is not a pass.
Do not remove a relation, field or unit merely to make a gate green without
recording the semantic disposition.

Publishing, registry writes and release activation are separate external
mutations. Perform them only when the user explicitly requests that step.
