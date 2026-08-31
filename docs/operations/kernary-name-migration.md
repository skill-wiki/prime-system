# Kernary external name migration

The codebase and documentation use Kernary now. GitHub, npm, Registry, and domain
names remain compatibility locations until each external move is completed and
verified.

## Target layout

| Current | Target |
|---|---|
| `skill-wiki/prime-system` | `kernary/kernary-engine` |
| `skill-wiki/prime-corpus-frontend` | `kernary/kernary-frontend-design` |
| `skill-wiki/skill-wiki.github.io` | `kernary/kernary-docs` plus a custom docs domain |
| outer `kevinflynn0503/prime` workspace | a private or public `kernary-workspace` integration repository |
| `@skill-wiki/*` | `@kernary/*` with a compatibility publication window |
| `prime` CLI | `kernary`; keep `prime` as a deprecated alias for one minor line |

The GitHub organization, domain, and npm scope must be checked for availability
and trademark risk before changing a remote.

## Sequence

1. Reserve the organization, npm scope, package names, and docs domain.
2. Publish the naming ADR and a migration notice from the existing locations.
3. Rename or transfer `prime-system`, Frontend Design, and the docs repository.
   Verify GitHub redirects, clone, issue, release, Pages, and Actions behavior.
4. Update the workspace submodule URLs. Rename local checkout directories only
   after fresh-clone CI passes with the target paths.
5. Publish real `@kernary/*` packages. Publish thin `@skill-wiki/*` compatibility
   packages that depend on or re-export the new package and mark the old names
   deprecated with an exact replacement.
6. Keep `.prime`, `prime/*` protocol IDs, environment variables, and serialized
   Corpus identities stable until a versioned protocol migration exists.
7. Move Pages to the custom domain, install redirects for the old Pages URL, and
   verify canonical, hreflang, sitemap, Open Graph, and JSON-LD output.
8. Run install, compile, query, Action, Registry round-trip, and rollback checks
   from a machine with no old checkout or package cache.

## Stop conditions

Do not continue a stage when the target owner is unavailable, a package cannot be
installed from the public registry, a GitHub redirect breaks submodules, or a
canonical URL points at an unserved host. Roll back the binding or publication;
do not rewrite generated bundle identity to hide a brand migration failure.

## Completion evidence

- fresh clone of every target repository;
- frozen install and full tests from target paths;
- `kernary --version` from the published package;
- old `prime --version` alias emits the same release with a deprecation notice;
- published SDK/MCP/HTTP smoke against a signed external Corpus snapshot;
- old GitHub, npm, and website links redirect to the exact new resource;
- a documented end date for the compatibility publication window.
