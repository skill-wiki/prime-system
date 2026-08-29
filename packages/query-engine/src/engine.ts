/**
 * @module engine
 *
 * The orchestration that turns a request into a `SelectionPlanIR`.
 *
 * The pipeline order is itself a contract, not an implementation detail:
 *
 *   admission (ACL) -> generation -> scoring -> reranking -> rank cutoff
 *   -> relation expansion -> exclusion -> load order -> budget -> plan
 *
 * Admission is first so no later stage can observe a unit the principal may not
 * see. Reranking is after scoring and *before* the rank cutoff, because a
 * reranker that could only reorder what already survived `limit` would have no
 * say in which candidates the caller receives. Expansion is after the rank cutoff
 * so a closure is pulled for units that actually made the cut, not for every unit
 * that scored above zero. Exclusion is after expansion so a prohibition still
 * applies to a unit a closure dragged in. Budget is last because it is the only
 * stage allowed to drop a unit for a reason unrelated to relevance, and that
 * reason has to be reported as arithmetic.
 */

import type {
  DiagnosticIR,
  SelectionCandidateIR,
  SelectionPlanIR,
  ValueIR,
} from "@skill-wiki/ir";
import type { RetrievalProfile } from "@skill-wiki/model-schema";
import { NOOP_TRACER, withSpan, type SpanContext, type Tracer } from "@skill-wiki/observability";
import { buildAdjacency, type Adjacency } from "./adjacency.ts";
import { admit, type AdmissionResult } from "./admission.ts";
import { planBudget, resolveProjectionChain } from "./budget.ts";
import { detectCapabilityGaps } from "./capabilities.ts";
import {
  canonicalStrings,
  compareByScoreThenId,
  compareStrings,
  orderedRecord,
} from "./deterministic.ts";
import { expandSelection, findExclusions } from "./expansion.ts";
import type { CandidateGeneratorRegistry } from "./generators/registry.ts";
import { orderByLoadOrder } from "./loadorder.ts";
import { applyReranker, builtinRerankers, type RerankerRegistry } from "./reranker.ts";
import { scoreCandidates, type GeneratorOutput } from "./scoring.ts";
import { fail, type FacetSelector, type QueryEngineContext, type QueryRequest } from "./types.ts";

export interface PlanSelectionOptions {
  readonly generators: CandidateGeneratorRegistry;
  /**
   * Rerankers available to resolve `RetrievalProfile.reranker`. Defaults to
   * `builtinRerankers()`. A host adding its own starts from that call rather than
   * from an empty registry, so passing this never silently withdraws
   * `stable-linear-v1` — and a profile naming a reranker the supplied registry
   * lacks is reported, never silently skipped.
   */
  readonly rerankers?: RerankerRegistry;
  /** Hop ceiling for `transitive` relations during expansion. */
  readonly maxExpansionDepth?: number;
  /**
   * Where selection-pipeline spans go. Defaults to `NOOP_TRACER`, so an
   * unconfigured deployment pays nothing and emits nothing.
   *
   * The engine names its own phases and reports its own arithmetic as span
   * attributes, and decides nothing else about telemetry: it does not know whether
   * spans are collected, batched or exported. That is why the parameter is a
   * `Tracer` rather than an exporter or a boolean flag — a flag would put the
   * "is telemetry on" decision inside the engine, where a caller cannot see it.
   */
  readonly tracer?: Tracer;
  /**
   * Parent for the spans this call emits. Explicit rather than read from an
   * ambient "current span", because an ambient context silently detaches across
   * every async boundary and this pipeline is called from four entry points
   * (embedded transport, solver bridge, MCP server, HTTP server) that each have a
   * different notion of what the enclosing operation is.
   */
  readonly traceParent?: SpanContext;
}

/**
 * Span names for the selection pipeline.
 *
 * Frozen as constants in the package that *emits* them, not in the tracing
 * package and not in each consumer: a dashboard query and an assertion in a test
 * must be naming the same string, and the only way to guarantee that is for there
 * to be one definition and for it to live where the span is created. They are
 * pipeline phase names — mechanism, not model vocabulary — so they belong to the
 * engine exactly as `RERANKER_APPLIED` does.
 */
export const SPAN_PLAN = "prime.query.plan";
export const SPAN_RETRIEVAL = "prime.query.retrieval";
export const SPAN_EXPANSION = "prime.query.expansion";
export const SPAN_BUDGET = "prime.query.budget";

interface Rejection {
  readonly candidate: SelectionCandidateIR;
  readonly reasons: readonly string[];
}

function facetToValue(facet: FacetSelector): ValueIR {
  return facet.kind === "field"
    ? { kind: facet.kind, path: [...facet.path], anyOf: [...facet.anyOf] }
    : { kind: facet.kind, anyOf: [...facet.anyOf] };
}

/**
 * A normalised echo of the request. It is part of the plan so that a stored plan
 * can be re-derived and diffed without the original call site.
 */
function queryEcho(request: QueryRequest): Readonly<Record<string, ValueIR>> {
  const entries: (readonly [string, ValueIR])[] = [
    ["profile", request.profile],
    ["maxTokens", request.maxTokens],
    [
      "principal",
      {
        id: request.principal.id,
        allowedVisibility: [...request.principal.allowedVisibility].sort(compareStrings),
        grantedPolicyLabels: [...request.principal.grantedPolicyLabels].sort(compareStrings),
      },
    ],
  ];
  if (request.text !== undefined) entries.push(["text", request.text]);
  if (request.seeds !== undefined) entries.push(["seeds", [...request.seeds].sort(compareStrings)]);
  if (request.facets !== undefined) entries.push(["facets", request.facets.map(facetToValue)]);
  if (request.requiredFacets !== undefined) {
    entries.push(["requiredFacets", request.requiredFacets.map(facetToValue)]);
  }
  if (request.lifecycles !== undefined) entries.push(["lifecycles", [...request.lifecycles]]);
  if (request.limit !== undefined) entries.push(["limit", request.limit]);
  if (request.fallbackProjections !== undefined) {
    entries.push(["fallbackProjections", [...request.fallbackProjections]]);
  }
  return orderedRecord(entries);
}

function placeholderCandidate(unitId: string, reason: string): SelectionCandidateIR {
  return { unitId, score: 0, featureValues: orderedRecord([]), reasons: [reason] };
}

/**
 * Steps 1-3 of the pipeline: admission, generation, scoring. Exported because the
 * constraint-solver integration needs exactly this much and nothing more — it
 * replaces steps 4-8 with the solver's own membership decision, and re-running
 * admission separately would risk the two paths disagreeing about what the
 * principal may see.
 */
export interface RetrievalResult {
  readonly profile: RetrievalProfile;
  readonly chain: readonly string[];
  readonly admission: AdmissionResult;
  readonly adjacency: Adjacency;
  /** Scored candidates in final ranked order: reranked when a reranker ran. */
  readonly candidates: readonly SelectionCandidateIR[];
  /**
   * Name of the reranker that ran, or `undefined` when the profile declared none
   * or declared one this engine does not implement. Exposed so a caller can tell
   * "no reranker was asked for" from "one was asked for and honoured" without
   * re-resolving the profile — and, with `capabilityGaps`, from "asked for and
   * absent".
   */
  readonly reranker: string | undefined;
  readonly rationale: readonly DiagnosticIR[];
  /**
   * Stages `profile` declares that this engine cannot run. Kept out of
   * `rationale` so the two plan-building entry points can route it into the
   * plan's required `conflicts` slot exactly once, rather than each having to
   * fish it back out of a merged diagnostic list.
   */
  readonly capabilityGaps: readonly DiagnosticIR[];
}

export function runRetrieval(
  request: QueryRequest,
  ctx: QueryEngineContext,
  options: PlanSelectionOptions,
): RetrievalResult {
  return withSpan(
    options.tracer ?? NOOP_TRACER,
    SPAN_RETRIEVAL,
    {
      ...(options.traceParent === undefined ? {} : { parent: options.traceParent }),
      attributes: { "prime.request_id": request.requestId, "prime.profile_ref": request.profile },
    },
    span => {
      const result = retrieve(request, ctx, options);
      // Reported as attributes on the phase that produced them rather than
      // recomputed by a consumer: `admitted - candidates` is the admission and
      // generation funnel, and a dashboard that has to derive it from a plan
      // payload is a second implementation of the engine's own arithmetic.
      span.setAttributes({
        "prime.admitted_units": result.admission.graph.units.length,
        "prime.acl_denied_units": result.admission.aclDeniedCount,
        "prime.request_filtered_units": result.admission.filtered.length,
        "prime.candidates": result.candidates.length,
        "prime.generators": result.profile.candidateGenerators.map(entry => entry.name),
        "prime.reranker": result.reranker ?? "",
        "prime.capability_gaps": result.capabilityGaps.length,
      });
      return result;
    },
  );
}

function retrieve(
  request: QueryRequest,
  ctx: QueryEngineContext,
  options: PlanSelectionOptions,
): RetrievalResult {
  if (request.requestId.length === 0) fail("REQUEST_ID_EMPTY", "requestId must be non-empty", ["requestId"]);
  const profile = ctx.profiles[request.profile];
  if (profile === undefined) {
    fail(
      "PROFILE_NOT_DECLARED",
      `Unknown retrieval profile '${request.profile}'; declared: [${Object.keys(ctx.profiles).sort(compareStrings).join(", ")}]`,
      ["profile"],
    );
  }
  if (Object.keys(profile.features).length === 0) {
    fail(
      "PROFILE_NO_FEATURES",
      `Retrieval profile '${profile.name}' declares no feature weights, so no candidate could ever score`,
      ["profile"],
    );
  }
  if (!Number.isInteger(request.maxTokens) || request.maxTokens <= 0) {
    fail("BUDGET_INVALID", `maxTokens must be a positive integer, received ${request.maxTokens}`, ["maxTokens"]);
  }

  const chain = resolveProjectionChain(profile.projection, request.fallbackProjections, ctx.projections);
  const rationale: DiagnosticIR[] = [];
  const rerankers = options.rerankers ?? builtinRerankers();

  // Detected here, at the one place the profile is resolved and validated, so a
  // declared-but-absent stage cannot be reported by one entry point and dropped
  // by the other.
  const capabilityGaps = detectCapabilityGaps(profile, rerankers);

  // 1. Admission. Runs before generation so denied units never enter corpus
  //    statistics, graph paths or reasons.
  const admission = admit(ctx.graph, request);
  if (admission.aclDeniedCount > 0) {
    rationale.push({
      code: "ADMISSION_ACL_FILTERED",
      message: `${admission.aclDeniedCount} unit(s) were withheld from principal '${request.principal.id}' before candidate generation; identifiers are intentionally not reported`,
      severity: "info",
    });
  }
  if (admission.filtered.length > 0) {
    rationale.push({
      code: "ADMISSION_REQUEST_FILTERED",
      message: `${admission.filtered.length} unit(s) were excluded by a request-side filter before candidate generation`,
      severity: "info",
    });
  }

  // 2. Generation.
  const adjacency = buildAdjacency(admission.graph);
  const generatorDiagnostics: DiagnosticIR[] = [];
  const generatorContext = {
    profile,
    relations: ctx.relations,
    unitsById: adjacency.unitsById,
    outgoing: adjacency.outgoing,
    incoming: adjacency.incoming,
    report: (diagnostic: DiagnosticIR): void => {
      generatorDiagnostics.push(diagnostic);
    },
  };
  const generators = options.generators.resolve(profile.candidateGenerators.map(entry => entry.name));
  const outputs: GeneratorOutput[] = generators.map((generator, index) => ({
    generator,
    weight: profile.candidateGenerators[index]!.weight,
    candidates: generator.generate(request, admission.graph, generatorContext),
  }));
  rationale.push(...generatorDiagnostics);

  // 3. Scoring.
  const scoring = scoreCandidates(outputs, profile);
  rationale.push(...scoring.diagnostics);

  // 4. Reranking. Both plan entry points read `candidates` from here, so the stage
  //    runs exactly once and neither path can end up with the other's order.
  const reranked = applyReranker(scoring.candidates, profile, rerankers, d => rationale.push(d));

  return {
    profile,
    chain,
    admission,
    adjacency,
    candidates: reranked.candidates,
    reranker: reranked.applied,
    rationale,
    capabilityGaps,
  };
}

export function planSelection(
  request: QueryRequest,
  ctx: QueryEngineContext,
  options: PlanSelectionOptions,
): SelectionPlanIR {
  const tracer = options.tracer ?? NOOP_TRACER;
  return withSpan(
    tracer,
    SPAN_PLAN,
    {
      ...(options.traceParent === undefined ? {} : { parent: options.traceParent }),
      attributes: { "prime.request_id": request.requestId, "prime.profile_ref": request.profile, "prime.max_tokens": request.maxTokens },
    },
    span => {
      // Every phase below re-parents onto this span. Rebuilding `options` is how
      // the parent is passed, rather than a mutable field on the tracer: two
      // concurrent `planSelection` calls sharing one tracer must not be able to
      // adopt each other's children.
      const plan = buildPlan(request, ctx, { ...options, tracer, traceParent: span.context });
      span.setAttributes({
        "prime.selected_units": plan.selected.length,
        "prime.rejected_units": plan.rejections.length,
        "prime.conflicts": plan.conflicts.length,
        "prime.consumed_tokens": plan.budget.consumedTokens ?? 0,
        "prime.corpus_release": plan.snapshot.corpusRelease,
        "prime.corpus_digest": plan.snapshot.corpusDigest,
      });
      // `ok` rather than left `unset`: the engine reached the end of the pipeline
      // and is making that claim. A conflict is a recorded outcome, not a failed
      // call, so it does not become an error status — a backend's error rate must
      // count broken requests, not requests whose answer was "these units clash".
      span.setStatus({ code: "ok" });
      return plan;
    },
  );
}

function buildPlan(
  request: QueryRequest,
  ctx: QueryEngineContext,
  options: PlanSelectionOptions,
): SelectionPlanIR {
  const retrieval = runRetrieval(request, ctx, options);
  const { profile, chain, admission, adjacency } = retrieval;
  const rationale: DiagnosticIR[] = [...retrieval.rationale];
  // Routed into `conflicts`, not `rationale`, on D-2's precedent and for one
  // additional reason specific to this field pair: `SelectionPlanIR.conflicts` is
  // required while `rationale` is optional (`ir/src/index.ts:118`), so a transport
  // that omits the optional field would drop the marker and put the silence back.
  const conflicts: DiagnosticIR[] = [...retrieval.capabilityGaps];
  const rejections: Rejection[] = admission.filtered.map(denial => ({
    candidate: placeholderCandidate(denial.unitId, "filtered before candidate generation"),
    reasons: denial.reasons,
  }));
  const scoring = { candidates: retrieval.candidates };
  const scored = new Map(scoring.candidates.map(candidate => [candidate.unitId, candidate]));

  // 5. Rank cutoff, applied to the reranked order.
  const limit = request.limit ?? scoring.candidates.length;
  const ranked = scoring.candidates.slice(0, limit);
  const cutoff = new Map(
    scoring.candidates.slice(limit).map((candidate, index) => [
      candidate.unitId,
      `below rank cutoff: rank ${limit + index + 1} of ${scoring.candidates.length}, limit ${limit}`,
    ]),
  );

  // 6. Relation expansion from the units that made the cut.
  const tracer = options.tracer ?? NOOP_TRACER;
  const spanOptions = options.traceParent === undefined ? {} : { parent: options.traceParent };
  const expansion = withSpan(tracer, SPAN_EXPANSION, spanOptions, span => {
    const result = expandSelection(
      ranked.map(candidate => candidate.unitId),
      adjacency,
      ctx.relations,
      options.maxExpansionDepth ?? 8,
    );
    span.setAttributes({
      "prime.seed_units": ranked.length,
      "prime.discovered_units": result.discovered.length,
      "prime.expansions": result.expansions.length,
      "prime.max_expansion_depth": options.maxExpansionDepth ?? 8,
    });
    return result;
  });
  rationale.push(...expansion.diagnostics.filter(d => d.code !== "RELATION_CYCLE_REJECTED"));
  conflicts.push(...expansion.diagnostics.filter(d => d.code === "RELATION_CYCLE_REJECTED"));

  const pulledReasons = new Map<string, string[]>();
  for (const expanded of expansion.expansions) {
    for (const unitId of expanded.discovered) {
      if (!expansion.discovered.includes(unitId)) continue;
      const reasons = pulledReasons.get(unitId) ?? [];
      reasons.push(`pulled in by relation '${expanded.relationRef}' from '${expanded.from}'`);
      pulledReasons.set(unitId, reasons);
    }
  }

  const working: SelectionCandidateIR[] = [...ranked];
  for (const unitId of expansion.discovered) {
    const reasons = canonicalStrings(pulledReasons.get(unitId) ?? []);
    const existing = scored.get(unitId);
    // A unit can be both below the cutoff and required by a relation. Keeping its
    // measured features rather than a placeholder preserves explainability.
    working.push(
      existing === undefined
        ? { unitId, score: 0, featureValues: orderedRecord([]), reasons }
        : { ...existing, reasons: canonicalStrings([...existing.reasons, ...reasons]) },
    );
    cutoff.delete(unitId);
  }
  for (const [unitId, reason] of [...cutoff.entries()].sort((a, b) => compareStrings(a[0], b[0]))) {
    rejections.push({ candidate: scored.get(unitId)!, reasons: [reason] });
  }

  // 7. Exclusion, applied to the post-expansion set.
  const exclusions = findExclusions(
    working.map(candidate => candidate.unitId),
    adjacency,
    ctx.relations,
  );
  const byId = new Map(working.map(candidate => [candidate.unitId, candidate]));
  const dropped = new Map<string, string[]>();
  for (const pair of exclusions) {
    if (pair.severity === "none") continue;
    const message = `relation '${pair.relationRef}' declares mutual exclusion between '${pair.a}' and '${pair.b}'`;
    if (pair.severity === "warning") {
      conflicts.push({ code: "RELATION_EXCLUSION", message, severity: "warning" });
      continue;
    }
    conflicts.push({ code: "RELATION_EXCLUSION", message, severity: "error" });
    const a = byId.get(pair.a);
    const b = byId.get(pair.b);
    if (a === undefined || b === undefined) continue;
    // Drop the weaker side; ties break on id so the outcome is reproducible.
    const loser = compareByScoreThenId(a, b) <= 0 ? b : a;
    const winner = loser.unitId === a.unitId ? b : a;
    const reasons = dropped.get(loser.unitId) ?? [];
    reasons.push(
      `excluded by relation '${pair.relationRef}': conflicts with higher-ranked '${winner.unitId}' (score ${winner.score} vs ${loser.score})`,
    );
    dropped.set(loser.unitId, reasons);
  }
  for (const [unitId, reasons] of [...dropped.entries()].sort((a, b) => compareStrings(a[0], b[0]))) {
    rejections.push({ candidate: byId.get(unitId)!, reasons });
  }

  // Ordered by *rank*, not by score. For the unreranked path and for
  // `stable-linear-v1` the two coincide, because `retrieval.candidates` is itself
  // score-then-id ordered. They stop coinciding the moment a reranker with
  // different semantics runs, and then rank is the answer the caller asked for:
  // re-sorting by score here would let the reranker decide cutoff membership and
  // then throw away its ordering, which is a half-implemented stage.
  //
  // A unit absent from the ranked list is one no generator scored — it is present
  // only because a relation demanded it. Those sort after everything carrying
  // measured relevance, and among themselves by score then id. The load-order
  // stage then moves any of them the model's `loadOrder` constraints require.
  const rankOf = new Map(retrieval.candidates.map((candidate, index) => [candidate.unitId, index]));
  const survivors = working
    .filter(candidate => !dropped.has(candidate.unitId))
    .sort((a, b) => {
      const rankA = rankOf.get(a.unitId);
      const rankB = rankOf.get(b.unitId);
      if (rankA !== undefined && rankB !== undefined) return rankA - rankB;
      if (rankA !== undefined) return -1;
      if (rankB !== undefined) return 1;
      return compareByScoreThenId(a, b);
    });

  // 8. Load order, then 9. budget.
  const loadOrder = orderByLoadOrder(
    survivors.map(candidate => candidate.unitId),
    expansion.orderConstraints,
  );
  rationale.push(...loadOrder.diagnostics);

  const budget = withSpan(tracer, SPAN_BUDGET, spanOptions, span => {
    const result = planBudget(loadOrder.ordered, chain, request.maxTokens, ctx.projections, ctx.tokenCost);
    // The budget stage is the only one allowed to drop a unit for a reason
    // unrelated to relevance, so its arithmetic is the one a caller most often
    // needs after the fact: how much of the ceiling was used, and how many units
    // the ceiling cost them.
    span.setAttributes({
      "prime.max_tokens": request.maxTokens,
      "prime.consumed_tokens": result.consumedTokens,
      "prime.offered_units": loadOrder.ordered.length,
      "prime.assigned_units": result.assignments.length,
      "prime.budget_rejected_units": result.rejections.length,
      "prime.projection_chain": [...chain],
    });
    return result;
  });
  const survivorsById = new Map(survivors.map(candidate => [candidate.unitId, candidate]));
  for (const rejection of budget.rejections) {
    rejections.push({ candidate: survivorsById.get(rejection.unitId)!, reasons: rejection.reasons });
  }

  const selected = budget.assignments.map(assignment => survivorsById.get(assignment.unitId)!);

  const loads: { readonly projectionRef: string; readonly unitIds: readonly string[] }[] = [];
  for (const assignment of budget.assignments) {
    const last = loads[loads.length - 1];
    if (last !== undefined && last.projectionRef === assignment.projectionRef) {
      loads[loads.length - 1] = {
        projectionRef: last.projectionRef,
        unitIds: [...last.unitIds, assignment.unitId],
      };
    } else {
      loads.push({ projectionRef: assignment.projectionRef, unitIds: [assignment.unitId] });
    }
  }

  // `candidates` is every unit the engine actually considered: those that scored,
  // those a relation pulled in, and those a request-side filter removed. Units the
  // principal is not cleared for are absent by construction.
  const candidates = [
    ...working,
    ...admission.filtered.map(denial =>
      placeholderCandidate(denial.unitId, "filtered before candidate generation"),
    ),
    ...[...cutoff.keys()].map(unitId => scored.get(unitId)!),
  ].sort(compareByScoreThenId);

  return {
    requestId: request.requestId,
    snapshot: ctx.graph.snapshot,
    query: queryEcho(request),
    candidates,
    selected,
    rejections: rejections.sort((a, b) => compareStrings(a.candidate.unitId, b.candidate.unitId)),
    relationExpansions: expansion.expansions,
    conflicts,
    budget: { maxTokens: request.maxTokens, consumedTokens: budget.consumedTokens },
    projectionLoads: loads,
    rationale,
  };
}
