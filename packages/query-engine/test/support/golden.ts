/**
 * @module test/support/golden
 *
 * §16 Phase 3, acceptance criterion 3: "golden query top-k, conflicts and budget
 * have regression tests".
 *
 * A golden query freezes four things a change can silently alter:
 *
 *   topK              the selected units *in rank order*
 *   conflicts         the blocking/warning set, by code and message
 *   budget            maxTokens / consumedTokens / state / shortfall
 *   projectionLoads   which tier each unit was rendered at, in load order
 *
 * Why order and message text and not just a set of ids: a reranking change, a
 * tie-break change, a weight change and a load-order change all keep the *set*
 * identical while changing what a consumer actually receives. The set is the part
 * that never regresses quietly; the order is.
 *
 * `snapshot` is frozen alongside so a golden cannot pass because the corpus moved
 * under it — a plan compared against a different snapshot is not a regression
 * result, it is a different question.
 *
 * Scores are NOT frozen. They are already covered by the byte-determinism tests,
 * and freezing a float here would make every BM25 constant a breaking change
 * while adding nothing about ordering that `topK` does not already say.
 */

import type { DiagnosticIR, SelectionPlanIR } from "@skill-wiki/ir";
import { planSelection, planWithConstraints, type QueryRequest } from "../../src/index.ts";
import { DOMAINS, ordinaryPrincipal, type DomainDescriptor, type LoadedDomain } from "./domains.ts";

export interface GoldenObservation {
  readonly name: string;
  readonly domain: string;
  readonly path: "planSelection" | "planWithConstraints";
  readonly snapshot: {
    readonly modelRelease: string;
    readonly modelDigest: string;
    readonly corpusRelease: string;
    readonly corpusDigest: string;
  };
  readonly request: Readonly<Record<string, unknown>>;
  readonly topK: readonly string[];
  readonly conflicts: readonly { readonly code: string; readonly severity: string; readonly message: string }[];
  readonly budget: {
    readonly maxTokens: number;
    readonly consumedTokens: number | null;
    readonly state: string | null;
    readonly shortfall: number | null;
  };
  readonly projectionLoads: readonly { readonly projectionRef: string; readonly unitIds: readonly string[] }[];
  readonly rejections: readonly { readonly unitId: string; readonly reasons: readonly string[] }[];
}

function diagnostics(list: readonly DiagnosticIR[]): GoldenObservation["conflicts"] {
  return list.map(d => ({ code: d.code, severity: d.severity, message: d.message }));
}

function observePlan(
  name: string,
  domain: string,
  path: GoldenObservation["path"],
  request: QueryRequest,
  plan: SelectionPlanIR,
): GoldenObservation {
  return {
    name,
    domain,
    path,
    snapshot: {
      modelRelease: plan.snapshot.modelRelease,
      modelDigest: plan.snapshot.modelDigest,
      corpusRelease: plan.snapshot.corpusRelease,
      corpusDigest: plan.snapshot.corpusDigest,
    },
    request: {
      profile: request.profile,
      principalId: request.principal.id,
      maxTokens: request.maxTokens,
      text: request.text ?? null,
      seeds: request.seeds ?? null,
      limit: request.limit ?? null,
      fallbackProjections: request.fallbackProjections ?? null,
    },
    topK: plan.selected.map(candidate => candidate.unitId),
    conflicts: diagnostics(plan.conflicts),
    budget: {
      maxTokens: plan.budget.maxTokens,
      consumedTokens: plan.budget.consumedTokens ?? null,
      state: plan.budget.state ?? null,
      shortfall: plan.budget.shortfall ?? null,
    },
    projectionLoads: plan.projectionLoads.map(load => ({
      projectionRef: load.projectionRef,
      unitIds: load.unitIds,
    })),
    rejections: plan.rejections.map(rejection => ({
      unitId: rejection.candidate.unitId,
      reasons: rejection.reasons,
    })),
  };
}

/** One frozen query. `budget` is chosen per case to exercise a distinct state. */
export interface GoldenCase {
  readonly name: string;
  readonly domain: DomainDescriptor;
  readonly path: GoldenObservation["path"];
  readonly build: (domain: DomainDescriptor) => QueryRequest;
  /** Feature-weight override used only by the sensitivity test, never by the golden. */
  readonly perturbAxis: string;
}

function baseRequest(domain: DomainDescriptor, overrides: Partial<QueryRequest>): QueryRequest {
  return {
    requestId: `golden-${domain.fixtureDir}`,
    profile: domain.profileName,
    principal: ordinaryPrincipal,
    maxTokens: 100_000,
    text: domain.text,
    seeds: [domain.seed],
    ...overrides,
  };
}

/**
 * Per-domain budgets. They are literals rather than derived numbers on purpose: a
 * golden whose budget is computed from the corpus moves whenever the corpus moves,
 * which is exactly the silent drift a golden exists to catch.
 */
const TIGHT_BUDGET: Readonly<Record<string, number>> = {
  "security-model": 120,
  "recipe-model": 80,
  "incident-ops-model": 60,
};

/** Budget small enough that even the cheapest tier cannot hold the mandatory set. */
const STARVED_BUDGET: Readonly<Record<string, number>> = {
  "security-model": 30,
  "recipe-model": 20,
  "incident-ops-model": 15,
};

export const GOLDEN_CASES: readonly GoldenCase[] = DOMAINS.flatMap(domain => {
  const axes = domain.fixtureDir === "security-model"
    ? "lexicalScore"
    : domain.fixtureDir === "recipe-model"
      ? "textScore"
      : "keywordScore";
  return [
    {
      name: `${domain.fixtureDir}/roomy-ranked`,
      domain,
      path: "planSelection" as const,
      build: (d: DomainDescriptor) => baseRequest(d, {}),
      perturbAxis: axes,
    },
    {
      name: `${domain.fixtureDir}/tight-budget-drops`,
      domain,
      path: "planSelection" as const,
      build: (d: DomainDescriptor) => baseRequest(d, { maxTokens: TIGHT_BUDGET[d.fixtureDir]! }),
      perturbAxis: axes,
    },
    {
      name: `${domain.fixtureDir}/solved-starved-budget`,
      domain,
      path: "planWithConstraints" as const,
      build: (d: DomainDescriptor) => baseRequest(d, { maxTokens: STARVED_BUDGET[d.fixtureDir]! }),
      perturbAxis: axes,
    },
  ];
});

/** Run one golden case against a loaded domain and reduce it to its observation. */
export function runGolden(testCase: GoldenCase, model: LoadedDomain): GoldenObservation {
  const request = testCase.build(testCase.domain);
  const generators = testCase.domain.registry();
  if (testCase.path === "planSelection") {
    return observePlan(
      testCase.name,
      testCase.domain.fixtureDir,
      testCase.path,
      request,
      planSelection(request, model.context, { generators }),
    );
  }
  const result = planWithConstraints(request, model.context, {
    generators,
    mandatory: [testCase.domain.seed],
  });
  if (!result.ok) {
    throw new Error(
      `golden case '${testCase.name}' expected a satisfiable plan, got ${result.reason}: ` +
        JSON.stringify(result.diagnostics),
    );
  }
  return observePlan(testCase.name, testCase.domain.fixtureDir, testCase.path, request, result.plan);
}

/** Canonical JSON so a golden file diff is a semantic diff, not a key-order diff. */
export function canonical(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
