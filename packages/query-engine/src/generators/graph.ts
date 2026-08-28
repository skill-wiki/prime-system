/**
 * @module generators/graph
 *
 * Proximity to the request's seeds. Which edges are walkable is decided entirely
 * by `RelationDefinition.semantics.traversal` and `directional`; the generator
 * never mentions a relation name. `one-hop` means the relation can be entered but
 * not chained, `transitive` means it can be chained, `none` means it is not a
 * retrieval path at all — so a model can publish a relation for display without
 * it silently widening every query's recall.
 */

import type { GraphIR, SelectionCandidateIR } from "@skill-wiki/ir";
import { compareStrings, orderedRecord, quantize } from "../deterministic.ts";
import type { CandidateGenerator, GeneratorContext, QueryRequest } from "../types.ts";

export interface GraphGeneratorConfig {
  readonly name: string;
  readonly featureAxis: string;
  /**
   * Hop ceiling for chained (`transitive`) relations. A ceiling exists because a
   * transitive relation over a dense corpus otherwise reaches everything, which
   * is indistinguishable from having no retrieval at all. 8 is a default, not a
   * semantic: models that need more say so here.
   */
  readonly maxDepth?: number;
}

interface Reached {
  readonly depth: number;
  readonly seedId: string;
  readonly relationRef: string;
}

export function createGraphGenerator(config: GraphGeneratorConfig): CandidateGenerator {
  const maxDepth = config.maxDepth ?? 8;

  return {
    name: config.name,
    featureAxes: [config.featureAxis],
    generate(request: QueryRequest, _graph: GraphIR, ctx: GeneratorContext): readonly SelectionCandidateIR[] {
      const seeds = [...new Set(request.seeds ?? [])].sort(compareStrings);
      if (seeds.length === 0) return [];

      const reached = new Map<string, Reached>();
      const queue: { readonly unitId: string; readonly depth: number; readonly seedId: string }[] = [];

      for (const seed of seeds) {
        if (!ctx.unitsById.has(seed)) {
          // Either the seed does not exist or admission removed it. Both are
          // reported the same way on purpose: telling them apart would confirm
          // the existence of a unit the principal may not see.
          ctx.report({
            code: "SEED_NOT_AVAILABLE",
            message: `Seed '${seed}' is not present in the admitted graph`,
            severity: "warning",
            path: ["seeds"],
          });
          continue;
        }
        reached.set(seed, { depth: 0, seedId: seed, relationRef: "" });
        queue.push({ unitId: seed, depth: 0, seedId: seed });
      }

      const missingRelations = new Set<string>();
      while (queue.length > 0) {
        const current = queue.shift()!;
        const walkable = [...(ctx.outgoing.get(current.unitId) ?? []), ...(ctx.incoming.get(current.unitId) ?? [])];
        for (const edge of walkable) {
          const relation = ctx.relations[edge.relationRef];
          if (relation === undefined) {
            if (!missingRelations.has(edge.relationRef)) {
              missingRelations.add(edge.relationRef);
              ctx.report({
                code: "RELATION_NOT_DECLARED",
                message: `Edge references relation '${edge.relationRef}' which the model does not declare`,
                severity: "warning",
              });
            }
            continue;
          }
          const { traversal } = relation.semantics;
          if (traversal === "none") continue;

          const inbound = edge.to === current.unitId;
          // An inbound edge is only a path when the relation is non-directional.
          if (inbound && relation.directional) continue;
          const neighbour = inbound ? edge.from : edge.to;
          if (neighbour === current.unitId) continue;

          const depth = current.depth + 1;
          const previous = reached.get(neighbour);
          if (previous !== undefined && previous.depth <= depth) continue;
          reached.set(neighbour, { depth, seedId: current.seedId, relationRef: edge.relationRef });
          if (traversal === "transitive" && depth < maxDepth) {
            queue.push({ unitId: neighbour, depth, seedId: current.seedId });
          }
        }
      }

      return [...reached.entries()]
        .sort((a, b) => compareStrings(a[0], b[0]))
        .map(([unitId, hit]) => ({
          unitId,
          score: 0,
          featureValues: orderedRecord([[config.featureAxis, quantize(1 / (1 + hit.depth))]]),
          reasons: [
            hit.depth === 0
              ? `${config.name}: request seed`
              : `${config.name}: ${hit.depth} hop(s) from seed '${hit.seedId}' via relation '${hit.relationRef}'`,
          ],
        }));
    },
  };
}
