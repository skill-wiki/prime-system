/**
 * @module engine
 *
 * The orchestration that turns a request into a `SelectionPlanIR`.
 *
 * The pipeline order is itself a contract, not an implementation detail:
 *
 *   admission (ACL) -> generation -> scoring -> rank cutoff -> relation expansion
 *   -> exclusion -> load order -> budget -> plan
 *
 * Admission is first so no later stage can observe a unit the principal may not
 * see. Expansion is after the rank cutoff so a closure is pulled for units that
 * actually made the cut, not for every unit that scored above zero. Exclusion is
 * after expansion so a prohibition still applies to a unit a closure dragged in.
 * Budget is last because it is the only stage allowed to drop a unit for a reason
 * unrelated to relevance, and that reason has to be reported as arithmetic.
 */

import type {
  DiagnosticIR,
  SelectionCandidateIR,
  SelectionPlanIR,
  ValueIR,
} from "@skill-wiki/ir";
import type { RetrievalProfile } from "@skill-wiki/model-schema";
import { buildAdjacency, type Adjacency } from "./adjacency.ts";
import { admit, type AdmissionResult } from "./admission.ts";
import { planBudget, resolveProjectionChain } from "./budget.ts";
import {
  canonicalStrings,
  compareByScoreThenId,
  compareStrings,
  orderedRecord,
} from "./deterministic.ts";
import { expandSelection, findExclusions } from "./expansion.ts";
import type { CandidateGeneratorRegistry } from "./generators/registry.ts";
import { orderByLoadOrder } from "./loadorder.ts";
import { scoreCandidates, type GeneratorOutput } from "./scoring.ts";
import { fail, type FacetSelector, type QueryEngineContext, type QueryRequest } from "./types.ts";

export interface PlanSelectionOptions {
  readonly generators: CandidateGeneratorRegistry;
  /** Hop ceiling for `transitive` relations during expansion. */
  readonly maxExpansionDepth?: number;
}

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
  /** Scored candidates, descending score then unit id. */
  readonly candidates: readonly SelectionCandidateIR[];
  readonly rationale: readonly DiagnosticIR[];
}

export function runRetrieval(
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

  return { profile, chain, admission, adjacency, candidates: scoring.candidates, rationale };
}

export function planSelection(
  request: QueryRequest,
  ctx: QueryEngineContext,
  options: PlanSelectionOptions,
): SelectionPlanIR {
  const retrieval = runRetrieval(request, ctx, options);
  const { profile, chain, admission, adjacency } = retrieval;
  const rationale: DiagnosticIR[] = [...retrieval.rationale];
  const conflicts: DiagnosticIR[] = [];
  const rejections: Rejection[] = admission.filtered.map(denial => ({
    candidate: placeholderCandidate(denial.unitId, "filtered before candidate generation"),
    reasons: denial.reasons,
  }));
  const scoring = { candidates: retrieval.candidates };
  const scored = new Map(scoring.candidates.map(candidate => [candidate.unitId, candidate]));

  // 4. Rank cutoff.
  const limit = request.limit ?? scoring.candidates.length;
  const ranked = scoring.candidates.slice(0, limit);
  const cutoff = new Map(
    scoring.candidates.slice(limit).map((candidate, index) => [
      candidate.unitId,
      `below rank cutoff: rank ${limit + index + 1} of ${scoring.candidates.length}, limit ${limit}`,
    ]),
  );

  // 5. Relation expansion from the units that made the cut.
  const expansion = expandSelection(
    ranked.map(candidate => candidate.unitId),
    adjacency,
    ctx.relations,
    options.maxExpansionDepth ?? 8,
  );
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

  // 6. Exclusion, applied to the post-expansion set.
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

  const survivors = working.filter(candidate => !dropped.has(candidate.unitId)).sort(compareByScoreThenId);

  // 7. Load order, then 8. budget.
  const loadOrder = orderByLoadOrder(
    survivors.map(candidate => candidate.unitId),
    expansion.orderConstraints,
  );
  rationale.push(...loadOrder.diagnostics);

  const budget = planBudget(loadOrder.ordered, chain, request.maxTokens, ctx.projections, ctx.tokenCost);
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
