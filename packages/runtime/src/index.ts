/**
 * @module @prime-lang/runtime
 * Runtime for loading, executing, and evaluating compiled Primes.
 *
 * Components:
 * - IndexManager  — maintains Prime index, matching, formatting
 * - PrimeLoader   — four-level progressive loading
 * - PrimeExecutor — seven-phase execution engine
 * - EvaluationEngine — criteria evaluation and reporting
 */

export { IndexManager } from "./index-manager";
export { PrimeLoader } from "./loader";
export { PrimeExecutor } from "./executor";
export { EvaluationEngine } from "./evaluator";
export { MethodLoader } from "./method-loader";
export type { CriterionEvaluator } from "./evaluator";
export {
  createAIStepExecutor,
  createMockStepExecutor,
  type AIStepExecutorOptions,
  type AIProvider,
} from "./ai-step-executor";
export * from "./types";
export {
  CorpusGraph,
  LINK_VERBS,
  type LinkVerb,
  type CorpusNode,
  type CorpusEdge,
  type CorpusGraphStats,
  type CorpusGraphOptions,
} from "./corpus-graph";
export {
  CorpusIndex,
  type SearchHit,
  type SearchOptions,
} from "./corpus-index";
export {
  bundleSkill,
  type BundleOptions,
  type BundleResult,
} from "./skill-bundler";
export {
  DomainRegistry,
  type DomainPlugin,
  type DomainDiagnostic,
} from "./domain-plugin";
export {
  loadDomainFromFile,
  discoverDomains,
  registerAll,
  createConfigDrivenRegistry,
  MAX_DISCOVERY_DEPTH,
  type DomainConfig,
  type AxisDef,
  type ContractField,
  type ValidatorDef,
  type LoadedDomainPlugin,
} from "./domain-config";

// ─── Projection-based runtime (v3) ───────────────────────────────────────────
export {
  loadIndex,
  loadAtomMeta,
  resolveProjection,
  resolveCollection,
  type GlobalIndex,
  type GlobalIndexAtom,
  type GlobalIndexCluster,
  type AtomMeta,
  type ProjectionLevel,
  type CollectionResolution,
} from "./atom-loader";
