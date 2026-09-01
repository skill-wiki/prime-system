/**
 * @module expansion
 *
 * Relation-driven selection. Everything here reads `RelationDefinition.semantics`
 * and nothing here knows a relation's name — that separation is the point of the
 * whole exercise, because the moment an engine special-cases one relation name it
 * has adopted a domain.
 *
 * How the two axes combine:
 *
 * - `selection` decides *whether* a neighbour joins the selection:
 *   `expand`/`closure` pull it in, `exclude` marks the pair mutually exclusive,
 *   `informational` does neither.
 * - `traversal` bounds *how far*: `none` blocks the relation entirely (even under
 *   `closure`), `one-hop` allows one level, `transitive` allows chaining.
 *
 * `traversal` therefore wins over `selection`: a relation declared `closure` but
 * `one-hop` expands one level. The alternative — letting `closure` override the
 * declared traversal — would make `traversal: one-hop` unenforceable.
 */

import type { ConflictSeverityIR, DiagnosticIR, RelationExpansionIR } from "@aoe/ir";
import type { RelationDefinition } from "@aoe/model-schema";
import type { Adjacency } from "./adjacency.ts";
import { compareStrings } from "./deterministic.ts";

export interface ExclusionPair {
  readonly relationRef: string;
  readonly a: string;
  readonly b: string;
  readonly severity: ConflictSeverityIR;
}

export interface OrderConstraint {
  /** `earlier` must appear before `later` in the load order. */
  readonly earlier: string;
  readonly later: string;
  readonly relationRef: string;
}

export interface ExpansionResult {
  readonly expansions: readonly RelationExpansionIR[];
  /** Units pulled into the selection that were not already in it. */
  readonly discovered: readonly string[];
  readonly orderConstraints: readonly OrderConstraint[];
  readonly diagnostics: readonly DiagnosticIR[];
}

interface Walk {
  readonly unitId: string;
  readonly depth: number;
  readonly path: readonly string[];
}

/**
 * Expand from `seedIds` (the ranked selection) over one relation at a time, so
 * each `RelationExpansionIR` attributes its discoveries to exactly one relation
 * and one origin — a merged walk would produce unattributable provenance.
 */
export function expandSelection(
  seedIds: readonly string[],
  adjacency: Adjacency,
  relations: Readonly<Record<string, RelationDefinition>>,
  maxDepth: number,
): ExpansionResult {
  const expansions: RelationExpansionIR[] = [];
  const discovered = new Set<string>();
  const orderConstraints: OrderConstraint[] = [];
  const diagnostics: DiagnosticIR[] = [];
  const undeclared = new Set<string>();
  const selected = new Set(seedIds);

  for (const edge of adjacency.edges) {
    if (relations[edge.relationRef] === undefined && !undeclared.has(edge.relationRef)) {
      undeclared.add(edge.relationRef);
      diagnostics.push({
        code: "RELATION_NOT_DECLARED",
        message: `Edge references relation '${edge.relationRef}' which the model does not declare; it is ignored`,
        severity: "warning",
      });
    }
  }

  const relationRefs = Object.keys(relations).sort(compareStrings);
  const origins = [...selected].sort(compareStrings);

  for (const relationRef of relationRefs) {
    const relation = relations[relationRef]!;
    const { traversal, selection, loadOrder, cyclePolicy } = relation.semantics;
    if (traversal === "none") continue;
    // `exclude` is handled by `findExclusions` after every expansion has run, and
    // `informational` neither pulls in nor prohibits — neither needs a walk.
    if (selection === "exclude" || selection === "informational") continue;

    const depthLimit = traversal === "one-hop" ? 1 : maxDepth;

    for (const origin of origins) {
      const found = new Map<string, number>();
      const queue: Walk[] = [{ unitId: origin, depth: 0, path: [origin] }];
      let cycleReported = false;

      while (queue.length > 0) {
        const current = queue.shift()!;
        const edges = [
          ...(adjacency.outgoing.get(current.unitId) ?? []),
          ...(relation.directional ? [] : (adjacency.incoming.get(current.unitId) ?? [])),
        ].filter(edge => edge.relationRef === relationRef);

        for (const edge of edges) {
          const neighbour = edge.to === current.unitId && !relation.directional ? edge.from : edge.to;
          if (neighbour === current.unitId) continue;

          if (current.path.includes(neighbour)) {
            if (cyclePolicy === "reject" && !cycleReported) {
              cycleReported = true;
              diagnostics.push({
                code: "RELATION_CYCLE_REJECTED",
                message: `Relation '${relationRef}' declares cyclePolicy 'reject' but a cycle exists: ${[...current.path, neighbour].join(" -> ")}`,
                severity: "error",
              });
            }
            // `allow` and `collapse` both stop walking here; without that the walk
            // would not terminate. They differ only in whether a cycle is reported.
            continue;
          }

          const depth = current.depth + 1;
          const previous = found.get(neighbour);
          if (previous !== undefined && previous <= depth) continue;
          found.set(neighbour, depth);
          if (depth < depthLimit) queue.push({ unitId: neighbour, depth, path: [...current.path, neighbour] });
        }
      }

      if (found.size === 0) continue;
      const neighbours = [...found.keys()].sort(compareStrings);

      // `expand` adds the immediate level even when the relation is transitive:
      // the depth ceiling of a non-closure relation is one level by definition.
      const admitted = selection === "closure" ? neighbours : neighbours.filter(id => found.get(id) === 1);
      if (admitted.length === 0) continue;

      const maxFoundDepth = admitted.reduce((max, id) => Math.max(max, found.get(id)!), 0);
      expansions.push({ relationRef, from: origin, discovered: admitted, depth: maxFoundDepth });
      for (const id of admitted) if (!selected.has(id)) discovered.add(id);

      if (loadOrder !== "none") {
        for (const id of admitted) {
          // The direction convention now lives on `LoadOrderIR` in `@aoe/ir`
          // (coordinator decision D-7): for an edge `origin -> id`, `before` means
          // the target loads before the origin.
          orderConstraints.push(
            loadOrder === "before"
              ? { earlier: id, later: origin, relationRef }
              : { earlier: origin, later: id, relationRef },
          );
        }
      }
    }
  }

  return {
    expansions: expansions.sort(
      (a, b) => compareStrings(a.relationRef, b.relationRef) || compareStrings(a.from, b.from),
    ),
    discovered: [...discovered].sort(compareStrings),
    orderConstraints,
    diagnostics,
  };
}

/**
 * Mutual exclusion, computed *after* expansion so a unit pulled in by a closure
 * is still subject to a prohibition. Running this inside the expansion walk would
 * make the outcome depend on the alphabetical order of relation names.
 *
 * Only one hop is considered: an exclusion is a statement about a pair, and
 * chaining it would invent a transitive prohibition the model never declared.
 */
export function findExclusions(
  present: readonly string[],
  adjacency: Adjacency,
  relations: Readonly<Record<string, RelationDefinition>>,
): readonly ExclusionPair[] {
  const inSelection = new Set(present);
  const pairs = new Map<string, ExclusionPair>();

  for (const edge of adjacency.edges) {
    const relation = relations[edge.relationRef];
    if (relation === undefined) continue;
    const { selection, traversal, conflictSeverity } = relation.semantics;
    if (selection !== "exclude" || traversal === "none") continue;
    if (!inSelection.has(edge.from) || !inSelection.has(edge.to)) continue;
    const [a, b] = edge.from < edge.to ? [edge.from, edge.to] : [edge.to, edge.from];
    const key = `${edge.relationRef}\u0000${a}\u0000${b}`;
    if (pairs.has(key)) continue;
    pairs.set(key, { relationRef: edge.relationRef, a: a!, b: b!, severity: conflictSeverity });
  }

  return [...pairs.values()].sort(
    (a, b) => compareStrings(a.relationRef, b.relationRef) || compareStrings(a.a, b.a) || compareStrings(a.b, b.b),
  );
}
