/**
 * @module solver-bridge
 *
 * Wiring between this package and `@skill-wiki/constraint-solver`. The division of
 * labour is deliberate and matches coordinator decision D-2:
 *
 *   query-engine   which units are *plausible*, and why (features, reasons)
 *   solver         which units must be *present*, and in what order
 *   this module     how cheaply that presence is rendered (projection tiers)
 *
 * Two consequences worth stating because they are easy to get wrong.
 *
 * First, ACL runs once, in `runRetrieval`, and the solver only ever sees the
 * admitted graph. Handing it the full graph and filtering afterwards would let a
 * hard requirement point at a unit the principal may not see, and the solver would
 * correctly call that unsatisfiable — leaking the unit's existence through a
 * failure mode.
 *
 * Second, the solver is given unit costs at the *cheapest* projection in the
 * chain, not the preferred one. A soft preference that cannot fit even at the
 * cheapest tier genuinely cannot be admitted, so that is a membership decision the
 * solver should make. Everything above the cheapest tier is a rendering decision,
 * and per D-2 it is resolved here by degrading tiers rather than by dropping units.
 */

import type {
  ConstraintRefIR,
  DiagnosticIR,
  RelationDefIR,
  RelationSemanticsIR,
  SelectionCandidateIR,
  SelectionPlanIR,
} from "@skill-wiki/ir";
import {
  solve,
  type BlockerKind,
  type PolicyRequirement,
  type PrincipalView,
  type SolveResult,
} from "@skill-wiki/constraint-solver";
import type { RelationDefinition } from "@skill-wiki/model-schema";
import { degradeToFit, type BudgetHandoff } from "./degrade.ts";
import { canonicalStrings, compareStrings, orderedRecord, sortedKeys } from "./deterministic.ts";
import { runRetrieval, type PlanSelectionOptions, type RetrievalResult } from "./engine.ts";
import type { QueryEngineContext, QueryRequest, TokenCostModel } from "./types.ts";

export interface ConstrainedPlanOptions extends PlanSelectionOptions {
  /**
   * Units the caller demands regardless of score. Defaults to `request.seeds`,
   * because a seed is already the caller naming a unit it wants present.
   */
  readonly mandatory?: readonly string[];
  readonly principal?: PrincipalView;
  readonly policyRequirements?: Readonly<Record<string, PolicyRequirement>>;
  readonly undeclaredPolicyLabels?: "deny" | "ignore";
  readonly defaultExpansionWeight?: number;
}

export type ConstrainedPlan =
  | {
      readonly ok: true;
      readonly plan: SelectionPlanIR;
      readonly handoff: BudgetHandoff;
      readonly order: readonly string[];
      readonly retrieval: RetrievalResult;
      readonly diagnostics: readonly DiagnosticIR[];
    }
  | {
      readonly ok: false;
      readonly reason: "unsat";
      readonly blocker: BlockerKind;
      readonly plan: SelectionPlanIR;
      readonly unsatCore: readonly ConstraintRefIR[];
      readonly retrieval: RetrievalResult;
      readonly diagnostics: readonly DiagnosticIR[];
    }
  | {
      readonly ok: false;
      readonly reason: "invalid-input";
      readonly retrieval: RetrievalResult;
      readonly diagnostics: readonly DiagnosticIR[];
    };

/**
 * Compile-time proof that a `LoadedModel` relation's semantics and
 * `RelationSemanticsIR` accept exactly the same values, in both directions. They
 * are not the *identical* type — zod infers mutable properties while the IR
 * contract is `readonly` — but that difference is one-way assignable in the
 * direction every consumer needs.
 *
 * This matters beyond this module. A consumer that only ever holds a zod-validated
 * `RelationDefinition` — the compiler's resolver is one — needs no third copy of the
 * narrowing logic: `relation.semantics` already satisfies the IR type, because zod
 * rejected anything else at load time. Runtime narrowing is required at exactly one
 * kind of boundary, where an IR value arrives from a transport and its type is an
 * assertion rather than a check.
 *
 * If the model schema's enums ever drift from the IR unions, this stops compiling
 * here instead of silently splitting the vocabulary in two.
 */
type Assignable<A, B> = A extends B ? true : false;
const _modelSatisfiesIR: Assignable<RelationDefinition["semantics"], RelationSemanticsIR> = true;
const _irSatisfiesModel: Assignable<RelationSemanticsIR, RelationDefinition["semantics"]> = true;
void _modelSatisfiesIR;
void _irSatisfiesModel;

/**
 * Project the zod-narrowed model-schema relation onto the IR shape the solver
 * consumes. `cardinality`, `directional` and `inverse` now exist on `RelationDefIR`
 * (D-3), so this conversion is no longer lossy for anything the solver reasons
 * about — the compiler enforces the first two, because they are required fields.
 *
 * `aliases` is still dropped, and deliberately: an alias is how a corpus spells a
 * relation, which the loader has already resolved by the time an edge exists. It is
 * not part of the selection semantics, so giving it a home in the IR would invite
 * a consumer to re-resolve names the model already resolved.
 */
export function toRelationDefIR(
  relations: Readonly<Record<string, RelationDefinition>>,
): Readonly<Record<string, RelationDefIR>> {
  return orderedRecord(
    sortedKeys(relations).map(name => {
      const relation = relations[name]!;
      return [
        name,
        {
          name: relation.name,
          version: relation.version,
          from: relation.from,
          to: relation.to,
          cardinality: relation.cardinality,
          directional: relation.directional,
          semantics: {
            traversal: relation.semantics.traversal,
            selection: relation.semantics.selection,
            loadOrder: relation.semantics.loadOrder,
            cyclePolicy: relation.semantics.cyclePolicy,
            conflictSeverity: relation.semantics.conflictSeverity,
          },
          ...(relation.inverse === undefined ? {} : { inverse: relation.inverse }),
        } satisfies RelationDefIR,
      ] as const;
    }),
  );
}

function costAt(
  unitId: string,
  projectionRef: string,
  targetTokens: number,
  tokenCost: TokenCostModel | undefined,
): number {
  return tokenCost?.(unitId, projectionRef) ?? targetTokens;
}

/**
 * Keep the retrieval explanation on a candidate the solver rewrote. The solver
 * reports membership grounds (`seed`, `hard-requirement`, `soft-preference`) and
 * this package reports relevance grounds (per-axis feature values); a plan needs
 * both, so they are merged rather than one replacing the other.
 */
function merge(
  solverCandidate: SelectionCandidateIR,
  scored: ReadonlyMap<string, SelectionCandidateIR>,
): SelectionCandidateIR {
  const mine = scored.get(solverCandidate.unitId);
  if (mine === undefined) return solverCandidate;
  const axes = new Map<string, number>();
  for (const axis of sortedKeys(mine.featureValues)) axes.set(axis, mine.featureValues[axis]!);
  for (const axis of sortedKeys(solverCandidate.featureValues)) {
    if (!axes.has(axis)) axes.set(axis, solverCandidate.featureValues[axis]!);
  }
  return {
    unitId: solverCandidate.unitId,
    score: mine.score,
    featureValues: orderedRecord([...axes.entries()]),
    reasons: canonicalStrings([...mine.reasons, ...solverCandidate.reasons]),
  };
}

export function planWithConstraints(
  request: QueryRequest,
  ctx: QueryEngineContext,
  options: ConstrainedPlanOptions,
): ConstrainedPlan {
  const retrieval = runRetrieval(request, ctx, options);
  const units = retrieval.admission.graph.units;
  const cheapest = retrieval.chain[retrieval.chain.length - 1]!;
  const cheapestTargetTokens = ctx.projections[cheapest]!.targetTokens;

  const unitCost = orderedRecord(
    units.map(
      unit =>
        [unit.identity.id, costAt(unit.identity.id, cheapest, cheapestTargetTokens, ctx.tokenCost)] as const,
    ),
  );

  const mandatory = [...new Set(options.mandatory ?? request.seeds ?? [])]
    .filter(unitId => retrieval.adjacency.unitsById.has(unitId))
    .sort(compareStrings);

  const solved: SolveResult = solve({
    requestId: request.requestId,
    snapshot: ctx.graph.snapshot,
    relations: toRelationDefIR(ctx.relations),
    units,
    edges: retrieval.admission.graph.edges,
    mandatory,
    preferences: retrieval.candidates.map(candidate => ({
      unitId: candidate.unitId,
      weight: candidate.score,
    })),
    ...(options.principal === undefined ? {} : { principal: options.principal }),
    ...(options.policyRequirements === undefined ? {} : { policyRequirements: options.policyRequirements }),
    ...(options.undeclaredPolicyLabels === undefined
      ? {}
      : { undeclaredPolicyLabels: options.undeclaredPolicyLabels }),
    ...(options.defaultExpansionWeight === undefined
      ? {}
      : { defaultExpansionWeight: options.defaultExpansionWeight }),
    budget: { maxTokens: request.maxTokens },
    unitCost,
    query: {},
  });

  if (!solved.ok && solved.reason === "invalid-input") {
    return { ok: false, reason: "invalid-input", retrieval, diagnostics: solved.diagnostics };
  }

  const scored = new Map(retrieval.candidates.map(candidate => [candidate.unitId, candidate]));

  if (!solved.ok) {
    // A genuine unsat: a prohibition, a policy denial, a missing hard target or a
    // rejected cycle. Budget never lands here — see D-2 and `degradeToFit`.
    return {
      ok: false,
      reason: "unsat",
      blocker: solved.blocker,
      plan: {
        ...solved.plan,
        query: retrieval.candidates.length === 0 ? solved.plan.query : solved.plan.query,
        candidates: solved.plan.candidates.map(candidate => merge(candidate, scored)),
        rationale: [...(solved.plan.rationale ?? []), ...retrieval.rationale],
      },
      unsatCore: solved.unsatCore,
      retrieval,
      diagnostics: [...solved.diagnostics, ...retrieval.rationale],
    };
  }

  const degradation = degradeToFit(
    solved.order,
    retrieval.chain,
    request.maxTokens,
    ctx.projections,
    ctx.tokenCost,
  );
  const blocking = degradation.diagnostics.filter(d => d.severity === "error");
  const informational = degradation.diagnostics.filter(d => d.severity !== "error");

  const plan: SelectionPlanIR = {
    ...solved.plan,
    candidates: solved.plan.candidates.map(candidate => merge(candidate, scored)),
    selected: solved.plan.selected.map(candidate => merge(candidate, scored)),
    rejections: solved.plan.rejections.map(rejection => ({
      candidate: merge(rejection.candidate, scored),
      reasons: rejection.reasons,
    })),
    // Over-budget is surfaced in `conflicts`, not only in `rationale`: D-2 requires
    // an explicit state a caller cannot skim past, and `conflicts` is where a plan
    // consumer already looks for something that blocks.
    conflicts: [...solved.plan.conflicts, ...blocking],
    // D-8: the plan carries the budget verdict itself, so an over-budget plan still
    // says so after serialisation instead of only inside the in-process handoff.
    budget: {
      maxTokens: request.maxTokens,
      consumedTokens: degradation.handoff.consumedTokens,
      state: degradation.handoff.state,
      shortfall: degradation.handoff.shortfall,
    },
    projectionLoads: degradation.projectionLoads,
    rationale: [...(solved.plan.rationale ?? []), ...retrieval.rationale, ...informational],
  };

  return {
    ok: true,
    plan,
    handoff: degradation.handoff,
    order: solved.order,
    retrieval,
    diagnostics: [...solved.diagnostics, ...retrieval.rationale, ...degradation.diagnostics],
  };
}
