/**
 * @module test/support/security-model
 *
 * Loads `packages/testkit/fixtures/security-model/` — a real second-domain model
 * package plus corpus — through the actual loaders (`loadModel`, `loadCorpus`)
 * rather than hand-built objects. The point is that nothing here adapts the engine
 * to the domain: the adapter only converts corpus JSON into `UnitIR`, and the
 * generators are registered under the names the model's own retrieval profile asks
 * for (`lexical`, `graph-neighbors`, `severity-ordered`).
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
  type QueryEngineContext,
  type TokenCostModel,
} from "../../src/index.ts";

const FIXTURE_ROOT = resolve(import.meta.dir, "../../../testkit/fixtures/security-model");
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
  // `null` has no TypedValueIR form; representing it as the empty string keeps the
  // adapter total without inventing a new IR kind.
  return { kind: "string", value: "", source: { loc } };
}

function toUnitIR(record: CorpusUnitRecord): UnitIR {
  const fields: Record<string, TypedValueIR> = {};
  for (const key of Object.keys(record.fields).sort()) fields[key] = toTypedValue(record.fields[key]);
  return {
    identity: {
      id: record.id,
      version: record.version,
      digest: record.digest ?? `sha256:${record.id}`,
      corpus: "security-controls-min",
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

export interface SecurityModel {
  readonly graph: GraphIR;
  readonly relations: Readonly<Record<string, RelationDefinition>>;
  readonly projections: Readonly<Record<string, ProjectionDefinition>>;
  readonly profiles: Readonly<Record<string, RetrievalProfile>>;
  readonly tokenCost: TokenCostModel;
  readonly context: QueryEngineContext;
}

export function loadSecurityModel(): SecurityModel {
  const model = loadModelOrThrow(FIXTURE_ROOT);
  const corpus = loadCorpus(resolve(FIXTURE_ROOT, "corpus/units.yaml"));
  if (!corpus.ok) throw new Error(`security-model corpus failed to load: ${JSON.stringify(corpus.diagnostics)}`);

  const relations: Record<string, RelationDefinition> = {};
  const projections: Record<string, ProjectionDefinition> = {};
  const profiles: Record<string, RetrievalProfile> = {};
  for (const definition of model.definitions) {
    if (definition.kind === "relation") relations[definition.name] = definition;
    if (definition.kind === "projection") projections[definition.name] = definition;
    if (definition.kind === "retrieval-profile") profiles[definition.name] = definition;
  }

  const units = corpus.value.units.map(toUnitIR);
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

  // The corpus publishes measured tokens per projection, so the budget runs on real
  // numbers rather than the projection's declared target.
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
 * The model's profile names a third generator, `severity-ordered`, that this
 * package has no builtin for. Supplying it from the host is the SPI working as
 * intended: the field it ranks on is configuration, so `src/` still names no field.
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

/** Registry wired to the names and axes the model's own profile declares. */
export function securityRegistry(): CandidateGeneratorRegistry {
  return new CandidateGeneratorRegistry()
    .register(createLexicalGenerator({ name: "lexical", featureAxis: "lexicalScore" }))
    .register(createGraphGenerator({ name: "graph-neighbors", featureAxis: "graphAffinity" }))
    .register(
      createFieldMagnitudeGenerator({
        name: "severity-ordered",
        featureAxis: "severityWeight",
        path: ["severity"],
      }),
    )
    .register(createFacetGenerator({ name: "facet", featureAxis: "facetMatch" }));
}
