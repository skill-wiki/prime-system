# Contributing to AOE / Prime

[English](./CONTRIBUTING.md) · [中文](./CONTRIBUTING.zh-CN.md)

Thank you for considering a contribution to the AOE system. This document
is for people extending **the system itself** — the parser, compiler, runtime,
registry, or CLI. If you want to author atoms (knowledge content), you are in the
wrong repo; go to a Domain Package repo (e.g., `aoe-frontend-design`) and follow its
own CONTRIBUTING.

---

## Table of contents

- [What belongs here vs. a corpus repo](#what-belongs-here-vs-a-corpus-repo)
- [Development setup](#development-setup)
- [Project structure](#project-structure)
- [Running tests](#running-tests)
- [Test policy](#test-policy)
- [Writing a new atom kind](#writing-a-new-atom-kind)
- [Writing a new edge verb](#writing-a-new-edge-verb)
- [Versioning: spec vs. implementation](#versioning-spec-vs-implementation)
- [Dependency policy](#dependency-policy)
- [Pull request checklist](#pull-request-checklist)
- [Code of conduct](#code-of-conduct)

---

## What belongs here vs. a corpus repo

**This repo — `aoe-engine`:**
- The `.prime` DSL parser (`packages/parser/`)
- Compiler passes L1, L2, L3 (`packages/compiler/`)
- Runtime: atom loader, projection resolver, domain plugin host (`packages/runtime/`)
- Output validation framework (`packages/validator-core/`, not in v0.1.0)
- Registry HTTP service (`packages/registry/`)
- The `prime` CLI (`packages/cli/`)
- Generic MCP server (`packages/mcp-server-core/`)
- The protocol spec (`spec/PRIME-PROTOCOL-v1.md`)
- Example corpora (`examples/`)
- System-level tests

**A Domain Package repo (e.g., `aoe-frontend-design`):**
- Atom `.prime` source files
- Domain-specific intent classifier
- Domain-specific retrieval logic
- Domain-specific MCP wrapper tools
- Atom authoring guides

If your change introduces new atoms or domain-specific logic, it goes in the
corpus repo. If it changes the protocol — how atoms are parsed, compiled,
retrieved, or served — it goes here.

---

## Development setup

Requirements:

- **Node 22+** (for native TypeScript strip via `--experimental-transform-types`)
- **Bun** (recommended for faster install and test runs; npm and pnpm also work)

```bash
git clone https://github.com/kernary-aoe/aoe-engine.git
cd aoe-engine
bun install
bun run build
```

Verify the build:

```bash
bun run packages/cli/src/index.ts --version
# prime 0.1.0
```

Run the full test suite:

```bash
bun run test
```

Run only the parser tests:

```bash
bun run test --filter packages/parser
```

Smoke-compile an example corpus:

```bash
bun run packages/cli/src/index.ts compile examples/hello-world/primes/sources \
  --out examples/hello-world/primes/compiled
```

---

## Project structure

```
packages/
├── parser/           # .prime DSL lexer + recursive-descent parser
│   ├── src/
│   │   ├── lexer.ts          # tokenizer
│   │   ├── parser.ts         # recursive descent
│   │   ├── grammar.ts        # atom-kind schemas (field requirements)
│   │   └── ast.ts            # AST node types
│   └── tests/
├── types/            # Shared TypeScript types
│   └── src/
│       ├── atom.ts           # AtomKind, AtomRef, Atom
│       ├── edge.ts           # EdgeVerb, Edge
│       └── projection.ts     # ProjectionLevel, AtomProjection
├── compiler/         # L1 / L2 / L3 passes + atom-dir emitter
│   ├── src/
│   │   ├── l1-checker.ts     # structural validation
│   │   ├── l2-checker.ts     # semantic LLM check (opt-in)
│   │   ├── l3-checker.ts     # cross-atom graph checks
│   │   ├── chunker.ts        # projection emitter (summary/core/full)
│   │   ├── edge-resolver.ts  # resolves @ref targets; builds adjacency
│   │   └── emitter.ts        # writes atom dirs to output
│   └── tests/
├── runtime/          # Atom loader + projection resolver + domain plugin host
│   └── src/
│       ├── loader.ts         # loads compiled/*.json into memory
│       ├── projection.ts     # resolves summary/core/full on demand
│       └── domain-host.ts    # plugin interface (stub in v0.1.0)
├── validator-core/   # Generic 3-layer output validation framework (not in v0.1.0)
│   └── src/
│       ├── l1-validator.ts   # structure check
│       ├── l2-validator.ts   # LLM-backed semantic check
│       └── l3-validator.ts   # composition contract check
├── registry/         # HTTP package registry
│   └── src/
│       ├── server.ts         # Express server, publish (PUT) + install (GET)
│       └── auth.ts           # token-based auth
├── cli/              # The `prime` command
│   └── src/
│       ├── index.ts          # entry point, verb dispatch
│       └── commands/         # one file per verb
└── mcp-server-core/  # Generic MCP server (~200 lines)
    └── src/
        └── server.ts         # aoe_query over any compiled corpus
```

---

## Running tests

| Command | What it runs |
|---|---|
| `bun run test` | All packages |
| `bun run test --filter packages/parser` | Parser tests only |
| `bun run test --filter packages/compiler` | Compiler tests only |
| `bun run test --filter packages/runtime` | Runtime tests only |
| `bun run test:integration` | End-to-end: compile examples + registry round-trip |
| `bun run check-registry` | Registry publish + install smoke test |

CI runs all of the above on every push to `main` and on every pull request.

---

## Test policy

Contributions without tests will not be merged. The following rules are
non-negotiable:

**Parser changes:**
- Every new syntax feature must have at least one positive test (parses
  correctly) and one negative test (fails with the expected error message).
- Tests live in `packages/parser/tests/`. Add a new file for a new feature;
  do not append to an unrelated test file.
- Parser tests must be deterministic — no external network calls.

**Compiler changes:**
- New L1 checks require a unit test demonstrating the check fires on a
  violating input and passes on a valid input.
- New L3 checks require an integration test that compiles a small corpus
  containing the violation and asserts the error appears in the compiler output.
- L2 changes (semantic checker) require a mock for the LLM call — do not make
  real API calls in CI.

**Runtime changes:**
- Changes to the loader, projection resolver, or domain plugin host require a
  smoke test that compiles `examples/hello-world/` and loads at least one atom
  at each projection level (summary, core, full).
- Smoke tests live in `packages/runtime/tests/smoke.test.ts`.

**CLI changes:**
- New verbs require a test that invokes the verb against `examples/hello-world/`
  and asserts the exit code and stdout shape.

**Registry changes:**
- The publish + install round-trip test must pass (`bun run check-registry`).

---

## Writing a new atom kind

Adding a first-class atom kind requires changes in three places:

**1. `packages/types/src/atom.ts`**

Add the new kind to the `AtomKind` union type.

```typescript
export type AtomKind =
  | "fact" | "rule" | "pattern" | /* ... existing ... */
  | "your-new-kind";
```

**2. `packages/parser/src/grammar.ts`**

Add the schema for the new kind: which fields are required, which are optional,
and their types.

```typescript
export const ATOM_SCHEMAS: Record<AtomKind, AtomSchema> = {
  // ... existing kinds ...
  "your-new-kind": {
    required: ["claim", "scope"],
    optional: ["rationale", "examples"],
  },
};
```

**3. `packages/compiler/src/chunker.ts`**

Add a case to the projection emitter that decides which fields appear in the
`summary`, `core`, and `full` projections for your kind. The rule of thumb:

- `summary`: the one or two fields that identify the atom (typically `id` +
  the "headline" field).
- `core`: the fields an agent needs to act on the atom without the full detail.
- `full`: all semantically meaningful fields.

After those three changes, write parser tests and compiler integration tests as
described in [Test policy](#test-policy), then open a PR.

**Proposing a new kind formally:** if the kind is intended to be part of the
spec (not just a custom kind for your corpus), open a discussion issue first.
The spec is versioned independently; adding a kind to the spec requires a
concrete use case, sample atoms, and a proposed schema. Spec changes are batched
into spec minor releases.

---

## Writing a new edge verb

Edge verbs are simpler to add than atom kinds because they are orthogonal to
atom schemas.

**1. `packages/types/src/edge.ts`**

Add the verb to the `EdgeVerb` union type.

```typescript
export type EdgeVerb =
  | "related" | "requires" | /* ... existing ... */
  | "your-new-verb";
```

**2. `packages/parser/src/grammar.ts`**

Add the verb to the `EDGE_VERBS` set so the parser accepts it in edge
declarations.

**3. `packages/compiler/src/l3-checker.ts`**

Decide whether the new verb needs any L3 semantics. For example:
- `requires` triggers transitive closure validation.
- `contradicts` triggers a must-not-coexist flag.
- A purely informational verb (like `see-also`) needs no L3 logic.

If your verb implies a constraint, implement it here and add an integration test.

**4. Spec implications:** if the verb has semantic meaning beyond a label, it
belongs in the spec (`spec/PRIME-PROTOCOL-v1.md §2`). Document its semantics in the
same PR. Purely project-local verbs should use `relationships` (the catch-all)
until they are proven worth formalizing.

---

## Versioning: spec vs. implementation

The protocol specification (`spec/PRIME-PROTOCOL-v1.md`) is versioned independently
of the implementation packages.

- **Spec version** (`v1.0`, `v1.1`, …): tracks which atom kinds, edge verbs, and
  protocol semantics are officially supported. The spec is frozen at v1.0 for
  the initial release. Changes to the spec require a spec PR with a discussion
  period.
- **Implementation version** (`packages/*/package.json`): tracks the software
  release. Implementation versions follow semver independently of the spec.

A change that modifies only how the compiler emits JSON — without changing what
is valid `.prime` syntax — bumps only the implementation version. A change that
adds a new atom kind or edge verb to the grammar bumps the spec version.

The compiler's build output includes a `[spec: vX]` tag so that corpus authors
know which spec the compiler implemented.

---

## Dependency policy

The AOE system is intentionally kept lean. Adding a new runtime dependency
requires justification.

**Rules:**

1. **No new runtime dependencies without a justification comment in the PR.**
   "It's convenient" is not a justification. "It replaces 200 lines of code
   that would otherwise need to be maintained" is.

2. **Zero new dependencies that require native compilation** (binaries, `.node`
   files, WASM blobs) without a discussion issue first. These break the
   "install anywhere that Node 22 runs" guarantee.

3. **Dev dependencies are less constrained** but should still be reviewed.
   Prefer tools already used in the project (Bun test runner, TypeScript, etc.)
   over introducing new test frameworks.

4. **Vendoring.** If a dependency is small (<200 lines) and stable, consider
   copying it into `packages/<pkg>/vendor/` with its license header rather than
   taking a registry dependency.

---

## Pull request checklist

Before opening a PR, confirm:

- [ ] All existing tests pass (`bun run test`).
- [ ] New tests are included for the change (see [Test policy](#test-policy)).
- [ ] `bun run build` succeeds with no TypeScript errors.
- [ ] `bun run test:integration` passes (compile examples + registry round-trip).
- [ ] If a new atom kind: `packages/types/`, `packages/parser/grammar.ts`, and
      `packages/compiler/chunker.ts` are all updated.
- [ ] If a new edge verb: `packages/types/`, `packages/parser/grammar.ts`, and
      `packages/compiler/l3-checker.ts` are all reviewed.
- [ ] If a spec-level change: `spec/PRIME-PROTOCOL-v1.md` is updated in the same PR.
- [ ] No new runtime dependencies without a justification comment.
- [ ] PR description explains **why** the change is needed, not just **what** it
      does.
- [ ] The PR title follows the project convention:
      `feat(scope): description`, `fix(scope): description`, etc.

---

## Code of conduct

This project follows the [Contributor Covenant 2.1](./CODE_OF_CONDUCT.md).
Participate in good faith. Harassment of any kind is not tolerated.

---

*AOE v0.1.0 · Apache-2.0*
