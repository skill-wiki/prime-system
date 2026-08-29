/**
 * @module @skill-wiki/runtime
 * Immutable corpus-bundle loading and projection resolution.
 *
 * Components:
 * - corpus-snapshot — immutable bundle activation, manifest and digest validation
 * - atom-loader     — global index / atom metadata reads and projection resolution
 *
 * What this package deliberately does NOT own:
 * - Execution and evaluation belong to `packages/action-runtime` (plan §2.3, §9.7, §18.4).
 * - Candidate generation, scoring and budget degradation belong to `packages/query-engine`.
 * - Mutual exclusion, closure and load order belong to `packages/constraint-solver`.
 * - Transport-level projection assembly belongs to `packages/projection-engine`.
 *
 * The former projection-era graph/search/bundle layer (`corpus-graph`, `corpus-index`,
 * `skill-bundler`, `index-manager`, `loader` and their `types`) was the plan §2.2 "B."
 * layer. It was removed rather than made semantics-driven, because doing the latter would
 * have produced a fourth implementation of narrowing logic that the three generic engines
 * above already own (D-3). It carried every one of this package's model-declared closed-set
 * literals; nothing outside this package consumed it in production.
 *
 * `domain-plugin` / `domain-config` (DomainRegistry, discoverDomains, AxisDef, …) went the
 * same way, for the same reason plus a harder one: they were this package's only
 * `@skill-wiki/types` importers and they walked `PrimeAST.body` as `FieldNode[]` to read
 * `domain:` and `tags:`. That is the exact SyntaxAST leak plan §7.1 forbids Runtime to have
 * ("Runtime 只能读取 ArtifactIR"), and Phase 2 acceptance names it: "Runtime 包不 import
 * Parser AST". They had zero consumers outside this package's own tests, so there was no
 * behaviour to preserve — the `domain.yaml` axis/tag vocabulary they loaded is now declared
 * by a Model Package (`@skill-wiki/model-schema`: TypeDefinition, RetrievalProfileSchema),
 * which is where §4.2 puts it. Rewriting them onto UnitIR would have kept a second,
 * unreachable narrowing implementation alive.
 */

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
  SUPPORTED_CORPUS_EMITTER_VERSION,
  type PrimeBundleErrorCode,
  type BundleDiagnostic,
  type CorpusManifest,
  type SnapshotRef,
  type LoadCorpusSnapshotOptions,
  type LoadedCorpusSnapshot,
} from "./corpus-snapshot";
