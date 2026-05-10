<p align="center">
  <img src="./docs/assets/logo.svg" alt="Skill Wiki" width="420" />
</p>

# Skill Wiki

> Typed atoms, edge graph, lazy projection — a protocol layer for AI knowledge.

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![Spec](https://img.shields.io/badge/spec-v1.0-green.svg)](./spec/PRIME-PROTOCOL-v1.md)
[![Node](https://img.shields.io/badge/node-22%2B-brightgreen.svg)](#install)
[![CI](https://img.shields.io/badge/ci-parser%20%C2%B7%20compiler%20%C2%B7%20runtime-blue.svg)](./.github/workflows/ci.yml)

[English](./README.md) · [中文](./README.zh-CN.md) · [Protocol Spec](./spec/PRIME-PROTOCOL-v1.md) · [Architecture](./docs/architecture.md) · [Philosophy](./docs/philosophy.md) · [Docs](./docs)

---

Skill Wiki treats domain knowledge — design rules, security checks, writing voice, taxonomies — as **typed atoms with a declared edge graph, retrieved on demand**. Agents see a ~3 KB index of what exists. Specific atoms load only when the brief needs them.

> **Existence ≠ content.** This is the load-bearing line of the whole design.

<p align="center">
  <img src="./docs/assets/architecture-system.png" alt="Skill Wiki system architecture — 8 layers from entry to model" width="780" />
</p>

---

## Install

Requires **Node 22+**.

```bash
git clone https://github.com/skill-wiki/prime-system.git
cd prime-system
bun install
bun run build
```

```bash
bun run packages/cli/src/index.ts --version
# prime 0.1.0
```

---

## Quickstart

```bash
cd examples/hello-world
bun ../../scripts/build-atom-dirs.ts --src primes/sources --out primes/compiled
prime list
PRIME_DIR=primes/compiled bun ../../packages/mcp-server-core/src/index.ts
```

Wire into Claude Code (see [docs/mcp.md](./docs/mcp.md)):

```json
{
  "mcpServers": {
    "skill-wiki": {
      "command": "bunx",
      "args": ["@prime-lang/mcp-server-core"],
      "env": { "PRIME_DIR": "/abs/path/to/compiled" }
    }
  }
}
```

---

## What an atom looks like

```prime
fact WaterBoilsAt100C {
  id: "@example/fact-water-boils-at-100c"
  version: "1.0.0"

  statement: "Pure water boils at 100°C (212°F) at 1 atmosphere of pressure."
  confidence: 0.99
  domain: physics

  related: [
    @example/term-celsius,
    @example/rule-altitude-affects-boiling,
  ]

  validates-with: [
    @example/source-nist-water-properties,
  ]
}
```

The kinds split into a small **core set** that any corpus uses, and a
larger pool that fits some domains better than others. Pick what's
useful; ignore the rest.

| Layer | Kinds |
|---|---|
| **Data** | `fact` `term` `value` `category` `example` `counter-example` `source` `metric` |
| **Behavior** | `step` `check` `transform` `tool` `method` |
| **Composition** | `rule` `taxonomy` `pattern` `anti-pattern` `type` `constraint` |
| **Meta** | `collection` `scope` `tradeoff` `principle` `feedback` |
| **Voice & style** *(design / content / brand corpora)* | `persona` `voice` `template` `provocation` |

The voice-and-style row is where the bundled frontend-design corpus
spends most of its mass — `persona-stripe-fintech`, `voice-magazine-
editorial`, `template-card-hover-lift`. A security or compliance corpus
typically uses the first three rows and skips this one entirely.

14 typed edge verbs: `requires` `enhances` `validates-with` `contradicts`
`specializes` `conflicts` `extends` `derived-from` `compatible` `supplies-to`
`see-also` `includes` `related` `relationships`.

### Adding a kind or a verb your domain needs

The 28 + 14 set is fixed in the parser today. Adding a new kind or verb
takes a parser-level patch and a Tier-2 RFC (see [docs/community/governance.md](./docs/community/governance.md)).
The path is documented in [docs/dsl-quickref.md](./docs/dsl-quickref.md#extending) —
edit `packages/types/src/ast.ts`, add a token in `packages/parser/src/lexer.ts`,
add a chunker case, write a fixture, ship the PR. The same path covers
new edge verbs.

A YAML-declared `custom-kind` form that bypasses the parser patch is on
[the roadmap](./docs/community/roadmap.md).

---

## Claude Code slash commands

Five `/prime-*` commands ship in [`.claude/commands/`](./.claude/commands/) so Claude Code users can drive Prime workflows in one keystroke.

- `/prime-resolve <brief>` — resolve a brief into concrete typed atoms via the `prime_resolve` MCP tool.
- `/prime-compile <src>` — compile a source directory and report atoms, edges, and build errors.
- `/prime-validate <artifact> <brief>` — validate a built artifact against a Prime brief contract.
- `/prime-author <kind> <name>` — scaffold a new `.prime` source file with the right fields for the kind.
- `/prime-publish <src>` — compile a corpus and prep a draft PR against `skill-wiki.github.io`.

Use them at the project level out of the box, or copy globally with `cp -r .claude/commands/prime-*.md ~/.claude/commands/`. See [`.claude/commands/README.md`](./.claude/commands/README.md) for details.

---

## Documentation

| | EN | 中文 |
|---|---|---|
| Getting started | [getting-started](./docs/getting-started.md) | [入门](./docs/zh-CN/getting-started.md) |
| Architecture | [architecture](./docs/architecture.md) | [架构](./docs/zh-CN/architecture.md) |
| Philosophy | [philosophy](./docs/philosophy.md) | [设计哲学](./docs/zh-CN/philosophy.md) |
| DSL quick reference | [dsl-quickref](./docs/dsl-quickref.md) | [DSL 速查](./docs/zh-CN/dsl-quickref.md) |
| CLI reference | [cli](./docs/cli.md) | [CLI](./docs/zh-CN/cli.md) |
| MCP server | [mcp](./docs/mcp.md) | [MCP](./docs/zh-CN/mcp.md) |
| Registry | [registry](./docs/registry.md) | [Registry](./docs/zh-CN/registry.md) |
| Corpus authoring | [corpus-authoring](./docs/corpus-authoring.md) | [写 corpus](./docs/zh-CN/corpus-authoring.md) |
| Comparison | [comparison](./docs/comparison.md) | [对比](./docs/zh-CN/comparison.md) |
| FAQ | [faq](./docs/faq.md) | [FAQ](./docs/zh-CN/faq.md) |
| Known issues | [known-issues](./docs/known-issues.md) | [已知问题](./docs/zh-CN/known-issues.md) |
| Protocol Spec | [PRIME-PROTOCOL-v1.md](./spec/PRIME-PROTOCOL-v1.md) | — |

---

## Status

- **Spec:** v1.0, frozen as of 2026-05-07.
- **Implementation:** ~75% of v1 spec. Parser, compiler L1+L3, runtime, registry, CLI, generic MCP server — all built and tested.
- **Optional:** L2 semantic checker (DeepSeek, ~$0.0001/atom) — gated by `DEEPSEEK_API_KEY`.
- **Honest gaps:** lifecycle / `deprecated` warning enforcement, structured AST for type expressions, formal domain plugin protocol. See [ROADMAP.md](./docs/community/roadmap.md).

---

## Contributing

Read [.github/CONTRIBUTING.md](./.github/CONTRIBUTING.md) before opening a pull request and follow the [PR template](./.github/PULL_REQUEST_TEMPLATE.md). For questions and ideas, use [Discussions](https://github.com/skill-wiki/skill-wiki.github.io/discussions); for defects or proposals, file an [issue](https://github.com/skill-wiki/prime-system/issues).

---

## License

[Apache License 2.0](./LICENSE). Patent grant included; redistribution must keep [NOTICE](./NOTICE) intact.
