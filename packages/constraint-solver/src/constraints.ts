/**
 * The four constraint classes of the plan (§9.4) are separate *types*, not one
 * record with a `weight` field. That is the load-bearing part: `weight` exists
 * only on `SoftPreferenceConstraint`, so "a hard constraint outvoted by a large
 * weight" is not merely rejected at runtime — it cannot be written down.
 *
 * Acyclicity is modelled separately from the four membership classes: it is an
 * obligation carried by `loadOrder`/`cyclePolicy` about the *shape* of the
 * selected set, not about whether a single unit belongs to it.
 */
import type { ConflictSeverityIR, CyclePolicyIR, LoadOrderIR, TraversalIR } from "@skill-wiki/ir";

/** Stable, content-derived identifier. Same input graph -> same refs, in the same order. */
export type ConstraintRef = string;

export type SideEffect = "none" | "read" | "write";
export const SIDE_EFFECT_VALUES = ["none", "read", "write"] as const;

/** A unit that must be present once its subject is present. Missing target invalidates the plan. */
export interface HardRequirementConstraint {
  readonly kind: "hard-requirement";
  readonly ref: ConstraintRef;
  readonly relationRef: string;
  readonly edgeId: string;
  readonly subject: string;
  readonly target: string;
  readonly traversal: TraversalIR;
}

/** A pair that must never co-occur. Endpoints are stored sorted, so the pair is direction-free. */
export interface HardProhibitionConstraint {
  readonly kind: "hard-prohibition";
  readonly ref: ConstraintRef;
  readonly relationRef: string;
  readonly edgeId: string;
  readonly left: string;
  readonly right: string;
}

/** Optimised within the budget. The only class that carries a weight. */
export interface SoftPreferenceConstraint {
  readonly kind: "soft-preference";
  readonly ref: ConstraintRef;
  readonly target: string;
  readonly weight: number;
  readonly relationRef?: string;
  readonly edgeId?: string;
  readonly subject?: string;
  readonly depth?: number;
}

/** Decided by principal / capability / side-effect, never by score. */
export interface RuntimePolicyConstraint {
  readonly kind: "runtime-policy";
  readonly ref: ConstraintRef;
  readonly target: string;
  readonly label: string;
  readonly capabilities: readonly string[];
  readonly sideEffect: SideEffect;
}

/** One ordering edge plus the cycle policy of the relation that produced it. */
export interface OrderingObligation {
  readonly kind: "ordering";
  readonly ref: ConstraintRef;
  readonly relationRef: string;
  readonly edgeId: string;
  /** `before` must be loaded before `after`; both are unit ids. */
  readonly before: string;
  readonly after: string;
  readonly cyclePolicy: CyclePolicyIR;
}

/** An `exclude` hit whose severity does not block: recorded, never enforced. */
export interface AdvisoryExclusion {
  readonly kind: "advisory-exclusion";
  readonly ref: ConstraintRef;
  readonly relationRef: string;
  readonly edgeId: string;
  readonly left: string;
  readonly right: string;
  readonly severity: Exclude<ConflictSeverityIR, "error">;
}

export type HardConstraint = HardRequirementConstraint | HardProhibitionConstraint;
export type MembershipConstraint = HardConstraint | SoftPreferenceConstraint | RuntimePolicyConstraint;
export type Constraint = MembershipConstraint | OrderingObligation | AdvisoryExclusion;

/**
 * Compile-time witness of the invariant in §17.3: no hard constraint and no
 * runtime policy has a place to put a weight, so no weight can override them.
 * `WeightBearingKinds` must stay exactly `"soft-preference"`.
 */
export type WeightBearingKinds = Extract<Constraint, { readonly weight: number }>["kind"];

export interface ConstraintSet {
  readonly hardRequirements: readonly HardRequirementConstraint[];
  readonly hardProhibitions: readonly HardProhibitionConstraint[];
  readonly softPreferences: readonly SoftPreferenceConstraint[];
  readonly runtimePolicies: readonly RuntimePolicyConstraint[];
  readonly orderings: readonly OrderingObligation[];
  readonly advisories: readonly AdvisoryExclusion[];
}

const KIND_RANK: Readonly<Record<Constraint["kind"], number>> = { "hard-requirement": 0, "hard-prohibition": 1, "runtime-policy": 2, ordering: 3, "soft-preference": 4, "advisory-exclusion": 5 };

/** Total order used everywhere a constraint list is emitted, so output never depends on Map order. */
export function compareConstraints(left: Constraint, right: Constraint): number {
  const byKind = KIND_RANK[left.kind] - KIND_RANK[right.kind];
  return byKind !== 0 ? byKind : left.ref < right.ref ? -1 : left.ref > right.ref ? 1 : 0;
}

export function orderingDirection(loadOrder: Exclude<LoadOrderIR, "none">, from: string, to: string): { readonly before: string; readonly after: string } {
  // `before` on an edge from A to B states that B is loaded before A: the edge
  // points at the prerequisite, which is why the endpoints swap here.
  return loadOrder === "before" ? { before: to, after: from } : { before: from, after: to };
}

export function sortedPair(a: string, b: string): readonly [string, string] {
  return a <= b ? [a, b] : [b, a];
}
