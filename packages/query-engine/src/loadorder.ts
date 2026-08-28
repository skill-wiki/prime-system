/**
 * @module loadorder
 *
 * Ordering the selection under `RelationDefinition.semantics.loadOrder`.
 *
 * Rank order alone is wrong for loading: a unit another unit must be read after
 * has to come first regardless of score. Kahn's algorithm with a score-ordered
 * ready set gives both — constraints are respected, and among units that are
 * equally free to load, the better-scoring one goes first. Ties inside the ready
 * set fall back to unit id, so the order never depends on `Map` iteration.
 */

import type { DiagnosticIR } from "@skill-wiki/ir";
import { compareStrings } from "./deterministic.ts";
import type { OrderConstraint } from "./expansion.ts";

export interface LoadOrderResult {
  readonly ordered: readonly string[];
  readonly diagnostics: readonly DiagnosticIR[];
}

/**
 * @param ranked unit ids already in descending score order
 * @param constraints `earlier` must precede `later`
 */
export function orderByLoadOrder(
  ranked: readonly string[],
  constraints: readonly OrderConstraint[],
): LoadOrderResult {
  const present = new Set(ranked);
  const rank = new Map(ranked.map((id, index) => [id, index]));
  const diagnostics: DiagnosticIR[] = [];

  const successors = new Map<string, Set<string>>();
  const indegree = new Map<string, number>(ranked.map(id => [id, 0]));
  for (const constraint of constraints) {
    if (!present.has(constraint.earlier) || !present.has(constraint.later)) continue;
    if (constraint.earlier === constraint.later) continue;
    const set = successors.get(constraint.earlier) ?? new Set<string>();
    if (set.has(constraint.later)) continue;
    set.add(constraint.later);
    successors.set(constraint.earlier, set);
    indegree.set(constraint.later, (indegree.get(constraint.later) ?? 0) + 1);
  }

  const compare = (a: string, b: string): number =>
    (rank.get(a) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b) ?? Number.MAX_SAFE_INTEGER) || compareStrings(a, b);

  const ready = ranked.filter(id => indegree.get(id) === 0).sort(compare);
  const ordered: string[] = [];
  while (ready.length > 0) {
    const next = ready.shift()!;
    ordered.push(next);
    for (const successor of [...(successors.get(next) ?? [])].sort(compare)) {
      const remaining = (indegree.get(successor) ?? 0) - 1;
      indegree.set(successor, remaining);
      if (remaining === 0) {
        ready.push(successor);
        ready.sort(compare);
      }
    }
  }

  if (ordered.length !== ranked.length) {
    const stuck = ranked.filter(id => !ordered.includes(id)).sort(compareStrings);
    diagnostics.push({
      code: "LOAD_ORDER_CYCLE",
      message: `Load-order constraints are cyclic across [${stuck.join(", ")}]; the affected units keep rank order`,
      severity: "warning",
    });
    // Degrade to rank order for the cyclic remainder rather than dropping units:
    // an unorderable cycle is a model defect, not a reason to lose context.
    ordered.push(...stuck);
  }

  return { ordered, diagnostics };
}
