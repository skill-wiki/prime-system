/**
 * @module @skill-wiki/query-engine
 *
 * Generic, explainable selection planning. The engine holds retrieval *mechanism*
 * (BM25, facet matching, graph proximity, budgeting, determinism) and holds no
 * retrieval *policy*: which generators run, which feature axes exist and what they
 * weigh comes from a `RetrievalProfile`, and what a relation does to a selection
 * comes from `RelationDefinition.semantics`. There is no default axis name, no
 * default generator registration and no relation name anywhere in this package.
 */

export { buildAdjacency, type Adjacency } from "./adjacency.ts";
export { admit, type AdmissionDenial, type AdmissionResult } from "./admission.ts";
export {
  planBudget,
  resolveProjectionChain,
  type BudgetRejection,
  type BudgetResult,
  type ProjectionAssignment,
} from "./budget.ts";
export { SCORE_PRECISION, quantize } from "./deterministic.ts";
export {
  degradeToFit,
  type BudgetHandoff,
  type DegradationResult,
} from "./degrade.ts";
export {
  planSelection,
  runRetrieval,
  type PlanSelectionOptions,
  type RetrievalResult,
} from "./engine.ts";
export {
  planWithConstraints,
  toRelationDefIR,
  type ConstrainedPlan,
  type ConstrainedPlanOptions,
} from "./solver-bridge.ts";
export {
  expandSelection,
  findExclusions,
  type ExclusionPair,
  type ExpansionResult,
  type OrderConstraint,
} from "./expansion.ts";
export { describeFacet, matchedFacets, matchesFacet } from "./facets.ts";
export { createFacetGenerator, type FacetGeneratorConfig } from "./generators/facet.ts";
export { createGraphGenerator, type GraphGeneratorConfig } from "./generators/graph.ts";
export { createLexicalGenerator, type LexicalGeneratorConfig } from "./generators/lexical.ts";
export {
  CandidateGeneratorRegistry,
  createUnimplementedGenerator,
} from "./generators/registry.ts";
export { orderByLoadOrder, type LoadOrderResult } from "./loadorder.ts";
export { scoreCandidates, type GeneratorOutput, type ScoringResult } from "./scoring.ts";
export {
  QueryEngineError,
  diagnostic,
  type CandidateGenerator,
  type FacetSelector,
  type GeneratorContext,
  type Principal,
  type QueryEngineContext,
  type QueryRequest,
  type TokenCostModel,
  type UnitLifecycle,
  type UnitVisibility,
} from "./types.ts";
export { collectStrings, resolvePath, typedValueMatches } from "./values.ts";
