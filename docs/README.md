# Skill Wiki Documentation

[English](./README.md) · [中文](./zh-CN/README.md)

Typed atoms, edge graph, lazy projection — a protocol layer for AI knowledge.

---

## Getting started

- [getting-started](./getting-started.md) — `git clone` to a typed corpus your agent can query, in 10 minutes.

## Concept

- [architecture](./concept/architecture.md) — pipeline, layers, packages: how a brief becomes context.
- [philosophy](./concept/philosophy.md) — *why* the architecture has these shapes.
- [comparison](./concept/comparison.md) — Skill Wiki vs. RAG / Skills / fine-tuning / etc.

## Guides

- [corpus-authoring](./guides/corpus-authoring.md) — write your own typed corpus end-to-end.
- [domain-extension](./guides/domain-extension.md) — add a new domain on top of the protocol.
- [mcp](./guides/mcp.md) — wire the MCP server into Claude Code, Cursor, or any client.

## Reference

- [cli](./reference/cli.md) — every `prime` subcommand and flag.
- [dsl-quickref](./reference/dsl-quickref.md) — the 28 atom kinds and 14 edge verbs.
- [registry](./reference/registry.md) — publish, version, and discover corpora.

## Community

- [roadmap](./community/roadmap.md) — what's planned for v0.2 and beyond.
- [governance](./community/governance.md) — RFC tiers, decision process, voting.
- [maintainers](./community/maintainers.md) — current maintainers and self-nomination path.
- [faq](./community/faq.md) — common questions, including "is this RAG?".
- [known-issues](./community/known-issues.md) — current limitations of v0.1.0.

---

See also: [Protocol Spec v1](../spec/PRIME-PROTOCOL-v1.md) · [Frontend Domain Spec](../spec/FRONTEND-DESIGN-DOMAIN-v1.md) · [repository README](../README.md).
