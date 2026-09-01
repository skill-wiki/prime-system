/**
 * @module adjacency
 *
 * Adjacency built once per plan and shared by the graph generator and relation
 * expansion. Edges are sorted on construction so every traversal that follows
 * visits them in the same order — BFS over a `Map` whose values arrived in
 * corpus order is a plan that changes when a file is renamed.
 */

import type { GraphEdgeIR, GraphIR, UnitIR } from "@aoe/ir";
import { compareStrings } from "./deterministic.ts";

export interface Adjacency {
  readonly unitsById: ReadonlyMap<string, UnitIR>;
  readonly outgoing: ReadonlyMap<string, readonly GraphEdgeIR[]>;
  readonly incoming: ReadonlyMap<string, readonly GraphEdgeIR[]>;
  /** All edges, in canonical order. */
  readonly edges: readonly GraphEdgeIR[];
}

function compareEdges(a: GraphEdgeIR, b: GraphEdgeIR): number {
  return (
    compareStrings(a.relationRef, b.relationRef) ||
    compareStrings(a.from, b.from) ||
    compareStrings(a.to, b.to) ||
    compareStrings(a.id, b.id)
  );
}

export function buildAdjacency(graph: GraphIR): Adjacency {
  const unitsById = new Map<string, UnitIR>();
  for (const unit of graph.units) unitsById.set(unit.identity.id, unit);

  const edges = [...graph.edges].sort(compareEdges);
  const outgoing = new Map<string, GraphEdgeIR[]>();
  const incoming = new Map<string, GraphEdgeIR[]>();
  for (const edge of edges) {
    const from = outgoing.get(edge.from);
    if (from === undefined) outgoing.set(edge.from, [edge]);
    else from.push(edge);
    const to = incoming.get(edge.to);
    if (to === undefined) incoming.set(edge.to, [edge]);
    else to.push(edge);
  }

  return { unitsById, outgoing, incoming, edges };
}
