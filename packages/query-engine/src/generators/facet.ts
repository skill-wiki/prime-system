/**
 * @module generators/facet
 *
 * Structural matching against the request's soft facets. The value is the
 * satisfied fraction rather than a boolean so a unit matching two of three
 * facets outranks one matching one, without the engine needing to know which
 * facet matters — that is what the profile weight is for.
 */

import type { GraphIR, SelectionCandidateIR } from "@aoe/ir";
import { compareStrings, orderedRecord, quantize } from "../deterministic.ts";
import { describeFacet, matchedFacets } from "../facets.ts";
import type { CandidateGenerator, GeneratorContext, QueryRequest } from "../types.ts";

export interface FacetGeneratorConfig {
  readonly name: string;
  readonly featureAxis: string;
}

export function createFacetGenerator(config: FacetGeneratorConfig): CandidateGenerator {
  return {
    name: config.name,
    featureAxes: [config.featureAxis],
    generate(request: QueryRequest, graph: GraphIR, _ctx: GeneratorContext): readonly SelectionCandidateIR[] {
      const facets = request.facets ?? [];
      if (facets.length === 0) return [];

      const candidates: SelectionCandidateIR[] = [];
      for (const unit of graph.units) {
        const matched = matchedFacets(unit, facets);
        if (matched.length === 0) continue;
        candidates.push({
          unitId: unit.identity.id,
          score: 0,
          featureValues: orderedRecord([[config.featureAxis, quantize(matched.length / facets.length)]]),
          reasons: matched.map(facet => `${config.name}: ${describeFacet(facet)}`),
        });
      }
      return candidates.sort((a, b) => compareStrings(a.unitId, b.unitId));
    },
  };
}
