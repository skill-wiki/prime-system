/**
 * @module test/support/model
 *
 * Two deliberately unrelated model packages plus the IR builders needed to feed
 * them to the engine.
 *
 * They disagree on everything a domain can disagree on: type names, relation
 * names, relation semantics, projection names, token sizes, feature axis names,
 * and even the names the generators are registered under. If the same engine code
 * produces a sensible plan for both, the domain really is external — which is the
 * §16 Phase 3 conformance claim these fixtures exist to test.
 */

import type {
  GraphEdgeIR,
  GraphIR,
  SnapshotRef,
  TypedValueIR,
  UnitIR,
} from "@skill-wiki/ir";
import type {
  ProjectionDefinition,
  RelationDefinition,
  RetrievalProfile,
} from "@skill-wiki/model-schema";

const loc = { line: 1, column: 1, offset: 0 } as const;

export function str(value: string): TypedValueIR {
  return { kind: "string", value, source: { loc } };
}

export function num(value: number): TypedValueIR {
  return { kind: "number", value, source: { loc } };
}

export function list(...items: readonly TypedValueIR[]): TypedValueIR {
  return { kind: "array", items, source: { loc } };
}

export function obj(fields: Readonly<Record<string, TypedValueIR>>): TypedValueIR {
  return { kind: "object", fields, source: { loc } };
}

export function unit(params: {
  readonly id: string;
  readonly typeRef: string;
  readonly fields: Readonly<Record<string, TypedValueIR>>;
  readonly implements?: readonly string[];
  readonly visibility?: UnitIR["visibility"];
  readonly lifecycle?: UnitIR["lifecycle"];
  readonly policyLabels?: readonly string[];
  readonly relations?: readonly GraphEdgeIR[];
}): UnitIR {
  return {
    identity: { id: params.id, version: "1.0.0", digest: `digest-${params.id}`, corpus: "test" },
    typeRef: params.typeRef,
    implements: params.implements ?? [],
    fields: params.fields,
    relations: params.relations ?? [],
    citations: [],
    policyLabels: params.policyLabels ?? [],
    lifecycle: params.lifecycle ?? "active",
    visibility: params.visibility ?? "public",
    provenance: { source: { loc } },
    projections: {},
  };
}

export function edge(relationRef: string, from: string, to: string): GraphEdgeIR {
  return { id: `${relationRef}:${from}->${to}`, relationRef, from, to };
}

export const snapshot: SnapshotRef = {
  modelRelease: "1.0.0",
  modelDigest: "model-digest",
  corpusRelease: "1.0.0",
  corpusDigest: "corpus-digest",
};

export function graph(units: readonly UnitIR[], edges: readonly GraphEdgeIR[]): GraphIR {
  return { snapshot, units, edges, diagnostics: [], indexes: {} };
}

function relation(params: {
  readonly name: string;
  readonly from: string;
  readonly to: string;
  readonly directional?: boolean;
  readonly semantics: RelationDefinition["semantics"];
}): RelationDefinition {
  return {
    kind: "relation",
    name: params.name,
    version: "1.0.0",
    from: params.from,
    to: params.to,
    cardinality: "many-to-many",
    directional: params.directional ?? true,
    semantics: params.semantics,
  };
}

export function projection(name: string, targetTokens: number): ProjectionDefinition {
  return {
    kind: "projection",
    name,
    version: "1.0.0",
    targetTokens,
    include: [],
    exclude: [],
    typeGroups: {},
    rules: [],
  };
}

function profile(params: {
  readonly name: string;
  readonly projection: string;
  readonly generators: readonly { readonly name: string; readonly weight: number }[];
  readonly features: Readonly<Record<string, number>>;
}): RetrievalProfile {
  return {
    kind: "retrieval-profile",
    name: params.name,
    version: "1.0.0",
    projection: params.projection,
    candidateGenerators: [...params.generators],
    features: params.features,
    constraints: ["relationSemantics", "visibility", "tokenBudget"],
  };
}

/* -------------------------------------------------------------------------- */
/* Domain A — issue tracking                                                  */
/* -------------------------------------------------------------------------- */

export const domainA = {
  generatorNames: { lexical: "lexical", facet: "facet", graph: "graph" },
  axes: { text: "textMatch", facet: "facetMatch", proximity: "graphProximity" },
  relations: {
    "blocked-by": relation({
      name: "blocked-by",
      from: "Issue",
      to: "Issue",
      semantics: {
        traversal: "transitive",
        selection: "closure",
        loadOrder: "before",
        cyclePolicy: "reject",
        conflictSeverity: "none",
      },
    }),
    "duplicate-of": relation({
      name: "duplicate-of",
      from: "Issue",
      to: "Issue",
      directional: false,
      semantics: {
        traversal: "one-hop",
        selection: "exclude",
        loadOrder: "none",
        cyclePolicy: "collapse",
        conflictSeverity: "error",
      },
    }),
    "mentioned-in": relation({
      name: "mentioned-in",
      from: "Issue",
      to: "Note",
      semantics: {
        traversal: "one-hop",
        selection: "informational",
        loadOrder: "none",
        cyclePolicy: "allow",
        conflictSeverity: "none",
      },
    }),
    // Declared `expand` but `traversal: none`: the traversal bound must win, and a
    // test asserts this relation never contributes a discovery.
    "superseded-by": relation({
      name: "superseded-by",
      from: "Issue",
      to: "Issue",
      semantics: {
        traversal: "none",
        selection: "expand",
        loadOrder: "none",
        cyclePolicy: "allow",
        conflictSeverity: "none",
      },
    }),
  } satisfies Readonly<Record<string, RelationDefinition>>,
  projections: {
    brief: projection("brief", 30),
    detailed: projection("detailed", 120),
  } satisfies Readonly<Record<string, ProjectionDefinition>>,
  profile: profile({
    name: "triage",
    projection: "detailed",
    generators: [
      { name: "lexical", weight: 1 },
      { name: "facet", weight: 1 },
      { name: "graph", weight: 1 },
    ],
    features: { textMatch: 1, facetMatch: 1.5, graphProximity: 0.5 },
  }),
};

/* -------------------------------------------------------------------------- */
/* Domain B — cooking. Nothing is shared with domain A, not even axis names.   */
/* -------------------------------------------------------------------------- */

export const domainB = {
  generatorNames: { lexical: "bm25", facet: "structural", graph: "neighbourhood" },
  axes: { text: "phraseHit", facet: "shapeHit", proximity: "hops" },
  relations: {
    "needs-ingredient": relation({
      name: "needs-ingredient",
      from: "Dish",
      to: "Ingredient",
      semantics: {
        traversal: "one-hop",
        selection: "expand",
        loadOrder: "after",
        cyclePolicy: "allow",
        conflictSeverity: "none",
      },
    }),
    "swaps-with": relation({
      name: "swaps-with",
      from: "Ingredient",
      to: "Ingredient",
      directional: false,
      semantics: {
        traversal: "one-hop",
        selection: "exclude",
        loadOrder: "none",
        cyclePolicy: "collapse",
        // `warning`, not `error`: domain B tolerates both sides of a swap, which
        // proves conflictSeverity is read rather than assumed.
        conflictSeverity: "warning",
      },
    }),
    "course-of": relation({
      name: "course-of",
      from: "Dish",
      to: "Menu",
      semantics: {
        traversal: "transitive",
        selection: "closure",
        loadOrder: "before",
        cyclePolicy: "collapse",
        conflictSeverity: "none",
      },
    }),
  } satisfies Readonly<Record<string, RelationDefinition>>,
  projections: {
    card: projection("card", 25),
    sheet: projection("sheet", 90),
  } satisfies Readonly<Record<string, ProjectionDefinition>>,
  profile: profile({
    name: "menu",
    projection: "sheet",
    generators: [
      { name: "bm25", weight: 1 },
      { name: "structural", weight: 2 },
      { name: "neighbourhood", weight: 0.5 },
    ],
    features: { phraseHit: 1, shapeHit: 1, hops: 2 },
  }),
};
