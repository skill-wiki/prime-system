# Kernary documentation

Kernary is a model-driven ontology engine for Agents and domain-aware software. These pages describe the
current v0.2 package, snapshot, query, and action contracts.

## Start

- [Define and run a domain ontology](start/index.md)
- [Connect an Agent](guides/connect-agent.md)

## Core concepts

- [Package model](concepts/package-model.md)
- [Compilation and snapshots](concepts/compilation-and-snapshots.md)
- [Selection and execution](concepts/selection-and-execution.md)

## Build and operate

- [Actions and policies](guides/actions-and-policies.md)
- [Releases and migrations](operations/releases-and-migrations.md)

## Reference

- [CLI](reference/cli.md)
- [MCP transport](reference/mcp-transport.md)
- [HTTP and Registry](reference/http-and-registry.md)
- [Terminology](style/terminology.md)

## Content ownership

This repository owns engine documentation. A Domain Package owns its model,
corpus, adapters, tools, and case study. The website renders versioned Markdown
from each owning repository and must fail when an owner source is missing.

Historical decisions are preserved under [legacy](legacy/). Engineering lane
reports are under [internal](internal/) and are not published as user
documentation. Neither directory is part of the current product guide.

[中文](zh-CN/README.md)
