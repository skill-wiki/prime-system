# `@prime-lang/runtime` — wired vs experimental modules

The runtime package exports both the **production atom-loader** used by the
MCP server and a set of **experimental modules** that sketch an alternative
runtime API but are not currently wired into any CLI or server entry
point. Tests exercise the experimental modules; production code does not
import them.

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
| `method-loader.ts` | Specialised loader for Method primes | (no dedicated test) |
| `executor.ts` (PrimeExecutor) | Step-by-step execution of Method primes | `test/executor.test.ts` |
| `evaluator.ts` (EvaluationEngine) | Predicate/threshold evaluation for Rule primes | `test/evaluator.test.ts` |
| `ai-step-executor.ts` | LLM-backed Method step executor | (covered indirectly via executor tests) |
| `corpus-graph.ts` | In-memory graph of atom edges | `test/corpus-graph.test.ts` |
| `corpus-index.ts` | In-memory atom index by id/kind/tags | `test/corpus-index.test.ts` |
| `index-manager.ts` (IndexManager) | Cache + invalidate corpus index | `test/index-manager.test.ts` |
| `domain-plugin.ts` (DomainRegistry) | Domain plugin registration; the "Domain Plugin Protocol" called out in PRIME-SPEC §11 as missing | `test/domain-plugin.test.ts` |
| `skill-bundler.ts` | Bundle a set of atoms into a deployable Skill artifact | `test/skill-bundler.test.ts` (consumed by `scripts/emit-skill-bundle.ts`) |

## Why these aren't wired

The remaining 9 experimental modules form a coherent **alternative runtime
model** that doesn't fit the current MCP+atom-loader architecture:

- **PrimeLoader / PrimeExecutor / EvaluationEngine / ai-step-executor** are
  built around *Method-prime execution* — atoms whose body is a sequence of
  decidable / measurable / subjective criteria evaluated step-by-step at
  runtime. The current MCP server doesn't *execute* Method primes; agents
  read their `core.md` text and compose HTML themselves. Wiring these would
  mean replacing the agent-as-author model with an explicit step-machine — a
  different product.

- **IndexManager** loads a `prime.index` JSON (different format from the
  `_index.xml`) and would duplicate `atom-loader.loadIndex` if forced
  into the same role. The intended consumer is a Skill-bundle runtime that
  ships indexes alongside primes; none exists yet.

- **CorpusGraph / CorpusIndex** are in-memory mirrors of the global graph
  with richer query APIs. The MCP server already has good-enough graph
  access via `_index.xml` + per-atom `relations`. Wiring these would
  reduce code duplication but not unlock new capability.

- **method-loader** is a specialised loader for Method primes; same fate
  as PrimeLoader.

- **skill-bundler** has one production caller: `scripts/emit-skill-bundle.ts`.
  It's used to produce Skill artifacts from atoms but isn't called by
  MCP/CLI runtime paths.

These modules need a *use case* to justify integration cost. DomainRegistry
is the existence proof that experimental modules can graduate when there's a
real consumer; for the others, no consumer exists yet.

## Roadmap pointers (when each module would graduate)

1. **PrimeExecutor + EvaluationEngine** would graduate when a tool /
   sub-agent appears that needs to RUN a Method prime end-to-end (e.g. an
   automated audit that walks every check and reports pass/fail). Today
   the agent does this informally by reading the markdown.
2. **IndexManager + CorpusGraph + CorpusIndex** would graduate when the
   MCP server's index size gets uncomfortable in memory and we want
   incremental updates / disk-backed caching.
3. **skill-bundler** would graduate when `prime bundle` becomes a
   user-facing CLI verb.
4. **method-loader** would graduate alongside PrimeExecutor.

If any roadmap item is no longer planned, the corresponding module should
be deleted — dead exports waste reviewer time.
