/**
 * @module test/support/domains
 *
 * Three unrelated domains, each a *real* model package plus a *real* corpus, all
 * loaded through the shipped loaders (`loadModelOrThrow`, `loadCorpus`) rather
 * than hand-built objects. This is what plan §16 Phase 3's second acceptance
 * criterion asks for — "three unrelated domains use the same Query Engine" — and
 * the reason it needs real packages is that a hand-built fixture can silently
 * agree with the engine about a field name the loader would have rejected.
 *
 * Nothing here adapts the engine to a domain. The only per-domain code is:
 *   1. corpus JSON -> `UnitIR` (`toUnitIR`, identical for all three), and
 *   2. which generator implementation is registered under which *model-declared*
 *      name, with the axis the *model* declares (`DomainDescriptor.registry`).
 *
 * Everything the assertions compare against is read back out of the fixture's own
 * YAML, so a domain constant leaking into `src/` breaks exactly one domain and the
 * three-way comparison localises it.
 */

import { resolve } from "node:path";
import type { GraphEdgeIR, GraphIR, SelectionCandidateIR, TypedValueIR, UnitIR } from "@skill-wiki/ir";
import {
  loadModelOrThrow,
  type ProjectionDefinition,
  type RelationDefinition,
  type RetrievalProfile,
} from "@skill-wiki/model-schema";
import { loadCorpus, type CorpusUnitRecord } from "@skill-wiki/testkit";
import {
  CandidateGeneratorRegistry,
  createFacetGenerator,
  createGraphGenerator,
  createLexicalGenerator,
  type CandidateGenerator,
  type Principal,
  type QueryEngineContext,
  type TokenCostModel,
} from "../../src/index.ts";

const FIXTURES = resolve(import.meta.dir, "../../../testkit/fixtures");
const loc = { line: 1, column: 1, offset: 0 } as const;

function toTypedValue(value: unknown): TypedValueIR {
  if (typeof value === "string") return { kind: "string", value, source: { loc } };
  if (typeof value === "number") return { kind: "number", value, source: { loc } };
  if (typeof value === "boolean") return { kind: "boolean", value, source: { loc } };
  if (Array.isArray(value)) return { kind: "array", items: value.map(toTypedValue), source: { loc } };
  if (value !== null && typeof value === "object") {
    const fields: Record<string, TypedValueIR> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      fields[key] = toTypedValue((value as Record<string, unknown>)[key]);
    }
    return { kind: "object", fields, source: { loc } };
  }
  // `null` has no TypedValueIR form; the empty string keeps the adapter total
  // without inventing a new IR kind.
  return { kind: "string", value: "", source: { loc } };
}

function toUnitIR(record: CorpusUnitRecord, corpusName: string): UnitIR {
  const fields: Record<string, TypedValueIR> = {};
  for (const key of Object.keys(record.fields).sort()) fields[key] = toTypedValue(record.fields[key]);
  return {
    identity: {
      id: record.id,
      version: record.version,
      digest: record.digest ?? `sha256:${record.id}`,
      corpus: corpusName,
    },
    typeRef: record.typeRef,
    implements: [],
    fields,
    relations: record.relations.map(relation => ({
      id: `${relation.relation}:${record.id}->${relation.to}`,
      relationRef: relation.relation,
      from: record.id,
      to: relation.to,
    })),
    citations: record.citations,
    policyLabels: [],
    lifecycle: record.lifecycle,
    visibility: record.visibility,
    provenance: { source: { loc } },
    projections: {},
  };
}

export interface LoadedDomain {
  readonly graph: GraphIR;
  readonly relations: Readonly<Record<string, RelationDefinition>>;
  readonly projections: Readonly<Record<string, ProjectionDefinition>>;
  readonly profiles: Readonly<Record<string, RetrievalProfile>>;
  readonly tokenCost: TokenCostModel;
  readonly context: QueryEngineContext;
}

/**
 * Load one fixture model package plus its corpus. Identical for every domain —
 * if this function needed a per-domain branch, the engine would not be generic.
 */
export function loadDomainPackage(fixtureDir: string, corpusRelativePath = "corpus/units.yaml"): LoadedDomain {
  const root = resolve(FIXTURES, fixtureDir);
  const model = loadModelOrThrow(root);
  const corpus = loadCorpus(resolve(root, corpusRelativePath));
  if (!corpus.ok) {
    throw new Error(`${fixtureDir} corpus failed to load: ${JSON.stringify(corpus.diagnostics)}`);
  }

  const relations: Record<string, RelationDefinition> = {};
  const projections: Record<string, ProjectionDefinition> = {};
  const profiles: Record<string, RetrievalProfile> = {};
  for (const definition of model.definitions) {
    if (definition.kind === "relation") relations[definition.name] = definition;
    if (definition.kind === "projection") projections[definition.name] = definition;
    if (definition.kind === "retrieval-profile") profiles[definition.name] = definition;
  }

  const units = corpus.value.units.map(record => toUnitIR(record, corpus.value.name));
  const edges: GraphEdgeIR[] = units.flatMap(unit => unit.relations);
  const graph: GraphIR = {
    snapshot: {
      modelRelease: model.manifest.version,
      modelDigest: `model:${model.manifest.name}`,
      corpusRelease: corpus.value.version,
      corpusDigest: `corpus:${corpus.value.name}`,
    },
    units,
    edges,
    diagnostics: [],
    indexes: {},
  };

  // Every fixture corpus publishes measured tokens per projection, so budgeting
  // runs on real numbers instead of the projection's declared target.
  const measured = new Map(corpus.value.units.map(unit => [unit.id, unit.tokens]));
  const tokenCost: TokenCostModel = (unitId, projectionRef) => measured.get(unitId)?.[projectionRef];

  return {
    graph,
    relations,
    projections,
    profiles,
    tokenCost,
    context: { graph, profiles, relations, projections, tokenCost },
  };
}

/**
 * Ranks units by the magnitude of one numeric field. Every one of the three
 * fixtures declares a generator of this shape under a different name, over a
 * different field, writing a different axis — which is exactly why the field path
 * is configuration and `src/` still names no field.
 */
export function createFieldMagnitudeGenerator(config: {
  readonly name: string;
  readonly featureAxis: string;
  readonly path: readonly string[];
}): CandidateGenerator {
  return {
    name: config.name,
    featureAxes: [config.featureAxis],
    generate(_request, graph): readonly SelectionCandidateIR[] {
      const readings: { readonly unitId: string; readonly value: number }[] = [];
      for (const unit of graph.units) {
        let current: TypedValueIR | undefined = unit.fields[config.path[0]!];
        for (const segment of config.path.slice(1)) {
          current = current !== undefined && current.kind === "object" ? current.fields[segment] : undefined;
        }
        if (current !== undefined && current.kind === "number") {
          readings.push({ unitId: unit.identity.id, value: current.value });
        }
      }
      const max = readings.reduce((best, entry) => Math.max(best, entry.value), 0);
      if (max <= 0) return [];
      return readings
        .map(entry => ({
          unitId: entry.unitId,
          score: 0,
          featureValues: { [config.featureAxis]: Math.round((entry.value / max) * 1e6) / 1e6 },
          reasons: [`${config.name}: ${config.path.join(".")}=${entry.value} of max ${max}`],
        }))
        .sort((a, b) => (a.unitId < b.unitId ? -1 : a.unitId > b.unitId ? 1 : 0));
    },
  };
}

/**
 * One domain under test. Every field is a *name taken from the fixture*, never a
 * name the engine knows: the conformance suite reads the model's declarations and
 * asserts the engine obeyed them.
 */
export interface DomainDescriptor {
  readonly label: string;
  readonly fixtureDir: string;
  /** The `retrieval-profile` this domain's model declares. */
  readonly profileName: string;
  /** Generators bound under the names the profile asks for. */
  readonly registry: () => CandidateGeneratorRegistry;
  /** Free text that hits this corpus. */
  readonly text: string;
  /** Seed unit for graph proximity and closure expansion. */
  readonly seed: string;
  /** A `selection: closure` relation and the unit it must pull in from `seed`. */
  readonly closure: { readonly relationRef: string; readonly pulls: string };
  /** A `selection: exclude` relation and the pair it relates. */
  readonly exclusion: { readonly relationRef: string; readonly a: string; readonly b: string };
  /** A `selection: informational` relation, which must never widen the set. */
  readonly informationalRelation: string;
  /**
   * The unit the ACL test downgrades to `visibility: private`. It is deliberately
   * the closure target: proving the ACL beats a *hard* pull is stronger than
   * proving it beats a ranked candidate, and it is the case that would otherwise
   * leak an id through an unsat/expansion explanation.
   */
  readonly aclSubject: string;
  /**
   * A unit the corpus itself publishes as `visibility: private`, when it has one.
   * `security-model` has none, which is why `aclSubject` exists separately.
   */
  readonly bornPrivate?: string;
  /** `cyclePolicy` the closure relation declares — differs across the three. */
  readonly closureCyclePolicy: RelationDefinition["semantics"]["cyclePolicy"];
  /** `conflictSeverity` the exclusion relation declares — differs across the three. */
  readonly exclusionSeverity: RelationDefinition["semantics"]["conflictSeverity"];
  /** Whether the profile declares a reranker, hence whether the gap is reported. */
  readonly declaresReranker: boolean;
}

const security: DomainDescriptor = {
  label: "security (@sec)",
  fixtureDir: "security-model",
  profileName: "audit-default",
  registry: () =>
    new CandidateGeneratorRegistry()
      .register(createLexicalGenerator({ name: "lexical", featureAxis: "lexicalScore" }))
      .register(createGraphGenerator({ name: "graph-neighbors", featureAxis: "graphAffinity" }))
      .register(
        createFieldMagnitudeGenerator({
          name: "severity-ordered",
          featureAxis: "severityWeight",
          path: ["severity"],
        }),
      )
      .register(createFacetGenerator({ name: "facet", featureAxis: "facetMatch" })),
  text: "multi factor authentication control",
  seed: "@sec/control-multi-factor",
  closure: { relationRef: "depends-on", pulls: "@sec/control-identity-provider" },
  exclusion: {
    relationRef: "incompatible-with",
    a: "@sec/control-request-filter",
    b: "@sec/control-inline-proxy",
  },
  informationalRelation: "assesses",
  aclSubject: "@sec/control-identity-provider",
  closureCyclePolicy: "reject",
  exclusionSeverity: "error",
  declaresReranker: true,
};

const recipes: DomainDescriptor = {
  label: "recipes (@kitchen)",
  fixtureDir: "recipe-model",
  profileName: "kitchen-default",
  registry: () =>
    new CandidateGeneratorRegistry()
      .register(createLexicalGenerator({ name: "text-match", featureAxis: "textScore" }))
      .register(createGraphGenerator({ name: "pantry-neighbors", featureAxis: "pantryAffinity" }))
      .register(
        createFieldMagnitudeGenerator({
          name: "time-ordered",
          featureAxis: "timeWeight",
          path: ["minutes"],
        }),
      ),
  text: "lemon risotto rice",
  seed: "@kitchen/dish-lemon-risotto",
  closure: { relationRef: "builds-on", pulls: "@kitchen/dish-base-risotto" },
  exclusion: {
    relationRef: "swaps-with",
    a: "@kitchen/ingredient-arborio-rice",
    b: "@kitchen/ingredient-carnaroli-rice",
  },
  informationalRelation: "contains-allergen",
  aclSubject: "@kitchen/dish-base-risotto",
  bornPrivate: "@kitchen/dish-unreleased-tasting-menu",
  closureCyclePolicy: "reject",
  exclusionSeverity: "warning",
  declaresReranker: false,
};

const incidents: DomainDescriptor = {
  label: "custom-ticket (@ops)",
  fixtureDir: "incident-ops-model",
  profileName: "triage-default",
  registry: () =>
    new CandidateGeneratorRegistry()
      .register(createLexicalGenerator({ name: "keyword", featureAxis: "keywordScore" }))
      .register(createGraphGenerator({ name: "link-walk", featureAxis: "linkAffinity" }))
      .register(
        createFieldMagnitudeGenerator({
          name: "urgency-ranked",
          featureAxis: "urgencyWeight",
          path: ["urgency"],
        }),
      ),
  text: "checkout latency payment gateway",
  seed: "@ops/incident-checkout-latency",
  closure: { relationRef: "escalates-to", pulls: "@ops/incident-payment-timeout" },
  exclusion: {
    relationRef: "contends-with",
    a: "@ops/runbook-scale-out",
    b: "@ops/runbook-failover",
  },
  informationalRelation: "owned-by",
  aclSubject: "@ops/incident-payment-timeout",
  bornPrivate: "@ops/incident-insider-access",
  closureCyclePolicy: "collapse",
  exclusionSeverity: "error",
  declaresReranker: true,
};

/** The three unrelated domains of plan §16 Phase 3, in a stable order. */
export const DOMAINS: readonly DomainDescriptor[] = [security, recipes, incidents];

/** Returns a copy of `domain` with one unit forced to `visibility: private`. */
export function withPrivateUnit(loaded: LoadedDomain, unitId: string): LoadedDomain {
  const units = loaded.graph.units.map(unit =>
    unit.identity.id === unitId ? { ...unit, visibility: "private" as const } : unit,
  );
  const graph: GraphIR = { ...loaded.graph, units };
  return { ...loaded, graph, context: { ...loaded.context, graph } };
}

/** A principal cleared for nothing beyond the default visibilities. */
export const ordinaryPrincipal: Principal = {
  id: "conformance-reader",
  allowedVisibility: ["public", "shared"],
  grantedPolicyLabels: [],
};

/** A principal cleared for private units, used to prove the ACL is the only gate. */
export const clearedPrincipal: Principal = {
  id: "conformance-owner",
  allowedVisibility: ["public", "shared", "private"],
  grantedPolicyLabels: [],
};
