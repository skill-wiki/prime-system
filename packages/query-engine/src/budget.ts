/**
 * @module budget
 *
 * Turning an ordered selection into a projection plan that fits a token budget.
 *
 * Two properties matter more than optimality. First, every unit that does not make
 * it must carry the arithmetic that excluded it, because "context was truncated"
 * is unactionable while "needed 900 tokens, 320 left" is. Second, the walk is a
 * single greedy pass in load order: a knapsack solver would reorder loads to fit
 * more units, breaking the ordering the model just declared.
 */

import type { ProjectionDefinition } from "@skill-wiki/model-schema";
import { compareStrings } from "./deterministic.ts";
import { fail, type TokenCostModel } from "./types.ts";

export interface ProjectionAssignment {
  readonly unitId: string;
  readonly projectionRef: string;
  readonly tokens: number;
}

export interface BudgetRejection {
  readonly unitId: string;
  readonly reasons: readonly string[];
}

export interface BudgetResult {
  readonly assignments: readonly ProjectionAssignment[];
  readonly rejections: readonly BudgetRejection[];
  readonly consumedTokens: number;
}

/**
 * Resolve the projection preference list: the profile's projection first, then the
 * request's fallbacks. Unknown refs throw rather than being skipped — a silently
 * ignored projection ref would show up as unexplained recall loss.
 */
export function resolveProjectionChain(
  primary: string,
  fallbacks: readonly string[] | undefined,
  projections: Readonly<Record<string, ProjectionDefinition>>,
): readonly string[] {
  const chain = [primary, ...(fallbacks ?? [])].filter((ref, index, all) => all.indexOf(ref) === index);
  const unknown = chain.filter(ref => projections[ref] === undefined);
  if (unknown.length > 0) {
    fail(
      "PROJECTION_NOT_DECLARED",
      `Unknown projection reference(s): ${unknown.join(", ")}; declared: [${Object.keys(projections).sort(compareStrings).join(", ")}]`,
    );
  }
  return chain;
}

function costOf(
  unitId: string,
  projectionRef: string,
  projections: Readonly<Record<string, ProjectionDefinition>>,
  tokenCost: TokenCostModel | undefined,
): number {
  const measured = tokenCost?.(unitId, projectionRef);
  // A projection's `targetTokens` is a declared budget, not a measurement; it is
  // the honest fallback when the host has no rendered artifact to measure.
  return measured ?? projections[projectionRef]!.targetTokens;
}

export function planBudget(
  ordered: readonly string[],
  chain: readonly string[],
  maxTokens: number,
  projections: Readonly<Record<string, ProjectionDefinition>>,
  tokenCost: TokenCostModel | undefined,
): BudgetResult {
  if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
    fail("BUDGET_INVALID", `maxTokens must be a positive integer, received ${maxTokens}`, ["maxTokens"]);
  }

  const assignments: ProjectionAssignment[] = [];
  const rejections: BudgetRejection[] = [];
  let consumed = 0;

  for (const unitId of ordered) {
    const costs = chain.map(ref => ({ ref, tokens: costOf(unitId, ref, projections, tokenCost) }));
    const remaining = maxTokens - consumed;
    const fitting = costs.find(entry => entry.tokens <= remaining);
    if (fitting === undefined) {
      const cheapest = costs.reduce((min, entry) => (entry.tokens < min.tokens ? entry : min), costs[0]!);
      rejections.push({
        unitId,
        reasons: [
          `token budget exhausted: cheapest projection '${cheapest.ref}' needs ${cheapest.tokens} tokens, ${remaining} of ${maxTokens} remain`,
          `projection costs considered: ${costs.map(entry => `${entry.ref}=${entry.tokens}`).join(", ")}`,
        ],
      });
      continue;
    }
    assignments.push({ unitId, projectionRef: fitting.ref, tokens: fitting.tokens });
    consumed += fitting.tokens;
  }

  return { assignments, rejections, consumedTokens: consumed };
}
