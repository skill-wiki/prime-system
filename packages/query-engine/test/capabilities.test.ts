/**
 * @module test/capabilities
 *
 * A profile may declare a pipeline stage this engine does not implement. These
 * cases pin the *reporting* contract: the point of the original lane was to turn a
 * silent gap into an explicit one, and a test suite that let the diagnostic be
 * dropped from a serialised plan would put the silence straight back.
 *
 * Reranking is now implemented (`reranker.ts`), which narrows what this file is
 * about rather than retiring it. `RERANKER_NOT_IMPLEMENTED` still has a real
 * subject — a profile naming a reranker *this* engine does not hold — and that
 * case is the one every assertion below now uses. `weighted-blend-v2` is not a
 * hypothetical name invented for the test: it is what `incident-ops-model`'s own
 * profile declares, so the case being pinned is one the fixture corpus really
 * produces.
 *
 * The complementary half — a declared reranker that *is* implemented actually
 * running, and the ranking consequences of that — lives in `reranker.test.ts`.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import type { RetrievalProfile } from "@skill-wiki/model-schema";
import {
  RERANKER_APPLIED,
  RERANKER_NOT_IMPLEMENTED,
  RerankerRegistry,
  builtinRerankers,
  detectCapabilityGaps,
  planSelection,
  planWithConstraints,
  runRetrieval,
  type QueryRequest,
} from "../src/index.ts";
import { anyPrincipal, contextFor, corpusA, registryFor } from "./support/harness.ts";
import { domainA } from "./support/model.ts";
import { loadSecurityModel, securityRegistry, type SecurityModel } from "./support/security-model.ts";

const generators = registryFor(domainA);
const rerankers = builtinRerankers();

/** `domainA.profile` declares no reranker; this one declares an unimplemented one. */
const withUnknownReranker: RetrievalProfile = { ...domainA.profile, reranker: "weighted-blend-v2" };

/** …and this one declares the reranker the engine does implement. */
const withKnownReranker: RetrievalProfile = { ...domainA.profile, reranker: "stable-linear-v1" };

function request(overrides: Partial<QueryRequest>): QueryRequest {
  return {
    requestId: "req-1",
    profile: domainA.profile.name,
    principal: anyPrincipal,
    maxTokens: 1000,
    ...overrides,
  };
}

const query = { text: "login submit", seeds: ["I1"] } as const;

function planFor(profile: RetrievalProfile) {
  const base = contextFor(domainA, corpusA());
  return planSelection(request({ ...query }), { ...base, profiles: { [profile.name]: profile } }, { generators });
}

describe("detectCapabilityGaps", () => {
  test("a declared-but-unregistered reranker yields one warning naming both", () => {
    const gaps = detectCapabilityGaps(withUnknownReranker, rerankers);

    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.code).toBe(RERANKER_NOT_IMPLEMENTED);
    expect(gaps[0]!.severity).toBe("warning");
    expect(gaps[0]!.path).toEqual(["profile", "reranker"]);
    // The message has to identify *which* declaration is unhonoured, or a caller
    // holding several profiles cannot act on it.
    expect(gaps[0]!.message).toContain(domainA.profile.name);
    expect(gaps[0]!.message).toContain("weighted-blend-v2");
    // …and what is available, because the commonest cause is a typo or a host that
    // registered nothing, and neither is actionable without the registered set.
    expect(gaps[0]!.message).toContain("stable-linear-v1");
  });

  test("a declared reranker this engine implements is not a gap", () => {
    // The whole substance of the change: the diagnostic used to fire on *any*
    // declaration, which made an implemented stage indistinguishable from an
    // absent one.
    expect(detectCapabilityGaps(withKnownReranker, rerankers)).toEqual([]);
  });

  test("a profile declaring no reranker yields nothing — absence is not a gap", () => {
    expect(detectCapabilityGaps(domainA.profile, rerankers)).toEqual([]);
  });

  test("the gap is measured against the registry it is handed, not a global", () => {
    // A host may supply its own registry. If it withholds `stable-linear-v1`, a
    // profile declaring it is genuinely unhonoured and must be reported — silence
    // here would be the original bug with a different cause.
    const empty = new RerankerRegistry();
    const gaps = detectCapabilityGaps(withKnownReranker, empty);
    expect(gaps.map(d => d.code)).toEqual([RERANKER_NOT_IMPLEMENTED]);
  });

  test("severity is warning, not error: the plan is still deliverable", () => {
    // Guards against a later well-meaning upgrade to `error`, which would claim the
    // selected set or the budget is invalid. Neither is affected by the gap.
    expect(detectCapabilityGaps(withUnknownReranker, rerankers).every(d => d.severity !== "error")).toBe(true);
  });
});

describe("planSelection routes the gap into the plan", () => {
  test("the diagnostic lands in `conflicts`, the plan's required slot", () => {
    const plan = planFor(withUnknownReranker);

    expect(plan.conflicts.map(d => d.code)).toContain(RERANKER_NOT_IMPLEMENTED);
  });

  test("it survives serialisation, which `rationale` alone could not guarantee", () => {
    // `SelectionPlanIR.rationale` is optional and `conflicts` is required, so this
    // is the whole reason for the channel choice rather than a stylistic one.
    const roundTripped = JSON.parse(JSON.stringify(planFor(withUnknownReranker))) as {
      conflicts: { code: string }[];
    };

    expect(roundTripped.conflicts.map(d => d.code)).toContain(RERANKER_NOT_IMPLEMENTED);
  });

  test("no reranker declared means the code appears nowhere in the plan", () => {
    expect(JSON.stringify(planFor(domainA.profile))).not.toContain(RERANKER_NOT_IMPLEMENTED);
  });

  test("an implemented reranker means the code appears nowhere either", () => {
    const serialised = JSON.stringify(planFor(withKnownReranker));
    expect(serialised).not.toContain(RERANKER_NOT_IMPLEMENTED);
    // And the plan says positively that the stage ran, so "no gap reported" is not
    // the only evidence a consumer has.
    expect(serialised).toContain(RERANKER_APPLIED);
  });

  test("reporting the gap changes no selection outcome — it is explicit, not corrective", () => {
    const silent = planFor(domainA.profile);
    const explicit = planFor(withUnknownReranker);

    expect(explicit.selected).toEqual(silent.selected);
    expect(explicit.rejections).toEqual(silent.rejections);
    expect(explicit.projectionLoads).toEqual(silent.projectionLoads);
    expect(explicit.budget).toEqual(silent.budget);
    // Exactly one conflict is added, and it is the gap.
    expect(explicit.conflicts.length).toBe(silent.conflicts.length + 1);
    expect(explicit.conflicts.filter(d => d.code === RERANKER_NOT_IMPLEMENTED)).toHaveLength(1);
  });

  test("the gap is reported once, not once per candidate", () => {
    const plan = planFor(withUnknownReranker);

    expect(plan.conflicts.filter(d => d.code === RERANKER_NOT_IMPLEMENTED)).toHaveLength(1);
  });

  test("`runRetrieval` reports which reranker ran, and reports none when the gap fires", () => {
    // Distinguishing "asked for nothing", "asked for and honoured" and "asked for
    // and absent" is three states, and a caller must not have to re-resolve the
    // profile to tell them apart.
    const base = contextFor(domainA, corpusA());
    const of = (profile: RetrievalProfile) =>
      runRetrieval(request({ ...query }), { ...base, profiles: { [profile.name]: profile } }, { generators });

    expect(of(domainA.profile).reranker).toBeUndefined();
    expect(of(withKnownReranker).reranker).toBe("stable-linear-v1");
    expect(of(withUnknownReranker).reranker).toBeUndefined();
    expect(of(withUnknownReranker).capabilityGaps.map(d => d.code)).toEqual([RERANKER_NOT_IMPLEMENTED]);
  });
});

describe("the real security-model fixture declares an implemented reranker", () => {
  let model: SecurityModel;
  const securityGenerators = securityRegistry();

  beforeAll(() => {
    model = loadSecurityModel();
  });

  function auditRequest(overrides: Partial<QueryRequest> = {}): QueryRequest {
    return {
      requestId: "audit-1",
      profile: "audit-default",
      principal: { id: "auditor", allowedVisibility: ["public", "shared"], grantedPolicyLabels: [] },
      maxTokens: 1000,
      ...overrides,
    };
  }

  test("`audit-default` really declares `stable-linear-v1`, through the real loader", () => {
    // Pins the premise of the whole case on the fixture rather than on a literal:
    // if the fixture stops declaring a reranker, the cases below must be revisited.
    expect(model.profiles["audit-default"]!.reranker).toBe("stable-linear-v1");
    expect(builtinRerankers().has("stable-linear-v1")).toBe(true);
  });

  test("planSelection over the real model runs it and reports no gap", () => {
    const plan = planSelection(auditRequest({ text: "multi factor" }), model.context, {
      generators: securityGenerators,
    });

    expect(plan.conflicts.map(d => d.code)).not.toContain(RERANKER_NOT_IMPLEMENTED);
    expect((plan.rationale ?? []).map(d => d.code)).toContain(RERANKER_APPLIED);
  });

  test("planWithConstraints runs it on the satisfiable path too", () => {
    const result = planWithConstraints(auditRequest({ text: "multi factor" }), model.context, {
      generators: securityGenerators,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.conflicts.map(d => d.code)).not.toContain(RERANKER_NOT_IMPLEMENTED);
    expect(result.retrieval.reranker).toBe("stable-linear-v1");
  });

  test("an unregistered reranker on the real model still reaches the over-budget plan", () => {
    // Two independent conflicts must coexist: routing both into `conflicts` is only
    // safe if neither displaces the other. Parameters mirror the existing
    // `exceeded-at-cheapest-projection` case in `security-model.test.ts`, which is
    // the only known way to force a budget conflict on this fixture.
    const profile = model.profiles["audit-default"]!;
    const unknown: RetrievalProfile = { ...profile, reranker: "weighted-blend-v2" };
    const result = planWithConstraints(
      auditRequest({
        text: "verification factor",
        seeds: ["@sec/control-multi-factor"],
        maxTokens: 20,
        fallbackProjections: ["core", "summary"],
      }),
      { ...model.context, profiles: { ...model.profiles, "audit-default": unknown } },
      { generators: securityGenerators, mandatory: ["@sec/control-multi-factor"] },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const codes = result.plan.conflicts.map(d => d.code);
    expect(codes).toContain(RERANKER_NOT_IMPLEMENTED);
    expect(codes).toContain("BUDGET_EXCEEDED_AT_CHEAPEST_PROJECTION");
  });
});
