/**
 * @module facets
 *
 * Facet evaluation shared by the soft facet generator and the hard pre-filter.
 * Keeping one evaluator means a facet cannot mean one thing when it scores and
 * another when it excludes.
 */

import type { UnitIR } from "@skill-wiki/ir";
import type { FacetSelector } from "./types.ts";
import { resolvePath, typedValueMatches } from "./values.ts";

/** Stable, human-readable rendering used in candidate reasons and rejections. */
export function describeFacet(facet: FacetSelector): string {
  switch (facet.kind) {
    case "typeRef":
      return `typeRef in [${facet.anyOf.join(", ")}]`;
    case "implements":
      return `implements any of [${facet.anyOf.join(", ")}]`;
    case "field":
      return `field ${facet.path.join(".")} in [${facet.anyOf.map(v => JSON.stringify(v)).join(", ")}]`;
  }
}

export function matchesFacet(unit: UnitIR, facet: FacetSelector): boolean {
  switch (facet.kind) {
    case "typeRef":
      return facet.anyOf.includes(unit.typeRef);
    case "implements":
      return unit.implements.some(ref => facet.anyOf.includes(ref));
    case "field": {
      const values = resolvePath(unit.fields, facet.path);
      return values.some(value => facet.anyOf.some(expected => typedValueMatches(value, expected)));
    }
  }
}

/** Which of the given facets the unit satisfies, in input order. */
export function matchedFacets(
  unit: UnitIR,
  facets: readonly FacetSelector[],
): readonly FacetSelector[] {
  return facets.filter(facet => matchesFacet(unit, facet));
}
