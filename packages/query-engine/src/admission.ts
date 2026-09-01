/**
 * @module admission
 *
 * The pre-filter that runs *before* candidate generation. Filtering late is a
 * disclosure bug in its own right: a generator that has seen a unit can leak it
 * through corpus statistics (IDF), through a graph path that only exists because
 * of it, and through a rejection reason. So the generators are handed a graph
 * from which denied units and their edges are already gone.
 */

import type { GraphIR, UnitIR } from "@aoe/ir";
import { describeFacet, matchesFacet } from "./facets.ts";
import { compareStrings, orderedRecord, sortedKeys } from "./deterministic.ts";
import type { FacetSelector, Principal, QueryRequest, UnitLifecycle } from "./types.ts";

export interface AdmissionDenial {
  readonly unitId: string;
  readonly reasons: readonly string[];
}

export interface AdmissionResult {
  /** Graph containing only admitted units, with dangling edges removed. */
  readonly graph: GraphIR;
  /**
   * Units excluded by a *request-side* filter — lifecycle or a required facet.
   * Naming these is safe: the caller asked for the filter and may see the units.
   */
  readonly filtered: readonly AdmissionDenial[];
  /**
   * How many units the principal is not cleared for. A count, never ids: putting
   * an ACL-denied unit id into the plan would hand back exactly the identifiers
   * the filter exists to withhold, and would make early filtering pointless.
   */
  readonly aclDeniedCount: number;
}

function aclReasons(unit: UnitIR, principal: Principal): readonly string[] {
  const reasons: string[] = [];
  if (!principal.allowedVisibility.includes(unit.visibility)) {
    reasons.push(`visibility '${unit.visibility}' not granted to principal '${principal.id}'`);
  }
  const missing = unit.policyLabels.filter(label => !principal.grantedPolicyLabels.includes(label));
  if (missing.length > 0) {
    reasons.push(`missing policy label grant: ${[...missing].sort(compareStrings).join(", ")}`);
  }
  return reasons;
}

function lifecycleReasons(unit: UnitIR, lifecycles: readonly UnitLifecycle[] | undefined): readonly string[] {
  if (lifecycles === undefined || lifecycles.includes(unit.lifecycle)) return [];
  return [`lifecycle '${unit.lifecycle}' not in requested lifecycles [${lifecycles.join(", ")}]`];
}

function requiredFacetReasons(unit: UnitIR, facets: readonly FacetSelector[] | undefined): readonly string[] {
  if (facets === undefined) return [];
  return facets.filter(f => !matchesFacet(unit, f)).map(f => `required facet unsatisfied: ${describeFacet(f)}`);
}

/**
 * Admit units the principal may see, then drop every edge with an inadmissible
 * endpoint so relation expansion cannot walk back into denied territory.
 */
export function admit(graph: GraphIR, request: QueryRequest): AdmissionResult {
  const admitted: UnitIR[] = [];
  const filtered: AdmissionDenial[] = [];
  let aclDeniedCount = 0;

  for (const unit of graph.units) {
    // ACL is checked first and reported least: a unit the principal cannot see
    // must not be described by a rejection reason, however accurate.
    if (aclReasons(unit, request.principal).length > 0) {
      aclDeniedCount += 1;
      continue;
    }
    const reasons = [
      ...lifecycleReasons(unit, request.lifecycles),
      ...requiredFacetReasons(unit, request.requiredFacets),
    ];
    if (reasons.length === 0) admitted.push(unit);
    else filtered.push({ unitId: unit.identity.id, reasons });
  }

  const admittedIds = new Set(admitted.map(unit => unit.identity.id));
  const visible = (edge: { readonly from: string; readonly to: string }): boolean =>
    admittedIds.has(edge.from) && admittedIds.has(edge.to);

  // A unit carries its own edge list as well as the graph-level one. Both have to
  // be scrubbed, otherwise a consumer reading `unit.relations` sees a denied id.
  const units = admitted.map(unit => ({ ...unit, relations: unit.relations.filter(visible) }));
  const indexes = orderedRecord(
    sortedKeys(graph.indexes).map(
      key => [key, graph.indexes[key]!.filter(id => admittedIds.has(id))] as const,
    ),
  );

  return {
    graph: { ...graph, units, edges: graph.edges.filter(visible), indexes },
    filtered: [...filtered].sort((a, b) => compareStrings(a.unitId, b.unitId)),
    aclDeniedCount,
  };
}
