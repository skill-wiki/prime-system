/**
 * The serve path: `aoe_query` implemented on `@aoe/query-engine` and
 * `@aoe/projection-engine`.
 *
 * The ordering below is a security property and must not be rearranged:
 *
 *   admission (ACL) → candidate generation → scoring → expansion → budget
 *                   → projection selection → redaction → transport
 *
 * Admission is inside `runRetrieval`/`admit` (query-engine) and therefore runs
 * *before* anything else observes a unit — including before any solving. That
 * order is load-bearing: a hard requirement pointing at a unit the principal may
 * not see would be reported as unsatisfiable, and the failure mode itself would
 * disclose that the unit exists. Every scope in this module goes through
 * admission first, and the graph handed onward is the admitted one.
 */

import type { DiagnosticIR, GraphIR, SelectionPlanIR, SnapshotRef as IrSnapshotRef, UnitIR } from "@aoe/ir";
import {
  CandidateGeneratorRegistry,
  admit,
  createFacetGenerator,
  createGraphGenerator,
  createLexicalGenerator,
  createUnimplementedGenerator,
  planSelection,
  QueryEngineError,
  type Principal,
  type QueryRequest,
} from "@aoe/query-engine";
import {
  ProjectionCache,
  ProjectionEngine,
  parseProjectionUri,
  type ProjectionLevel,
  type ProjectionPayload,
  type ProjectionRequest,
  type ProjectionScope,
  type TransportKind,
} from "@aoe/projection-engine";
import type { ServeModel } from "./model-context";
import { cheaperProjections } from "./model-context";
import type { CorpusGraph } from "./corpus-graph";
import type { QueryResult } from "./query-response";

/** Which query-engine generator implementation backs a profile-declared name. */
export type GeneratorMechanism = "lexical" | "facet" | "graph" | "reserved";

export interface GeneratorBinding {
  readonly mechanism: GeneratorMechanism;
  /** Feature axis the generator writes; must appear in the profile's `features`. */
  readonly featureAxis: string;
}

/**
 * Host wiring, not model data — and that is a gap, not a preference.
 * `RetrievalProfileSchema.candidateGenerators` (`model-schema/src/index.ts:16`)
 * carries `{name, weight}` and nothing that links a generator to the axis it
 * writes or to an implementation, so the link has to live on the host side. A
 * profile can override the table through `extensions.generatorBindings`; see the
 * lane report for the proposed schema fix.
 */
export const DEFAULT_GENERATOR_BINDINGS: Readonly<Record<string, GeneratorBinding>> = {
  lexical: { mechanism: "lexical", featureAxis: "lexicalScore" },
  "graph-neighbors": { mechanism: "graph", featureAxis: "graphAffinity" },
  facet: { mechanism: "facet", featureAxis: "facetMatch" },
};

export interface QueryArguments {
  readonly scope: "atoms" | "related" | "show";
  readonly query?: string;
  readonly id?: string;
  readonly level?: string;
  readonly kind?: string;
  readonly limit?: number;
  /**
   * Starting units for the graph-proximity generator. Added because the v1
   * model's profile weights a graph axis at 0.3 and there was previously no way
   * for a caller to reach it, so 30% of the declared scoring was unreachable.
   */
  readonly seeds?: readonly string[];
}

export interface ServeOptions {
  readonly model: ServeModel;
  readonly corpus: CorpusGraph;
  readonly bundleRoot: string;
  readonly scope: ProjectionScope;
  readonly principal: Principal;
  readonly transport: TransportKind;
  /** Token budget for a whole `scope=atoms` response. */
  readonly maxTokens: number;
  readonly generatorBindings?: Readonly<Record<string, GeneratorBinding>>;
}

export type ServeOutcome =
  | { readonly results: readonly QueryResult[]; readonly diagnostics: readonly DiagnosticIR[] }
  | { readonly error: string };

/**
 * `aoe_plan` arguments: the retrieval-shaped subset of `aoe_query`.
 *
 * There is no `scope`, because plan has only one meaning. `level` is accepted
 * because it changes the plan — it sets the primary projection the budget tries
 * first and therefore the fallback chain below it.
 */
export interface PlanArguments {
  readonly query?: string;
  readonly seeds?: readonly string[];
  readonly kind?: string;
  readonly level?: string;
  readonly limit?: number;
}

export type PlanOutcome =
  | { readonly plan: SelectionPlanIR }
  | { readonly error: string };

/** Preserved verbatim from the pre-cutover implementation; see the lane report. */
const NOT_FOUND = (id: string): string => `Atom not found: ${id}`;
const REQUIRES_ID = (scope: string): string => `scope=${scope} requires \`id\`.`;

function bindingsFor(options: ServeOptions, profileName: string): Readonly<Record<string, GeneratorBinding>> {
  const profile = options.model.profiles[profileName];
  const declared = profile?.extensions?.["generatorBindings"];
  const fromModel = readBindings(declared);
  return { ...DEFAULT_GENERATOR_BINDINGS, ...options.generatorBindings, ...fromModel };
}

/** Narrow an untrusted extension value; an unusable entry is dropped, not guessed. */
function readBindings(raw: unknown): Readonly<Record<string, GeneratorBinding>> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, GeneratorBinding> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    const mechanism = record["mechanism"];
    const featureAxis = record["featureAxis"];
    if (typeof featureAxis !== "string" || featureAxis === "") continue;
    if (mechanism !== "lexical" && mechanism !== "facet" && mechanism !== "graph" && mechanism !== "reserved") {
      continue;
    }
    out[name] = { mechanism, featureAxis };
  }
  return out;
}

function buildRegistry(
  options: ServeOptions,
  profileName: string,
): CandidateGeneratorRegistry {
  const profile = options.model.profiles[profileName];
  const registry = new CandidateGeneratorRegistry();
  const bindings = bindingsFor(options, profileName);
  for (const declared of profile?.candidateGenerators ?? []) {
    const binding = bindings[declared.name];
    if (binding === undefined) {
      // Loud, not silent: an unbound generator name would otherwise contribute
      // zero candidates and look like a corpus with poor recall.
      registry.register(
        createUnimplementedGenerator({
          name: declared.name,
          featureAxes: Object.keys(profile?.features ?? {}),
          reason: `no host binding for generator '${declared.name}'`,
        }),
      );
      continue;
    }
    if (binding.mechanism === "lexical") {
      registry.register(createLexicalGenerator({ name: declared.name, featureAxis: binding.featureAxis }));
    } else if (binding.mechanism === "graph") {
      registry.register(createGraphGenerator({ name: declared.name, featureAxis: binding.featureAxis }));
    } else if (binding.mechanism === "facet") {
      registry.register(createFacetGenerator({ name: declared.name, featureAxis: binding.featureAxis }));
    } else {
      registry.register(
        createUnimplementedGenerator({
          name: declared.name,
          featureAxes: [binding.featureAxis],
          reason: "declared as a reserved slot by the model",
        }),
      );
    }
  }
  return registry;
}

/** The only retrieval profile in play, chosen from model data rather than named here. */
function profileName(model: ServeModel): string {
  return Object.keys(model.profiles).sort()[0]!;
}

function admittedGraph(options: ServeOptions, request: QueryRequest): GraphIR {
  return admit(options.corpus.graph, request).graph;
}

function baseRequest(options: ServeOptions, profile: string, args: QueryArguments): QueryRequest {
  const requiredFacets =
    args.kind === undefined ? undefined : ([{ kind: "typeRef", anyOf: [args.kind] }] as const);
  return {
    requestId: `${args.scope}:${args.query ?? args.id ?? ""}`,
    profile,
    principal: options.principal,
    maxTokens: options.maxTokens,
    ...(args.query === undefined ? {} : { text: args.query }),
    ...(args.seeds === undefined || args.seeds.length === 0 ? {} : { seeds: args.seeds }),
    ...(requiredFacets === undefined ? {} : { requiredFacets }),
    ...(args.limit === undefined ? {} : { limit: args.limit }),
  };
}

/** Resolve the level a unit is to be rendered at, by name, from the catalog. */
function levelFor(model: ServeModel, projectionRef: string): ProjectionLevel | undefined {
  for (const name of model.catalog.profiles()) {
    const found = model.catalog
      .levels(name)
      .find((level) => level.definitionName === projectionRef);
    if (found !== undefined) return found;
  }
  return undefined;
}

interface Delivery {
  readonly payload: ProjectionPayload;
  readonly level: string;
  readonly profile: string;
}

/**
 * Render one unit at one model-declared projection through projection-engine.
 *
 * The engine is invoked per unit-and-level because the level was already chosen
 * upstream — by the caller for `show`, by query-engine's budget for `atoms`. The
 * value projection-engine adds here is the part the previous implementation had
 * none of: bundle containment on a data-supplied artifact path (§12.3), transport
 * negotiation (§9.5), the `aoe://` identity (§11.3), redaction ordering, and a
 * cache key carrying tenant and snapshot (§12.4).
 */
function project(
  options: ServeOptions,
  unit: UnitIR,
  projectionRef: string,
  cache: ProjectionCache<ProjectionPayload>,
  diagnostics: DiagnosticIR[],
): Delivery | undefined {
  const level = levelFor(options.model, projectionRef);
  if (level === undefined) {
    diagnostics.push({
      code: "PROJECTION_LEVEL_UNKNOWN",
      message: `${unit.identity.id}: projection '${projectionRef}' is not in the catalog`,
      severity: "error",
    });
    return undefined;
  }
  const engine = new ProjectionEngine({
    catalog: options.model.catalog,
    // Route this one call at exactly the level chosen upstream. Purpose routing
    // stays model-derived (`ServeModel.routing`); this narrows it to one level so
    // the engine does not re-decide a choice the budget already made.
    routing: { byPurpose: { [level.profile]: [level.profile] } },
    bundleRoot: options.bundleRoot,
    locate: (target, candidate) => options.corpus.artifacts.get(target.identity.id)?.[candidate.level],
    cache,
  });
  const request: ProjectionRequest = {
    purpose: level.profile,
    budget: { maxTokens: Number.MAX_SAFE_INTEGER },
    consumer: { transports: [options.transport], maxTokensPerUnit: level.targetTokens },
    policy: { refs: [] },
  };
  const result = engine.project([unit], request, options.scope);
  diagnostics.push(...result.diagnostics);
  const delivered = result.units[0];
  if (delivered === undefined) return undefined;
  return { payload: delivered.payload, level: delivered.level, profile: delivered.profile };
}

function toResult(
  options: ServeOptions,
  unit: UnitIR,
  delivery: Delivery,
  descriptionPrefix: string,
): QueryResult {
  const payload = delivery.payload;
  return {
    id: unit.identity.id,
    kind: unit.typeRef,
    description: descriptionPrefix + describe(options, unit),
    // Accounting comes from the delivered payload, so it is the cost of *this*
    // level rather than the whole-atom figure the index carries.
    tokens: payload.tokens,
    level: delivery.level,
    profile: delivery.profile,
    transport: payload.transport,
    bytes: payload.bytes,
    digest: payload.digest,
    ...(payload.transport === "path" ? { path: payload.path } : {}),
    ...(payload.transport === "inline" ? { content: payload.content } : {}),
  };
}

/**
 * The unit's own summary text. The field key was discovered by the corpus
 * adapter, so no field name is spelled here.
 */
function describe(options: ServeOptions, unit: UnitIR): string {
  const key = options.corpus.descriptionField;
  if (key === undefined) return "";
  const value = unit.fields[key];
  // Trimmed because the two sources disagree about leading whitespace and the
  // response is read by humans; the text itself is never altered.
  return value !== undefined && value.kind === "string" ? value.value.trim() : "";
}

export function executeAoeQuery(args: QueryArguments, options: ServeOptions): ServeOutcome {
  const diagnostics: DiagnosticIR[] = [];
  const profile = profileName(options.model);
  const cache = new ProjectionCache<ProjectionPayload>();

  try {
    if (args.scope === "atoms") {
      return planAtoms(args, options, profile, cache, diagnostics);
    }
    if (args.id === undefined) return { error: REQUIRES_ID(args.scope) };
    // `kind` filters the *neighbours* of the subject, never the subject: passing
    // it into admission would make `related` on a unit of another type report the
    // subject itself as missing.
    const request = baseRequest(options, profile, { ...args, kind: undefined });
    const graph = admittedGraph(options, request);
    const byId = new Map(graph.units.map((unit) => [unit.identity.id, unit]));
    // A unit the principal may not see is indistinguishable from a missing one:
    // `admit` removed it, so the same text is returned for both. Reporting the
    // difference would restore exactly the disclosure the early filter prevents.
    const subject = byId.get(args.id);
    if (subject === undefined) return { error: NOT_FOUND(args.id) };

    if (args.scope === "show") {
      const projectionRef = args.level ?? options.model.profiles[profile]!.projection;
      const delivery = project(options, subject, projectionRef, cache, diagnostics);
      return { results: delivery === undefined ? [] : [toResult(options, subject, delivery, "")], diagnostics };
    }
    return relatedOf(args, options, subject, byId, profile, cache, diagnostics);
  } catch (error) {
    if (error instanceof QueryEngineError) {
      return { error: error.diagnostics.map((d) => `${d.code}: ${d.message}`).join("; ") };
    }
    throw error;
  }
}

/**
 * The single selection-planning call in this package.
 *
 * `aoe_query` and `aoe_plan` both go through here, and that is the point:
 * plan is defined as "what query would select, without rendering it" (§9.1
 * `plan(request) => SelectionPlanIR`). Two independent request builders would let
 * the two tools drift, and a plan that does not describe the query is worse than
 * no plan tool at all.
 */
function runSelectionPlan(
  options: ServeOptions,
  profile: string,
  args: QueryArguments,
): SelectionPlanIR {
  const declared = options.model.profiles[profile]!;
  const primary = args.level ?? declared.projection;
  const request: QueryRequest = {
    ...baseRequest(options, profile, args),
    fallbackProjections: cheaperProjections(primary, options.model.projections),
  };
  return planSelection(request, {
    graph: options.corpus.graph,
    profiles: options.model.profiles,
    relations: options.model.relations,
    projections: options.model.projections,
    tokenCost: (unitId, projectionRef) => options.corpus.tokenCosts.get(unitId)?.[projectionRef],
  }, { generators: buildRegistry(options, profile) });
}

/**
 * `aoe_plan` (§11.1) mapped onto the Engine's plan capability (§9.1
 * `plan(request) => SelectionPlanIR`).
 *
 * This is the AOE plan surface exposed by the MCP transport:
 * §16 Phase 0 asked for a request-time plan tool, the capability it would have
 * named was dropped rather than renamed at the cutover, and an alias to a missing
 * capability would be a compatibility shim. What exists here is the plan itself —
 * `query-engine`'s `planSelection` output returned verbatim, so a caller can see
 * candidates, scores, rejections with reasons, relation expansions, the load
 * order, the budget arithmetic and the level each unit could be afforded at,
 * *without* paying to render any of it.
 *
 * The difference from `aoe_query` is exactly rendering: same profile, same
 * request, same plan. Nothing is re-decided here.
 */
export function executeAoePlan(args: PlanArguments, options: ServeOptions): PlanOutcome {
  const profile = profileName(options.model);
  const hasSeeds = args.seeds !== undefined && args.seeds.length > 0;
  if (args.query === undefined && !hasSeeds) {
    // Refused explicitly rather than answered with an empty plan. With neither
    // text nor seeds no candidate generator can fire, so the result would be an
    // empty selection whose emptiness says nothing about the corpus — and
    // enumerating instead (what `scope=atoms` does) would return a listing
    // dressed up as a plan.
    return { error: "aoe_plan requires `query` or `seeds`: a selection plan with no retrieval signal is not a plan." };
  }
  try {
    return {
      plan: runSelectionPlan(options, profile, {
        scope: "atoms",
        ...(args.query === undefined ? {} : { query: args.query }),
        ...(hasSeeds ? { seeds: args.seeds } : {}),
        ...(args.kind === undefined ? {} : { kind: args.kind }),
        ...(args.level === undefined ? {} : { level: args.level }),
        ...(args.limit === undefined ? {} : { limit: args.limit }),
      }),
    };
  } catch (error) {
    if (error instanceof QueryEngineError) {
      return { error: error.diagnostics.map((d) => `${d.code}: ${d.message}`).join("; ") };
    }
    throw error;
  }
}

function planAtoms(
  args: QueryArguments,
  options: ServeOptions,
  profile: string,
  cache: ProjectionCache<ProjectionPayload>,
  diagnostics: DiagnosticIR[],
): ServeOutcome {
  const declared = options.model.profiles[profile]!;
  const primary = args.level ?? declared.projection;
  const base = baseRequest(options, profile, args);

  // No query text and no seeds is *enumeration*, not retrieval: no generator can
  // produce a candidate, and inventing a constant score for every unit — which is
  // what the pre-cutover implementation did with `0.5` — is a ranking claim the
  // engine cannot justify. So this path lists the admitted graph in index order,
  // still ACL-first and still projected through projection-engine.
  if (args.query === undefined && (args.seeds === undefined || args.seeds.length === 0)) {
    return enumerate(args, options, base, primary, cache, diagnostics);
  }

  const plan = runSelectionPlan(options, profile, args);

  diagnostics.push(...plan.conflicts, ...(plan.rationale ?? []));

  const byId = new Map(options.corpus.graph.units.map((unit) => [unit.identity.id, unit]));
  const results: QueryResult[] = [];
  // `projectionLoads` is the selection→projection handoff (D-2): it already
  // encodes both the load order and the level the budget could afford.
  for (const load of plan.projectionLoads) {
    for (const unitId of load.unitIds) {
      const unit = byId.get(unitId);
      if (unit === undefined) continue;
      const delivery = project(options, unit, load.projectionRef, cache, diagnostics);
      if (delivery !== undefined) results.push(toResult(options, unit, delivery, ""));
    }
  }
  return { results, diagnostics };
}

function enumerate(
  args: QueryArguments,
  options: ServeOptions,
  request: QueryRequest,
  projectionRef: string,
  cache: ProjectionCache<ProjectionPayload>,
  diagnostics: DiagnosticIR[],
): ServeOutcome {
  const admission = admit(options.corpus.graph, request);
  for (const denial of admission.filtered) {
    diagnostics.push({
      code: "ENUMERATION_UNIT_FILTERED",
      message: `${denial.unitId}: ${denial.reasons.join("; ")}`,
      severity: "info",
    });
  }
  const limit = args.limit ?? admission.graph.units.length;
  const results: QueryResult[] = [];
  for (const unit of admission.graph.units) {
    if (results.length >= limit) break;
    const delivery = project(options, unit, projectionRef, cache, diagnostics);
    if (delivery !== undefined) results.push(toResult(options, unit, delivery, ""));
  }
  return { results, diagnostics };
}

function relatedOf(
  args: QueryArguments,
  options: ServeOptions,
  subject: UnitIR,
  byId: ReadonlyMap<string, UnitIR>,
  profile: string,
  cache: ProjectionCache<ProjectionPayload>,
  diagnostics: DiagnosticIR[],
): ServeOutcome {
  const limit = args.limit ?? 10;
  const projectionRef = args.level ?? options.model.profiles[profile]!.projection;
  const seen = new Set<string>([subject.identity.id]);
  const results: QueryResult[] = [];
  // Declaration order, deliberately *not* `expandSelection`: expansion applies
  // relation semantics, and under the v1 model most edges are `informational`,
  // so routing this scope through it would silently drop neighbours this tool has
  // always returned. The edges walked are the admitted ones, so the ACL still
  // holds. See the lane report for the full argument.
  for (const edge of subject.relations) {
    if (seen.has(edge.to)) continue;
    seen.add(edge.to);
    const target = byId.get(edge.to);
    if (target === undefined) continue;
    if (args.kind !== undefined && target.typeRef !== args.kind) continue;
    const delivery = project(options, target, projectionRef, cache, diagnostics);
    if (delivery !== undefined) results.push(toResult(options, target, delivery, `[${edge.relationRef}] `));
    if (results.length >= limit) break;
  }
  return { results, diagnostics };
}

/**
 * Resolve a `aoe://` URI to inline content (§11.3, §9.5).
 *
 * This is what makes the URI transport *usable* rather than nominal: a remote
 * consumer that received a URI has no way to read a server-local path, so the
 * server has to be able to turn the identity back into bytes. Containment is
 * re-checked here because the URI arrives from the client.
 */
export function resolveAoeUri(
  raw: string,
  options: ServeOptions,
): { readonly content: string; readonly unitId: string; readonly level: string } | { readonly error: string } {
  const parsed = parseProjectionUri(raw);
  if (!parsed.ok) return { error: parsed.reason };
  const uri = parsed.value;
  if (uri.tenant !== options.scope.tenant || uri.corpus !== options.scope.corpus) {
    // Cross-tenant and cross-corpus reads are refused without saying which part
    // matched, so the URI cannot be used to probe what this server holds.
    return { error: NOT_FOUND(uri.unitId) };
  }
  const unit = options.corpus.graph.units.find((candidate) => candidate.identity.id === uri.unitId);
  if (unit === undefined) return { error: NOT_FOUND(uri.unitId) };
  const admitted = admit(options.corpus.graph, {
    requestId: "resolve",
    profile: profileName(options.model),
    principal: options.principal,
    maxTokens: options.maxTokens,
  }).graph;
  if (!admitted.units.some((candidate) => candidate.identity.id === uri.unitId)) {
    return { error: NOT_FOUND(uri.unitId) };
  }
  const diagnostics: DiagnosticIR[] = [];
  const delivery = project(
    { ...options, transport: "inline" },
    unit,
    uri.level,
    new ProjectionCache<ProjectionPayload>(),
    diagnostics,
  );
  if (delivery === undefined || delivery.payload.transport !== "inline") {
    return { error: `Projection not available for ${uri.unitId} at ${uri.level}` };
  }
  return { content: delivery.payload.content, unitId: uri.unitId, level: delivery.level };
}

export type { IrSnapshotRef };
