/**
 * @module test/support/host
 *
 * A minimal but structurally complete embedded host.
 *
 * Relations, projections and the retrieval profile are loaded from the real
 * `security-model` Model Package through the real `loadModel`, so the semantics the
 * engine reads are declared data and not test-local invention. The units are
 * written here as explicit `UnitIR` literals rather than compiled from a corpus,
 * because the subject under test is the transport: the assertion "the transport
 * returns exactly what the engine returns" holds for any valid graph, and pulling a
 * corpus compiler into this package would make an SDK test fail for a compiler
 * reason.
 */

import { resolve } from "node:path";
import type { GraphIR, SnapshotRef, TypedValueIR, UnitIR } from "@aoe/ir";
import { loadModelOrThrow, type ProjectionDefinition, type RelationDefinition, type RetrievalProfile } from "@aoe/model-schema";
import {
  CandidateGeneratorRegistry,
  createFacetGenerator,
  createGraphGenerator,
  createLexicalGenerator,
  type QueryEngineContext,
} from "@aoe/query-engine";

export const MODEL_ROOT = resolve(import.meta.dir, "../../../testkit/fixtures/security-model");

const ORIGIN = { loc: { line: 0, column: 0, offset: 0 } } as const;
const text = (value: string): TypedValueIR => ({ kind: "string", value, source: ORIGIN });
const int = (value: number): TypedValueIR => ({ kind: "number", value, source: ORIGIN });

export const SNAPSHOT: SnapshotRef = {
  modelRelease: "2026.08.29.1",
  modelDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000001",
  corpusRelease: "2026.08.29.1",
  corpusDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000002",
};

function unit(options: {
  readonly id: string;
  readonly typeRef: string;
  readonly fields: Readonly<Record<string, TypedValueIR>>;
  readonly edges?: readonly { readonly relationRef: string; readonly to: string }[];
}): UnitIR {
  return {
    identity: { id: options.id, version: "1.0.0", digest: `sha256:${options.id}`, corpus: "sdk-embedded-test" },
    typeRef: options.typeRef,
    implements: [],
    fields: options.fields,
    relations: (options.edges ?? []).map(edge => ({
      id: `${options.id}::${edge.relationRef}::${edge.to}`,
      relationRef: edge.relationRef,
      from: options.id,
      to: edge.to,
    })),
    citations: [],
    policyLabels: [],
    lifecycle: "active",
    visibility: "public",
    provenance: { source: ORIGIN },
    projections: {
      summary: `${options.id} summary`,
      core: `${options.id} core`,
      full: `${options.id} full`,
    },
  };
}

const MFA = "control-multi-factor";
const IDP = "control-identity-provider";
const STUFFING = "threat-credential-stuffing";

const units: readonly UnitIR[] = [
  unit({
    id: IDP,
    typeRef: "Control",
    fields: { name: text("identity provider"), statement: text("federate authentication to one provider") },
  }),
  unit({
    id: MFA,
    typeRef: "Control",
    fields: { name: text("multi factor"), statement: text("require a second authentication factor") },
    edges: [{ relationRef: "depends-on", to: IDP }, { relationRef: "mitigates", to: STUFFING }],
  }),
  unit({
    id: STUFFING,
    typeRef: "Threat",
    fields: { name: text("credential stuffing"), vector: text("replayed passwords"), severity: int(4) },
  }),
];

export const UNIT_IDS = { MFA, IDP, STUFFING } as const;

export function loadEngineContext(): QueryEngineContext {
  const model = loadModelOrThrow(MODEL_ROOT);
  const relations: Record<string, RelationDefinition> = {};
  const projections: Record<string, ProjectionDefinition> = {};
  const profiles: Record<string, RetrievalProfile> = {};
  for (const definition of model.definitions) {
    if (definition.kind === "relation") relations[definition.name] = definition;
    if (definition.kind === "projection") projections[definition.name] = definition;
    if (definition.kind === "retrieval-profile") profiles[definition.name] = definition;
  }
  const graph: GraphIR = {
    snapshot: SNAPSHOT,
    units,
    edges: units.flatMap(u => u.relations),
    diagnostics: [],
    indexes: {},
  };
  return { graph, profiles, relations, projections };
}

/** Registered under the three names the model's own profile declares. */
export function registry(): CandidateGeneratorRegistry {
  return new CandidateGeneratorRegistry()
    .register(createLexicalGenerator({ name: "lexical", featureAxis: "lexicalScore" }))
    .register(createGraphGenerator({ name: "graph-neighbors", featureAxis: "graphAffinity" }))
    .register(createFacetGenerator({ name: "severity-ordered", featureAxis: "severityWeight" }));
}
