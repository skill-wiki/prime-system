/**
 * Budget solving (work order item 4).
 *
 * Given a token budget and a set of units, choose one level per unit. The hard
 * rule is that nothing is ever silently truncated: every unit ends up in exactly
 * one of `assignments` / `degraded` / `dropped`, and the degraded and dropped
 * entries carry the reason and the level they lost.
 *
 * Strategy: start every unit at its richest affordable level, then repeatedly
 * downgrade the single unit whose downgrade releases the most tokens, until the
 * plan fits. That is a greedy solver, not an optimum — the tradeoff is that it is
 * deterministic and explainable, which the contract requires and optimality does
 * not. Units that cannot fit even at their cheapest level are dropped in
 * ascending priority order, so a caller's ranking survives budget pressure.
 */

import type { ProjectionLevel } from "./profile.ts";

export interface BudgetUnitInput {
  readonly unitId: string;
  /** Applicable levels, cheapest first (as produced by `candidateLevels`). */
  readonly levels: readonly ProjectionLevel[];
  /** Higher wins under pressure. Callers pass a selection score here. */
  readonly priority: number;
}

export interface BudgetAssignment {
  readonly unitId: string;
  readonly level: ProjectionLevel;
  readonly tokens: number;
}

export interface BudgetDegradation {
  readonly unitId: string;
  readonly from: ProjectionLevel;
  readonly to: ProjectionLevel;
  readonly reason: string;
}

export interface BudgetDrop {
  readonly unitId: string;
  /** The cheapest level that still did not fit; absent when none applied. */
  readonly cheapest?: ProjectionLevel;
  readonly reason: string;
}

export interface BudgetPlan {
  readonly maxTokens: number;
  readonly consumedTokens: number;
  readonly assignments: readonly BudgetAssignment[];
  readonly degraded: readonly BudgetDegradation[];
  readonly dropped: readonly BudgetDrop[];
}

interface WorkingRow {
  readonly unitId: string;
  readonly levels: readonly ProjectionLevel[];
  readonly priority: number;
  /** Index into `levels`; higher is richer. */
  index: number;
  readonly initialIndex: number;
}

export function solveBudget(
  units: readonly BudgetUnitInput[],
  maxTokens: number,
): BudgetPlan {
  if (!Number.isFinite(maxTokens) || maxTokens < 0) {
    throw new Error("Budget maxTokens must be a finite non-negative number");
  }
  const rows: WorkingRow[] = [];
  const dropped: BudgetDrop[] = [];

  for (const unit of units) {
    if (unit.levels.length === 0) {
      dropped.push({ unitId: unit.unitId, reason: "No applicable projection level for this unit" });
      continue;
    }
    const top = unit.levels.length - 1;
    rows.push({
      unitId: unit.unitId,
      levels: unit.levels,
      priority: unit.priority,
      index: top,
      initialIndex: top,
    });
  }

  const cost = (row: WorkingRow): number => row.levels[row.index]!.targetTokens;
  const total = (): number => rows.reduce((sum, row) => sum + cost(row), 0);

  const degraded: BudgetDegradation[] = [];

  // Phase 1 — downgrade greedily by largest token release.
  while (total() > maxTokens) {
    let best: WorkingRow | undefined;
    let bestSaving = 0;
    for (const row of rows) {
      if (row.index === 0) continue;
      const saving = row.levels[row.index]!.targetTokens - row.levels[row.index - 1]!.targetTokens;
      // Ties break on lower priority, then unit id, so the plan is reproducible.
      if (
        saving > bestSaving ||
        (saving === bestSaving &&
          best !== undefined &&
          (row.priority < best.priority ||
            (row.priority === best.priority && row.unitId < best.unitId)))
      ) {
        best = row;
        bestSaving = saving;
      }
    }
    if (best === undefined) break; // Everything is already at its cheapest level.
    best.index -= 1;
  }

  // Phase 2 — still over budget: drop lowest-priority units, cheapest-first
  // ordering broken by unit id so the outcome does not depend on input order.
  if (total() > maxTokens) {
    const order = [...rows].sort(
      (a, b) => a.priority - b.priority || a.unitId.localeCompare(b.unitId),
    );
    for (const victim of order) {
      if (total() <= maxTokens) break;
      const at = rows.indexOf(victim);
      rows.splice(at, 1);
      dropped.push({
        unitId: victim.unitId,
        cheapest: victim.levels[0]!,
        reason: `Token budget ${maxTokens} exhausted; cheapest level needs ${victim.levels[0]!.targetTokens}`,
      });
    }
  }

  for (const row of rows) {
    if (row.index === row.initialIndex) continue;
    degraded.push({
      unitId: row.unitId,
      from: row.levels[row.initialIndex]!,
      to: row.levels[row.index]!,
      reason: `Downgraded to fit the ${maxTokens} token budget`,
    });
  }

  const assignments = rows.map<BudgetAssignment>((row) => ({
    unitId: row.unitId,
    level: row.levels[row.index]!,
    tokens: row.levels[row.index]!.targetTokens,
  }));

  return {
    maxTokens,
    consumedTokens: assignments.reduce((sum, a) => sum + a.tokens, 0),
    assignments,
    degraded,
    dropped,
  };
}
