/**
 * @module test/support/harness
 *
 * Registry and context wiring per domain fixture. The generators are registered
 * under the *fixture's* names and axes, which is the point: nothing about the
 * wiring is known to the engine.
 */

import type { GraphIR } from "@skill-wiki/ir";
import type { ProjectionDefinition, RelationDefinition, RetrievalProfile } from "@skill-wiki/model-schema";
import {
  CandidateGeneratorRegistry,
  createFacetGenerator,
  createGraphGenerator,
  createLexicalGenerator,
  type QueryEngineContext,
  type TokenCostModel,
} from "../../src/index.ts";
import { edge, graph, list, num, obj, str, unit } from "./model.ts";

export interface DomainFixture {
  readonly generatorNames: { readonly lexical: string; readonly facet: string; readonly graph: string };
  readonly axes: { readonly text: string; readonly facet: string; readonly proximity: string };
  readonly relations: Readonly<Record<string, RelationDefinition>>;
  readonly projections: Readonly<Record<string, ProjectionDefinition>>;
  readonly profile: RetrievalProfile;
}

export function registryFor(domain: DomainFixture): CandidateGeneratorRegistry {
  return new CandidateGeneratorRegistry()
    .register(createLexicalGenerator({ name: domain.generatorNames.lexical, featureAxis: domain.axes.text }))
    .register(createFacetGenerator({ name: domain.generatorNames.facet, featureAxis: domain.axes.facet }))
    .register(createGraphGenerator({ name: domain.generatorNames.graph, featureAxis: domain.axes.proximity }));
}

export function contextFor(
  domain: DomainFixture,
  corpus: GraphIR,
  tokenCost?: TokenCostModel,
): QueryEngineContext {
  const base = {
    graph: corpus,
    profiles: { [domain.profile.name]: domain.profile },
    relations: domain.relations,
    projections: domain.projections,
  };
  return tokenCost === undefined ? base : { ...base, tokenCost };
}

/** Issue-tracking corpus. `I6` is the unit no ordinary principal may see. */
export function corpusA(): GraphIR {
  return graph(
    [
      unit({
        id: "I1",
        typeRef: "Issue",
        fields: {
          title: str("login page crashes on submit"),
          priority: num(1),
          labels: list(str("auth"), str("frontend")),
        },
      }),
      unit({
        id: "I2",
        typeRef: "Issue",
        fields: {
          title: str("session token expires far too early"),
          labels: list(str("auth")),
          history: list(obj({ actor: str("alice") }), obj({ actor: str("bob") })),
        },
      }),
      unit({
        id: "I3",
        typeRef: "Issue",
        fields: { title: str("database migration fails on rollback"), labels: list(str("backend")) },
      }),
      unit({
        id: "I4",
        typeRef: "Issue",
        fields: { title: str("login page crashes on submit again"), labels: list(str("auth")) },
      }),
      unit({
        id: "I5",
        typeRef: "Issue",
        fields: { title: str("auth service unavailable during submit"), labels: list(str("auth")) },
      }),
      unit({ id: "N1", typeRef: "Note", fields: { title: str("meeting notes mentioning login") } }),
      unit({
        id: "I6",
        typeRef: "Issue",
        fields: { title: str("login credentials leaked internally") },
        visibility: "private",
        policyLabels: ["security-incident"],
      }),
    ],
    [
      edge("blocked-by", "I1", "I5"),
      edge("blocked-by", "I5", "I3"),
      edge("duplicate-of", "I1", "I4"),
      edge("mentioned-in", "I1", "N1"),
      edge("superseded-by", "I1", "I2"),
      edge("blocked-by", "I1", "I6"),
    ],
  );
}

/** Cooking corpus. Same shapes, no shared vocabulary. */
export function corpusB(): GraphIR {
  return graph(
    [
      unit({
        id: "D1",
        typeRef: "Dish",
        fields: { name: str("lemon risotto"), style: str("italian"), minutes: num(40) },
      }),
      unit({
        id: "D2",
        typeRef: "Dish",
        fields: { name: str("lemon tart"), style: str("french"), minutes: num(90) },
      }),
      unit({ id: "G1", typeRef: "Ingredient", fields: { name: str("arborio rice") } }),
      unit({ id: "G2", typeRef: "Ingredient", fields: { name: str("carnaroli rice") } }),
      unit({ id: "M1", typeRef: "Menu", fields: { name: str("spring tasting menu") } }),
    ],
    [
      edge("needs-ingredient", "D1", "G1"),
      edge("swaps-with", "G1", "G2"),
      edge("course-of", "D1", "M1"),
    ],
  );
}

export const anyPrincipal = {
  id: "tester",
  allowedVisibility: ["public", "shared"] as const,
  grantedPolicyLabels: [] as const,
};

export const clearedPrincipal = {
  id: "responder",
  allowedVisibility: ["public", "shared", "private"] as const,
  grantedPolicyLabels: ["security-incident"] as const,
};
