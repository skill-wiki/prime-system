/**
 * @module test/support/host
 *
 * A structurally complete engine context for the HTTP surface.
 *
 * Built on the same `testkit/fixtures/security-model` Model Package the SDK's own
 * transport tests use, so the semantics under test are declared data rather than
 * test-local invention. Two things are added that the SDK fixture does not need:
 *
 * - a `private` unit and a policy-labelled unit, because the assertions this
 *   package owes are about *who may see what over a network*, and a corpus where
 *   every unit is `public` cannot demonstrate that;
 * - a deterministic tracer, because "the query path emits a retrieval span" is
 *   only evidence if the test can name the span it found.
 */

import { resolve } from "node:path";
import type { GraphIR, SnapshotRef, TypedValueIR, UnitIR } from "@skill-wiki/ir";
import { loadModelOrThrow, type ProjectionDefinition, type RelationDefinition, type RetrievalProfile } from "@skill-wiki/model-schema";
import {
  CandidateGeneratorRegistry,
  createFacetGenerator,
  createGraphGenerator,
  createLexicalGenerator,
  type Principal,
  type QueryEngineContext,
} from "@skill-wiki/query-engine";
import { InMemorySpanSink, createRecordingTracer, createStepClock, type Tracer } from "@skill-wiki/observability";
import { createEmbeddedTransport, type EmbeddedHost } from "@skill-wiki/sdk";
import { createBearerAuthenticator, type Authenticator, type Credential } from "../../src/auth.ts";
import { createRequestHandler } from "../../src/handler.ts";
import type { TraceScope } from "../../src/corpus.ts";

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
  readonly visibility?: UnitIR["visibility"];
  readonly policyLabels?: readonly string[];
}): UnitIR {
  return {
    identity: { id: options.id, version: "1.0.0", digest: `sha256:${options.id}`, corpus: "http-server-test" },
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
    policyLabels: options.policyLabels ?? [],
    lifecycle: "active",
    visibility: options.visibility ?? "public",
    provenance: { source: ORIGIN },
    projections: { summary: `${options.id} summary`, core: `${options.id} core`, full: `${options.id} full` },
  };
}

export const UNIT_IDS = {
  MFA: "control-multi-factor",
  IDP: "control-identity-provider",
  STUFFING: "threat-credential-stuffing",
  SECRET: "control-break-glass",
  LABELLED: "control-vendor-escrow",
} as const;

const units: readonly UnitIR[] = [
  unit({ id: UNIT_IDS.IDP, typeRef: "Control", fields: { name: text("identity provider"), statement: text("federate authentication to one provider") } }),
  unit({
    id: UNIT_IDS.MFA,
    typeRef: "Control",
    fields: { name: text("multi factor"), statement: text("require a second authentication factor") },
    edges: [{ relationRef: "depends-on", to: UNIT_IDS.IDP }, { relationRef: "mitigates", to: UNIT_IDS.STUFFING }],
  }),
  unit({ id: UNIT_IDS.STUFFING, typeRef: "Threat", fields: { name: text("credential stuffing"), vector: text("replayed passwords"), severity: int(4) } }),
  unit({
    id: UNIT_IDS.SECRET,
    typeRef: "Control",
    fields: { name: text("break glass"), statement: text("emergency authentication bypass procedure") },
    visibility: "private",
  }),
  unit({
    id: UNIT_IDS.LABELLED,
    typeRef: "Control",
    fields: { name: text("vendor escrow"), statement: text("third party authentication key escrow") },
    policyLabels: ["contract-confidential"],
  }),
];

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
  const graph: GraphIR = { snapshot: SNAPSHOT, units, edges: units.flatMap(u => u.relations), diagnostics: [], indexes: {} };
  return { graph, profiles, relations, projections };
}

export function registry(): CandidateGeneratorRegistry {
  return new CandidateGeneratorRegistry()
    .register(createLexicalGenerator({ name: "lexical", featureAxis: "lexicalScore" }))
    .register(createGraphGenerator({ name: "graph-neighbors", featureAxis: "graphAffinity" }))
    .register(createFacetGenerator({ name: "severity-ordered", featureAxis: "severityWeight" }));
}

/** Read from the model rather than quoted, so the fixture cannot drift from it. */
export function firstProfileName(engine: QueryEngineContext): string {
  const [name] = Object.keys(engine.profiles).sort();
  if (name === undefined) throw new Error("fixture model declares no retrieval profile");
  return name;
}

export const PUBLIC_TOKEN = "public-token-0123456789abcdef0123456789";
export const CLEARED_TOKEN = "cleared-token-0123456789abcdef0123456789";

export const PUBLIC_PRINCIPAL: Principal = { id: "reader", allowedVisibility: ["public"], grantedPolicyLabels: [] };
export const CLEARED_PRINCIPAL: Principal = {
  id: "auditor",
  allowedVisibility: ["public", "shared", "private"],
  grantedPolicyLabels: ["contract-confidential"],
};

export function credentials(): readonly Credential[] {
  return [
    { token: PUBLIC_TOKEN, principal: PUBLIC_PRINCIPAL },
    { token: CLEARED_TOKEN, principal: CLEARED_PRINCIPAL },
  ];
}

export interface Harness {
  readonly handler: (request: Request) => Promise<Response>;
  readonly engine: QueryEngineContext;
  readonly sink: InMemorySpanSink;
  readonly tracer: Tracer;
  readonly authenticator: Authenticator;
  readonly profile: string;
}

export function harness(options: { readonly requestId?: string } = {}): Harness {
  const engine = loadEngineContext();
  const sink = new InMemorySpanSink();
  const tracer = createRecordingTracer({ sink, clock: createStepClock() });
  const authenticator = createBearerAuthenticator(credentials());
  const embedded: Omit<EmbeddedHost, "tracer" | "traceParent"> = { snapshot: SNAPSHOT, engine, generators: registry() };
  const handler = createRequestHandler({
    authenticator,
    engine,
    tracer,
    transportFor: (scope: TraceScope) => createEmbeddedTransport({
      ...embedded,
      tracer: scope.tracer,
      ...(scope.parent === undefined ? {} : { traceParent: scope.parent }),
    }),
    ...(options.requestId === undefined ? {} : { newRequestId: (): string => options.requestId! }),
  });
  return { handler, engine, sink, tracer, authenticator, profile: firstProfileName(engine) };
}

export function get(path: string, token?: string): Request {
  return new Request(`http://127.0.0.1${path}`, {
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });
}

export function post(path: string, body: unknown, token?: string): Request {
  return new Request(`http://127.0.0.1${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
}
