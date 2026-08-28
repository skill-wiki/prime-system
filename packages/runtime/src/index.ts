/**
 * @module @skill-wiki/runtime
 * Runtime for loading and querying compiled Prime corpora.
 *
 * Components:
 * - IndexManager  — maintains Prime index, matching, formatting
 * - PrimeLoader   — four-level progressive loading
 * - CorpusGraph / CorpusIndex — corpus-level graph and search
 * - corpus-snapshot / atom-loader — immutable bundle loading and projection
 *
 * Execution and evaluation are NOT part of this package. `packages/action-runtime`
 * owns them via its authorization/policy/idempotency provider system; the former
 * experimental `PrimeExecutor` / `EvaluationEngine` here were removed rather than
 * shimmed, per plan §2.3, §9.7 and §18.4.
 */

export { IndexManager } from "./index-manager";
export { PrimeLoader } from "./loader";
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
export {
  loadCorpusSnapshot,
  computeCorpusContentDigest,
  compareCanonicalStrings,
  CORPUS_NONARTIFACT_NOISE,
  validateCorpusManifest,
  validateCorpusManifestCompatibility,
  PrimeBundleError,
  CORPUS_MANIFEST_FILE,
  CORPUS_INDEX_FILE,
  SUPPORTED_CORPUS_PROTOCOL_MAJOR,
  SUPPORTED_CORPUS_IR_VERSION,
  type PrimeBundleErrorCode,
  type BundleDiagnostic,
  type CorpusManifest,
  type SnapshotRef,
  type LoadCorpusSnapshotOptions,
  type LoadedCorpusSnapshot,
} from "./corpus-snapshot";
