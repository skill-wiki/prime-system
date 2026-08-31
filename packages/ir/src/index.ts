/** JSON-friendly, readonly IR contracts. Records use stable string keys. */
export type OpaqueRef<T extends string> = string & { readonly __opaqueRef?: T };
export type TypeRef = OpaqueRef<"TypeRef">;
export interface SnapshotRef { readonly modelRelease: string; readonly modelDigest: string; readonly corpusRelease: string; readonly corpusDigest: string }
export type BundleSnapshotRef = SnapshotRef;
export interface DiagnosticIR { readonly code: string; readonly message: string; readonly path?: readonly string[]; readonly severity: "error" | "warning" | "info" }
export type ValueIR = null | boolean | number | string | readonly ValueIR[] | { readonly [key: string]: ValueIR };
export interface SourceLocationIR { readonly line: number; readonly column: number; readonly offset: number }
export interface SourceRefIR { readonly filename?: string; readonly loc: SourceLocationIR }
export type TypedValueIR =
  | { readonly kind: "string"; readonly value: string; readonly source: SourceRefIR; readonly declaredTypeRef?: string }
  | { readonly kind: "number"; readonly value: number; readonly source: SourceRefIR; readonly declaredTypeRef?: string }
  | { readonly kind: "boolean"; readonly value: boolean; readonly source: SourceRefIR; readonly declaredTypeRef?: string }
  | { readonly kind: "reference"; readonly path: readonly string[]; readonly target: string; readonly alias?: string; readonly source: SourceRefIR; readonly declaredTypeRef?: string }
  | { readonly kind: "array"; readonly items: readonly TypedValueIR[]; readonly source: SourceRefIR; readonly declaredTypeRef?: string }
  | { readonly kind: "object"; readonly fields: Readonly<Record<string, TypedValueIR>>; readonly source: SourceRefIR; readonly declaredTypeRef?: string };
export interface TypeDefIR { readonly name: string; readonly version: string; readonly fields: Readonly<Record<string, TypeRef>> }
export type TraversalIR = "none" | "one-hop" | "transitive";
export type SelectionSemanticsIR = "informational" | "expand" | "closure" | "exclude";
/**
 * For an edge `from -> to`, `before` means the **target** (`to`) is loaded before
 * the **source** (`from`) — the edge points at the prerequisite — and `after`
 * means `from` is loaded before `to`.
 *
 * The convention is stated here because the model schema carries only the enum,
 * and because every consumer that implements ordering has to agree on it. The
 * evidence is `compat/prime-v1-model/relations.yaml`, which annotates `extends`
 * (`loadOrder: before`) with `protocolSemantic: target-base-precedes-source`;
 * `A extends B` yields `from=A, to=B`, so the target/base precedes the source.
 * `requires` reads the same way: `A requires B` loads the dependency `B` first.
 *
 * A relation whose declared value contradicts how its corpus uses it is therefore
 * a data bug in the model package, not an implementation difference between
 * engines.
 */
export type LoadOrderIR = "none" | "before" | "after";
export type CyclePolicyIR = "allow" | "reject" | "collapse";
export type ConflictSeverityIR = "none" | "warning" | "error";
/**
 * The closed five-field relation semantics. Typed once here so that no consumer
 * re-declares the vocabulary: a second copy is how two engines end up disagreeing
 * about what `before` means.
 *
 * A value that arrived over a transport still needs runtime validation — this type
 * is a claim about a JSON payload, not a check of it — which is why a producer
 * boundary is expected to narrow an untrusted record into this shape and fail
 * closed rather than default a field.
 */
export interface RelationSemanticsIR { readonly traversal: TraversalIR; readonly selection: SelectionSemanticsIR; readonly loadOrder: LoadOrderIR; readonly cyclePolicy: CyclePolicyIR; readonly conflictSeverity: ConflictSeverityIR }
export type CardinalityIR = "one-to-one" | "one-to-many" | "many-to-one" | "many-to-many";
/**
 * `cardinality` and `directional` are required because the model schema requires
 * them: making them optional would put every consumer back to inventing a default,
 * and a wrong default for `directional` silently turns a one-way relation into a
 * two-way one. `inverse` is optional because a relation need not name one.
 */
export interface RelationDefIR { readonly name: string; readonly version: string; readonly from: TypeRef; readonly to: TypeRef; readonly cardinality: CardinalityIR; readonly directional: boolean; readonly semantics: RelationSemanticsIR; readonly inverse?: string }
export interface FunctionDefIR { readonly name: string; readonly version: string; readonly inputs: Readonly<Record<string, TypeRef>>; readonly output: TypeRef; readonly provider?: string }
export interface ActionDefIR { readonly name: string; readonly version: string; readonly inputs: Readonly<Record<string, TypeRef>>; readonly output: TypeRef; readonly capabilities: readonly string[]; readonly sideEffects: string }
export interface ProjectionDefIR { readonly name: string; readonly version: string; readonly targetTokens: number; readonly rules: readonly Readonly<Record<string, ValueIR>>[] }
export interface RetrievalProfileDefIR { readonly name: string; readonly version: string; readonly projectionRef: string; readonly featureWeights: Readonly<Record<string, number>> }
export interface SchemaIR { readonly protocolVersion: string; readonly model: { readonly name: string; readonly version: string; readonly digest: string }; readonly types: Readonly<Record<string, TypeDefIR>>; readonly relations: Readonly<Record<string, RelationDefIR>>; readonly functions: Readonly<Record<string, FunctionDefIR>>; readonly actions: Readonly<Record<string, ActionDefIR>>; readonly projections: Readonly<Record<string, ProjectionDefIR>>; readonly retrievalProfiles: Readonly<Record<string, RetrievalProfileDefIR>>; readonly policies?: Readonly<Record<string, ValueIR>>; readonly validators?: Readonly<Record<string, ValueIR>> }
export interface ProvenanceIR { readonly source: SourceRefIR; readonly attributes?: Readonly<Record<string, ValueIR>> }
export interface UnitIR { readonly identity: { readonly id: string; readonly version: string; readonly digest: string; readonly corpus: string }; readonly typeRef: TypeRef; readonly implements: readonly TypeRef[]; readonly fields: Readonly<Record<string, TypedValueIR>>; readonly relations: readonly GraphEdgeIR[]; readonly citations: readonly string[]; readonly policyLabels: readonly string[]; readonly lifecycle: "draft" | "active" | "deprecated" | "deleted"; readonly visibility: "private" | "shared" | "public"; readonly provenance: ProvenanceIR; readonly projections: Readonly<Record<string, ValueIR>> }
/** Stable metadata for one rendered projection. `path` is POSIX-relative to a unit directory. */
export interface ProjectionArtifactIR { readonly name: string; readonly path: string; readonly content: string; readonly bytes: number; readonly digest: string; readonly tokens: number; readonly selectors: readonly string[] }
/**
 * The generic compiler output. It intentionally contains no parser AST or
 * domain-specific enum: a corpus finalizer can consume `meta` directly.
 */
export interface CompiledUnitMetaIR {
  readonly id: string;
  readonly kind: string;
  readonly version: string;
  readonly description: string;
  readonly domain: string;
  readonly tags: readonly string[];
  readonly tokens: Readonly<Record<string, number>>;
  readonly projection: Readonly<Record<string, string>>;
  readonly contentDigest: string;
  /** Protocol-level redistribution terms, carried outside domain fields. */
  readonly license?: string;
  /** Stable provenance attributes emitted beside the runtime artifact. */
  readonly provenance?: Readonly<Record<string, ValueIR>>;
}
export interface CompiledUnitIR {
  readonly kind: "compiled-unit";
  readonly unit: UnitIR;
  readonly projections: Readonly<Record<string, ProjectionArtifactIR>>;
  readonly meta: CompiledUnitMetaIR;
}
export interface GraphEdgeIR { readonly id: string; readonly relationRef: string; readonly from: string; readonly to: string; readonly attributes?: Readonly<Record<string, ValueIR>> }
export interface GraphIR { readonly snapshot: SnapshotRef; readonly units: readonly UnitIR[]; readonly edges: readonly GraphEdgeIR[]; readonly diagnostics: readonly DiagnosticIR[]; readonly indexes: Readonly<Record<string, readonly string[]>> }
export interface SelectionCandidateIR { readonly unitId: string; readonly score: number; readonly featureValues: Readonly<Record<string, number>>; readonly reasons: readonly string[] }
export interface RelationExpansionIR { readonly relationRef: string; readonly from: string; readonly discovered: readonly string[]; readonly depth: number }
/**
 * One constraint that a plan is pointing at. `kind` is carried rather than encoded
 * in the `ref` string: a consumer that has to recover the class by parsing a ref
 * prefix breaks the moment a producer changes its ref format, and it cannot
 * distinguish "unknown prefix" from a real class.
 *
 * Only the four blocking classes appear. A soft preference can never make a plan
 * unsatisfiable, so it has no place in a core, and that is expressed here as an
 * absent alternative rather than as a runtime filter.
 */
export type ConstraintKindIR = "hard-requirement" | "hard-prohibition" | "runtime-policy" | "ordering";
export interface ConstraintRefIR { readonly ref: string; readonly kind: ConstraintKindIR }
/**
 * `degraded-to-fit` means the same membership was rendered at a cheaper projection
 * tier; `exceeded-at-cheapest-projection` means even the cheapest tier does not
 * fit, which is the only genuine budget-unsatisfiability.
 */
export type BudgetStateIR = "within-budget" | "degraded-to-fit" | "exceeded-at-cheapest-projection";
/**
 * `state` and `shortfall` are optional because a plan produced by selection alone
 * has not yet been through the layer that decides rendering cost, and claiming
 * `within-budget` on its behalf would be a guess. A plan that has been through
 * that layer must carry both, so an over-budget plan says so after serialisation
 * instead of only in process memory.
 */
export interface BudgetReportIR { readonly maxTokens: number; readonly consumedTokens?: number; readonly state?: BudgetStateIR; readonly shortfall?: number }
export interface SelectionPlanIR { readonly requestId: string; readonly snapshot: SnapshotRef; readonly query: Readonly<Record<string, ValueIR>>; readonly candidates: readonly SelectionCandidateIR[]; readonly selected: readonly SelectionCandidateIR[]; readonly rejections: readonly { readonly candidate: SelectionCandidateIR; readonly reasons: readonly string[] }[]; readonly relationExpansions: readonly RelationExpansionIR[]; readonly conflicts: readonly DiagnosticIR[]; readonly budget: BudgetReportIR; readonly projectionLoads: readonly { readonly projectionRef: string; readonly unitIds: readonly string[] }[]; readonly unsatCore?: readonly ConstraintRefIR[]; readonly rationale?: readonly DiagnosticIR[] }
export type ExecutionPlanNodeIR = { readonly id: string; readonly kind: "Query" | "Materialize" | "InvokeAction" | "InvokeFunction" | "InvokeModel" | "Transform" | "Validate" | "Gate" | "Emit" | "AwaitApproval"; readonly target: string; readonly inputs: Readonly<Record<string, ValueIR>>; readonly dependsOn: readonly string[] };
export interface ExecutionPlanIR { readonly snapshot: SnapshotRef; readonly runId: string; readonly nodes: readonly ExecutionPlanNodeIR[]; readonly edges: readonly { readonly from: string; readonly to: string }[]; readonly capabilities: readonly string[]; readonly approvals: readonly string[]; readonly checkpoints: readonly string[]; readonly budget: { readonly maxTokens?: number; readonly maxDurationMs?: number }; readonly diagnostics?: readonly DiagnosticIR[] }
