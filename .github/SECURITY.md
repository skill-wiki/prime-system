# Reporting issues responsibly

Thank you for helping keep AOE users safe.

## How to report

Please report issues privately. Do not open a public issue.

- Open a [GitHub security advisory](https://github.com/kernary-aoe/kernary-aoe/security/advisories/new) — this is the preferred channel and ensures the disclosure is tracked and acknowledged.

If GitHub advisories are unavailable to you, contact a maintainer listed in `MAINTAINERS.md` directly via the address on their GitHub profile. The repo does not run a shared `security@` mailbox at v0.1.0.

Please include:

1. A clear description of the issue
2. Steps to reproduce, or a minimal proof-of-concept
3. The version / commit you tested
4. Your assessment of impact

## What to expect

- We aim to acknowledge reports within **72 hours**
- We aim to publish a fix and advisory within **90 days** of acknowledgement
- We will credit the reporter in the advisory unless you ask us not to

## Scope

In scope:
- The `@aoe/*` packages in this repository
- The `prime` CLI
- The `mcp-server-core` package
- The example registry server (`scripts/registry-server.ts`) when used as documented

Out of scope:
- Third-party MCP clients connecting to a Prime server
- User-authored `.prime` corpora (these are content, not code)
- Issues in workspace dependencies — please report those upstream

## Supported versions

Only the most recent minor version receives fixes. Pin a specific version in production and review release notes when upgrading.
