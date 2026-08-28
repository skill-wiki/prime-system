/**
 * @module degrade
 *
 * The projection-layer half of coordinator decision D-2.
 *
 * `planBudget` (src/budget.ts) is the *retrieval* budget policy: candidates are
 * ranked, and one that does not fit is dropped. That is correct when membership is
 * a relevance judgement. It is wrong once a constraint solver has declared a unit
 * hard-required, because dropping such a unit produces a context that looks
 * complete and is not — worse than failing.
 *
 * So this module never drops a unit. It changes how *cheaply* the same membership
 * is rendered: pick the richest projection tier whose whole-set cost fits, then
 * spend whatever is left upgrading individual units back up the chain in load
 * order. If even the cheapest tier does not fit, every unit is still assigned that
 * tier and the result carries `exceeded-at-cheapest-projection` — an explicit
 * state with an `error` diagnostic, not a warning a caller can skip. Per D-2 that
 * case is the only genuine budget-unsatisfiability, and reporting it is this
 * layer's job, not the solver's.
 */

import type { BudgetStateIR, DiagnosticIR } from "@skill-wiki/ir";
import type { ProjectionDefinition } from "@skill-wiki/model-schema";
import type { ProjectionAssignment } from "./budget.ts";
import { compareStrings } from "./deterministic.ts";
import { fail, type TokenCostModel } from "./types.ts";

export interface BudgetHandoff {
  readonly state: BudgetStateIR;
  readonly maxTokens: number;
  readonly consumedTokens: number;
  /** Tokens over budget. Non-zero only in `exceeded-at-cheapest-projection`. */
  readonly shortfall: number;
  /** The uniform tier the set was first placed on, before per-unit upgrades. */
  readonly baseProjectionRef: string;
  /** Tier the set would have used had the budget allowed, when it differs. */
  readonly preferredProjectionRef: string;
}

export interface DegradationResult {
  readonly assignments: readonly ProjectionAssignment[];
  readonly projectionLoads: readonly { readonly projectionRef: string; readonly unitIds: readonly string[] }[];
  readonly handoff: BudgetHandoff;
  readonly diagnostics: readonly DiagnosticIR[];
}

function cost(
  unitId: string,
  projectionRef: string,
  projections: Readonly<Record<string, ProjectionDefinition>>,
  tokenCost: TokenCostModel | undefined,
): number {
  const measured = tokenCost?.(unitId, projectionRef);
  return measured ?? projections[projectionRef]!.targetTokens;
}

function totalAt(
  unitIds: readonly string[],
  projectionRef: string,
  projections: Readonly<Record<string, ProjectionDefinition>>,
  tokenCost: TokenCostModel | undefined,
): number {
  return unitIds.reduce((sum, unitId) => sum + cost(unitId, projectionRef, projections, tokenCost), 0);
}

/**
 * @param ordered unit ids in load order — membership is fixed and is never edited here
 * @param chain projection refs from richest to cheapest, as the profile and request declare them
 */
export function degradeToFit(
  ordered: readonly string[],
  chain: readonly string[],
  maxTokens: number,
  projections: Readonly<Record<string, ProjectionDefinition>>,
  tokenCost: TokenCostModel | undefined,
): DegradationResult {
  if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
    fail("BUDGET_INVALID", `maxTokens must be a positive integer, received ${maxTokens}`, ["maxTokens"]);
  }
  if (chain.length === 0) fail("PROJECTION_CHAIN_EMPTY", "A projection chain must name at least one projection");
  const unknown = chain.filter(ref => projections[ref] === undefined);
  if (unknown.length > 0) {
    fail(
      "PROJECTION_NOT_DECLARED",
      `Unknown projection reference(s): ${unknown.join(", ")}; declared: [${Object.keys(projections).sort(compareStrings).join(", ")}]`,
    );
  }

  const preferred = chain[0]!;
  const cheapest = chain[chain.length - 1]!;
  const diagnostics: DiagnosticIR[] = [];

  if (ordered.length === 0) {
    return {
      assignments: [],
      projectionLoads: [],
      handoff: {
        state: "within-budget",
        maxTokens,
        consumedTokens: 0,
        shortfall: 0,
        baseProjectionRef: preferred,
        preferredProjectionRef: preferred,
      },
      diagnostics,
    };
  }

  const fitting = chain.find(ref => totalAt(ordered, ref, projections, tokenCost) <= maxTokens);
  const base = fitting ?? cheapest;
  const assigned = new Map<string, string>(ordered.map(unitId => [unitId, base]));
  let consumed = totalAt(ordered, base, projections, tokenCost);

  if (fitting === undefined) {
    const shortfall = consumed - maxTokens;
    diagnostics.push({
      code: "BUDGET_EXCEEDED_AT_CHEAPEST_PROJECTION",
      message: `Selection of ${ordered.length} unit(s) costs ${consumed} at the cheapest projection '${cheapest}' against a budget of ${maxTokens}; short by ${shortfall}. No unit was dropped: membership is a constraint decision, not a budget decision.`,
      path: ["budget"],
      severity: "error",
    });
    return {
      assignments: ordered.map(unitId => ({
        unitId,
        projectionRef: base,
        tokens: cost(unitId, base, projections, tokenCost),
      })),
      projectionLoads: groupLoads(ordered, assigned),
      handoff: {
        state: "exceeded-at-cheapest-projection",
        maxTokens,
        consumedTokens: consumed,
        shortfall,
        baseProjectionRef: base,
        preferredProjectionRef: preferred,
      },
      diagnostics,
    };
  }

  // Upgrade pass. Load order is the priority: a unit that must be read first is the
  // one whose detail is most likely to matter, and using it keeps the result a
  // function of the declared order rather than of a second, invented ranking.
  const richerThanBase = chain.slice(0, chain.indexOf(base));
  if (richerThanBase.length > 0) {
    for (const unitId of ordered) {
      for (const candidateRef of richerThanBase) {
        const delta =
          cost(unitId, candidateRef, projections, tokenCost) -
          cost(unitId, assigned.get(unitId)!, projections, tokenCost);
        if (delta <= 0 || consumed + delta <= maxTokens) {
          consumed += delta;
          assigned.set(unitId, candidateRef);
          break;
        }
      }
    }
  }

  const degraded = ordered.some(unitId => assigned.get(unitId) !== preferred);
  if (degraded) {
    diagnostics.push({
      code: "BUDGET_PROJECTION_DEGRADED",
      message: `Budget of ${maxTokens} did not fit ${ordered.length} unit(s) at projection '${preferred}'; the selection is rendered at cheaper tiers instead of losing units. Consumed ${consumed}.`,
      path: ["budget"],
      severity: "info",
    });
  }

  return {
    assignments: ordered.map(unitId => ({
      unitId,
      projectionRef: assigned.get(unitId)!,
      tokens: cost(unitId, assigned.get(unitId)!, projections, tokenCost),
    })),
    projectionLoads: groupLoads(ordered, assigned),
    handoff: {
      state: degraded ? "degraded-to-fit" : "within-budget",
      maxTokens,
      consumedTokens: consumed,
      shortfall: 0,
      baseProjectionRef: base,
      preferredProjectionRef: preferred,
    },
    diagnostics,
  };
}

/** Contiguous runs in load order, so the caller can load a tier at a time. */
function groupLoads(
  ordered: readonly string[],
  assigned: ReadonlyMap<string, string>,
): readonly { readonly projectionRef: string; readonly unitIds: readonly string[] }[] {
  const loads: { readonly projectionRef: string; readonly unitIds: readonly string[] }[] = [];
  for (const unitId of ordered) {
    const ref = assigned.get(unitId)!;
    const last = loads[loads.length - 1];
    if (last !== undefined && last.projectionRef === ref) {
      loads[loads.length - 1] = { projectionRef: ref, unitIds: [...last.unitIds, unitId] };
    } else {
      loads.push({ projectionRef: ref, unitIds: [unitId] });
    }
  }
  return loads;
}
