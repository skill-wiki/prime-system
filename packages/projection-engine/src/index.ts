/**
 * @module @aoe/projection-engine
 *
 * Model-driven projection selection, transport and redaction over compiled
 * bundles. Contains zero domain vocabulary: every profile, level, field list and
 * policy label arrives as Model Package data.
 */

export {
  ProjectionPathError,
  requireBundlePath,
  resolveBundlePath,
  type PathRejectionCode,
  type PathResolution,
} from "./paths.ts";

export {
  AOE_URI_SCHEME,
  formatProjectionUri,
  parseProjectionUri,
  type ProjectionUri,
  type UriParseResult,
} from "./uri.ts";

export {
  ProjectionCatalog,
  levelFromDefinition,
  levelFromIR,
  type ProjectionLevel,
  type ProjectionProfile,
  type ProjectionRule,
} from "./profile.ts";

export {
  candidateLevels,
  levelAppliesToUnit,
  resolveProfile,
  type CandidateLevels,
  type ConsumerCapability,
  type LevelRejection,
  type ProfileResolution,
  type ProjectionBudget,
  type ProjectionRequest,
  type PurposeRouting,
} from "./select.ts";

export {
  solveBudget,
  type BudgetAssignment,
  type BudgetDegradation,
  type BudgetDrop,
  type BudgetPlan,
  type BudgetUnitInput,
} from "./budget.ts";

export {
  REDACTION_MARKER,
  redactText,
  redactUnitFields,
  type RedactionOutcome,
  type RedactionPolicy,
  type RedactionRule,
} from "./redact.ts";

export {
  contentDigest,
  deliver,
  estimateTokens,
  negotiateTransport,
  resolveUriToPath,
  type ProjectionPayload,
  type TransportKind,
  type TransportOptions,
  type TransportResult,
  type TransportTarget,
} from "./transport.ts";

export {
  ProjectionCache,
  projectionCacheKey,
  type CacheScope,
  type CacheSubject,
} from "./cache.ts";

export {
  ProjectionEngine,
  type ArtifactLocator,
  type ProjectedUnit,
  type ProjectionEngineOptions,
  type ProjectionResult,
  type ProjectionScope,
} from "./engine.ts";

export { atomLoaderAdapter, type AtomLoaderAdapterOptions } from "./adapters/atom-loader.ts";
