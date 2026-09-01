/**
 * @module resources
 *
 * The read-a-single-projection surface, ACL-filtered.
 *
 * Admission is delegated to `query-engine`'s `admit`, not reimplemented. That
 * matters more here than anywhere else on this server: `admit` is the function
 * that decides what a principal may observe, and a resource endpoint with its own
 * copy of that decision is a disclosure bug waiting for the two copies to drift.
 * Reaching it requires synthesising a `QueryRequest`, because admission is
 * request-shaped — `profile` and `maxTokens` are unused by `admit` and are filled
 * with placeholders that could not be mistaken for real values.
 *
 * ## Why these descriptors carry no `aoe://` URI
 *
 * `projection-engine`'s `formatProjectionUri` addresses
 * `…/projections/<profile>/<level>` — a two-level model. `UnitIR.projections` is
 * keyed by a single projection *name* (`ProjectionDefinition` declares `name` and
 * `targetTokens`, and no levels), so there is no honest value for `level` on this
 * surface. Emitting `<ref>/<ref>` would produce a URI that parses and means
 * nothing, which is worse than not emitting one. So a descriptor's identity is the
 * structured `(corpus, release, unitId, projectionRef)` tuple, and `href` is only
 * this server's own path to it — HTTP addressing, which is a transport's business,
 * not a second identity scheme. Closing that gap needs the projection profile/level
 * layer to reach `UnitIR`; see the lane report.
 */

import type { UnitIR, ValueIR } from "@skill-wiki/ir";
import { admit, type Principal, type QueryEngineContext, type QueryRequest } from "@skill-wiki/query-engine";

export interface ResourceDescriptor {
  readonly corpus: string;
  readonly release: string;
  readonly unitId: string;
  readonly projectionRef: string;
  readonly typeRef: string;
  readonly unitDigest: string;
  readonly lifecycle: UnitIR["lifecycle"];
  readonly visibility: UnitIR["visibility"];
  /** Server-relative path that reads this resource on this server. */
  readonly href: string;
}

export interface ResourceContent extends ResourceDescriptor {
  readonly content: ValueIR;
}

export const RESOURCE_PATH_PREFIX = "/v1/resources";

export function resourceHref(unitId: string, projectionRef: string): string {
  return `${RESOURCE_PATH_PREFIX}/${encodeURIComponent(unitId)}/${encodeURIComponent(projectionRef)}`;
}

/**
 * A `QueryRequest` that exists only to reach `admit`.
 *
 * `profile` and `maxTokens` are named `"__admission_only__"` and `1` rather than
 * plausible values so that a future reader who finds one of them in a log knows
 * immediately it did not come from a caller.
 */
function admissionRequest(principal: Principal): QueryRequest {
  return { requestId: "__admission_only__", profile: "__admission_only__", principal, maxTokens: 1 };
}

function describe(unit: UnitIR, projectionRef: string, release: string): ResourceDescriptor {
  return {
    corpus: unit.identity.corpus,
    release,
    unitId: unit.identity.id,
    projectionRef,
    typeRef: unit.typeRef,
    unitDigest: unit.identity.digest,
    lifecycle: unit.lifecycle,
    visibility: unit.visibility,
    href: resourceHref(unit.identity.id, projectionRef),
  };
}

export function listResources(engine: QueryEngineContext, principal: Principal): readonly ResourceDescriptor[] {
  const admitted = admit(engine.graph, admissionRequest(principal)).graph;
  const release = engine.graph.snapshot.corpusRelease;
  return admitted.units
    .flatMap(unit => Object.keys(unit.projections).sort().map(ref => describe(unit, ref, release)))
    .sort((a, b) => (a.href < b.href ? -1 : a.href > b.href ? 1 : 0));
}

export type ResourceLookup =
  | { readonly ok: true; readonly value: ResourceContent }
  | { readonly ok: false; readonly reason: string };

/**
 * Reads one projection.
 *
 * A unit the principal is not cleared for and a unit that does not exist produce
 * the *same* answer, deliberately: a distinguishable "exists but forbidden"
 * response turns this endpoint into an oracle that enumerates ids the ACL exists
 * to hide. `admit` already refuses to name ACL-denied ids for the same reason
 * (`aclDeniedCount` is a count, never a list).
 */
export function readResource(
  engine: QueryEngineContext,
  principal: Principal,
  unitId: string,
  projectionRef: string,
): ResourceLookup {
  const admitted = admit(engine.graph, admissionRequest(principal)).graph;
  const unit = admitted.units.find(candidate => candidate.identity.id === unitId);
  if (unit === undefined) return { ok: false, reason: "no such resource" };
  const content = unit.projections[projectionRef];
  if (content === undefined) return { ok: false, reason: "no such resource" };
  return { ok: true, value: { ...describe(unit, projectionRef, engine.graph.snapshot.corpusRelease), content } };
}
