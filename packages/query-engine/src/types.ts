/**
 * @module types
 *
 * The engine's vocabulary. Every name here is either structural (it exists in
 * `UnitIR`/`GraphIR`) or supplied by the caller. There is deliberately no
 * enumeration of unit kinds, relation names, tag names or feature axes: those
 * are model data, and an engine that spells any of them out has re-hardcoded
 * the domain it was built to remove.
 */

import type {
  DiagnosticIR,
  GraphEdgeIR,
  GraphIR,
  SelectionCandidateIR,
  UnitIR,
  ValueIR,
} from "@skill-wiki/ir";
import type { ProjectionDefinition, RelationDefinition, RetrievalProfile } from "@skill-wiki/model-schema";

export type UnitVisibility = UnitIR["visibility"];
export type UnitLifecycle = UnitIR["lifecycle"];

/**
 * The identity a request runs as. Visibility and label grants are the whole ACL
 * surface the engine understands; anything richer belongs in a policy engine
 * that produces these two sets.
 */
export interface Principal {
  readonly id: string;
  /** Unit visibilities this principal may observe at all. */
  readonly allowedVisibility: readonly UnitVisibility[];
  /** Policy labels this principal holds. A unit needs *every* label it carries. */
  readonly grantedPolicyLabels: readonly string[];
}

/**
 * A facet is a structural predicate over a unit. `field` addresses `UnitIR.fields`
 * by path, so the caller names the field and the engine never does.
 */
export type FacetSelector =
  | { readonly kind: "typeRef"; readonly anyOf: readonly string[] }
  | { readonly kind: "implements"; readonly anyOf: readonly string[] }
  | { readonly kind: "field"; readonly path: readonly string[]; readonly anyOf: readonly ValueIR[] };

export interface QueryRequest {
  readonly requestId: string;
  /** Name of the `RetrievalProfile` that supplies generators, axes and weights. */
  readonly profile: string;
  readonly principal: Principal;
  /** Token budget for the projection plan. Must be a positive integer. */
  readonly maxTokens: number;
  readonly text?: string;
  /** Starting units for graph-proximity generation. */
  readonly seeds?: readonly string[];
  /** Soft facets: they contribute a feature value, they do not exclude. */
  readonly facets?: readonly FacetSelector[];
  /** Hard facets: a unit failing any of them is rejected before scoring. */
  readonly requiredFacets?: readonly FacetSelector[];
  /** Lifecycles admitted. When omitted every lifecycle is admitted. */
  readonly lifecycles?: readonly UnitLifecycle[];
  /** Maximum ranked candidates carried into expansion and budgeting. */
  readonly limit?: number;
  /** Cheaper projections to fall back to when the primary one does not fit. */
  readonly fallbackProjections?: readonly string[];
}

/**
 * Token cost of rendering one unit through one projection. Supplied by the host
 * because only the host has the compiled artifacts; when absent the engine falls
 * back to the projection's declared `targetTokens`.
 */
export type TokenCostModel = (unitId: string, projectionRef: string) => number | undefined;

export interface QueryEngineContext {
  readonly graph: GraphIR;
  readonly profiles: Readonly<Record<string, RetrievalProfile>>;
  readonly relations: Readonly<Record<string, RelationDefinition>>;
  readonly projections: Readonly<Record<string, ProjectionDefinition>>;
  readonly tokenCost?: TokenCostModel;
}

/** What a generator is handed. The graph it receives is already ACL-filtered. */
export interface GeneratorContext {
  readonly profile: RetrievalProfile;
  readonly relations: Readonly<Record<string, RelationDefinition>>;
  readonly unitsById: ReadonlyMap<string, UnitIR>;
  /** Outgoing edges per unit id, pre-sorted for deterministic traversal. */
  readonly outgoing: ReadonlyMap<string, readonly GraphEdgeIR[]>;
  /** Incoming edges per unit id. Needed because a relation may be non-directional. */
  readonly incoming: ReadonlyMap<string, readonly GraphEdgeIR[]>;
  /** Generators surface data problems here instead of throwing or logging. */
  report(diagnostic: DiagnosticIR): void;
}

/**
 * The pluggable retrieval SPI. A generator declares the feature axes it writes
 * so the scorer can tell "axis produced but unweighted" from "axis absent".
 */
export interface CandidateGenerator {
  readonly name: string;
  readonly featureAxes: readonly string[];
  generate(
    request: QueryRequest,
    graph: GraphIR,
    ctx: GeneratorContext,
  ): readonly SelectionCandidateIR[];
}

/** Carries diagnostics rather than a bare string so callers can render them. */
export class QueryEngineError extends Error {
  readonly diagnostics: readonly DiagnosticIR[];

  constructor(diagnostics: readonly DiagnosticIR[]) {
    super(diagnostics.map(d => `${d.code}: ${d.message}`).join("; "));
    this.name = "QueryEngineError";
    this.diagnostics = diagnostics;
  }
}

export function diagnostic(
  code: string,
  message: string,
  severity: DiagnosticIR["severity"],
  path?: readonly string[],
): DiagnosticIR {
  return path === undefined ? { code, message, severity } : { code, message, severity, path };
}

export function fail(code: string, message: string, path?: readonly string[]): never {
  throw new QueryEngineError([diagnostic(code, message, "error", path)]);
}
