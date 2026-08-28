# `@skill-wiki/runtime` — wired vs experimental modules

The runtime package exports both the **production atom-loader** used by the
MCP server and a set of **experimental modules** that sketch an alternative
runtime API but are not currently wired into any CLI or server entry
point. Tests exercise the experimental modules; production code does not
import them.

> The Method-execution group (`executor.ts`, `evaluator.ts`,
> `ai-step-executor.ts`, `method-loader.ts`) was **deleted on 2026-08-28** — see
> the "Removed" note below.

## Wired (production)

| Module | Consumed by | Purpose |
|---|---|---|
| `atom-loader.ts` | `mcp-server/index.ts` (loadIndex, loadAtomMeta, resolveProjection, resolveCollection) | Reads `_index.xml`; resolves projection-level paths; routes deprecated atoms to a separate bucket so retrieval never serves them. |
| `domain-plugin.ts` (DomainRegistry) + `domain-config.ts` (discoverDomains) | `mcp-server/index.ts` | Domain-aware ranking: domains are loaded at startup from `domain.yaml` files (no hardcoded domains); `rankV3Atoms` boosts atoms whose tags/descriptions match a domain referenced by the brief. |

## Experimental (tests only — not wired)

These modules form a planned execution-and-domain runtime that has not yet
been connected to the MCP server or CLI. They have unit tests and stable
public APIs, but no production caller. Treat them as "design proven, not
shipped." If you import any of these from production code, update this
README so the wiring trail stays honest.

| Module | What it would do | Test file |
|---|---|---|
| `loader.ts` (PrimeLoader) | Resolve and load Prime artifacts from a directory tree | `test/loader.test.ts` |
| `corpus-graph.ts` | In-memory graph of atom edges | `test/corpus-graph.test.ts` |
| `corpus-index.ts` | In-memory atom index by id/kind/tags | `test/corpus-index.test.ts` |
| `index-manager.ts` (IndexManager) | Cache + invalidate corpus index | `test/index-manager.test.ts` |
| `domain-plugin.ts` (DomainRegistry) | Domain plugin registration; the "Domain Plugin Protocol" called out in PRIME-SPEC §11 as missing | `test/domain-plugin.test.ts` |
| `skill-bundler.ts` | Bundle a set of atoms into a deployable Skill artifact | `test/skill-bundler.test.ts` (consumed by `scripts/emit-skill-bundle.ts`) |

### Removed 2026-08-28 — the Method-execution group

`executor.ts` (PrimeExecutor, 697), `evaluator.ts` (EvaluationEngine, 361),
`ai-step-executor.ts` (206) and `method-loader.ts` (56) were **deleted**, along with
`test/executor.test.ts` and `test/evaluator.test.ts`, after measuring zero production
consumers across the whole repo — the only references were this package's own
re-exports in `index.ts` and those two test files.

This is the "if any roadmap item is no longer planned, delete the module" clause at the
bottom of this file being applied, not a regression. Plan §2.3 records them as
experimental, §18.4 says not to wire the current experimental Executor/Evaluator, and
§9.7 forbids shipping the "default all pass" simulated evaluator as a production
guarantee. Their responsibility now sits with `packages/action-runtime`, which
implements authorization / policy / idempotency / retry / timeout / event providers for
real. They were removed outright rather than deprecated behind a shim.

## Why these aren't wired

The remaining 6 experimental modules don't fit the current MCP+atom-loader
architecture:

- **PrimeLoader** is built around *Method-prime execution* — atoms whose body is
  a sequence of decidable / measurable / subjective criteria evaluated
  step-by-step at runtime. The current MCP server doesn't *execute* Method
  primes; agents read their `core.md` text and compose output themselves.
  Wiring it would mean replacing the agent-as-author model with an explicit
  step-machine — a different product.

- **IndexManager** loads a `prime.index` JSON (different format from the
  `_index.xml`) and would duplicate `atom-loader.loadIndex` if forced
  into the same role. The intended consumer is a Skill-bundle runtime that
  ships indexes alongside primes; none exists yet.

- **CorpusGraph / CorpusIndex** are in-memory mirrors of the global graph
  with richer query APIs. The MCP server already has good-enough graph
  access via `_index.xml` + per-atom `relations`. Wiring these would
  reduce code duplication but not unlock new capability.

  Both still hardcode relation names: `corpus-graph.ts:42` declares a closed
  6-name `LinkVerb` union that `index.ts` exports, and `contradicts()` /
  `violations()` / `topologicalOrder()` plus `corpus-index.ts:327,331,333` pass
  those names as string literals instead of reading
  `RelationDefinition.semantics`. That is a §3.1 violation and it is **not**
  fixable inside this package alone — see `docs/lanes/W3-1-RUNTIME-VERTICAL.md` §2.

- **skill-bundler** has one production caller: `scripts/emit-skill-bundle.ts`.
  It's used to produce Skill artifacts from atoms but isn't called by
  MCP/CLI runtime paths.

These modules need a *use case* to justify integration cost. DomainRegistry
is the existence proof that experimental modules can graduate when there's a
real consumer; for the others, no consumer exists yet.

## Roadmap pointers (when each module would graduate)

1. **IndexManager + CorpusGraph + CorpusIndex** would graduate when the
   MCP server's index size gets uncomfortable in memory and we want
   incremental updates / disk-backed caching.
2. **skill-bundler** would graduate when `prime bundle` becomes a
   user-facing CLI verb.

If any roadmap item is no longer planned, the corresponding module should
be deleted — dead exports waste reviewer time.
