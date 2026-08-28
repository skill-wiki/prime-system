/**
 * Semantics-driven constraint solver.
 *
 * Everything this package does is decided by the five `RelationSemantics` fields
 * (`traversal`, `selection`, `loadOrder`, `cyclePolicy`, `conflictSeverity`). No
 * relation name and no type name appears anywhere in `src/`.
 */
export {
  CONFLICT_SEVERITY_VALUES,
  CYCLE_POLICY_VALUES,
  LOAD_ORDER_VALUES,
  SELECTION_VALUES,
  TRAVERSAL_VALUES,
  maxHops,
  readRelationSemantics,
  severityOf,
  type SemanticsReadResult,
} from "./semantics.ts";
export {
  SIDE_EFFECT_VALUES,
  compareConstraints,
  orderingDirection,
  sortedPair,
  type AdvisoryExclusion,
  type Constraint,
  type ConstraintRef,
  type ConstraintSet,
  type HardConstraint,
  type HardProhibitionConstraint,
  type HardRequirementConstraint,
  type MembershipConstraint,
  type OrderingObligation,
  type RuntimePolicyConstraint,
  type SideEffect,
  type SoftPreferenceConstraint,
  type WeightBearingKinds,
} from "./constraints.ts";
export { UNDECLARED_LABEL_CAPABILITY, deriveConstraints, type DeriveInput, type DeriveResult, type PolicyRequirement } from "./derive.ts";
export { planLoadOrder, type OrderResult, type RejectedCycle, type UnitComponent } from "./order.ts";
export { solve, type BlockerKind, type PrincipalView, type SolveRequest, type SolveResult } from "./solve.ts";
