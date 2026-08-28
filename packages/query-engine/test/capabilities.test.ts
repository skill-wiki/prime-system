/**
 * @module test/capabilities
 *
 * A profile may declare a pipeline stage this engine does not implement. These
 * cases pin the *reporting* contract, not a reranker: the point of the lane was to
 * turn a silent gap into an explicit one, and a test suite that let the diagnostic
 * be dropped from a serialised plan would put the silence straight back.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import type { RetrievalProfile } from "@skill-wiki/model-schema";
import {
  RERANKER_NOT_IMPLEMENTED,
  detectCapabilityGaps,
  planSelection,
  planWithConstraints,
  type QueryRequest,
} from "../src/index.ts";
import { anyPrincipal, contextFor, corpusA, registryFor } from "./support/harness.ts";
import { domainA } from "./support/model.ts";
import { loadSecurityModel, securityRegistry, type SecurityModel } from "./support/security-model.ts";

const generators = registryFor(domainA);

/** `domainA.profile` declares no reranker; this is the same profile that does. */
const withReranker: RetrievalProfile = { ...domainA.profile, reranker: "stable-linear-v1" };

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
  test("a declared reranker yields one warning naming the profile and the reranker", () => {
    const gaps = detectCapabilityGaps(withReranker);

    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.code).toBe(RERANKER_NOT_IMPLEMENTED);
    expect(gaps[0]!.severity).toBe("warning");
    expect(gaps[0]!.path).toEqual(["profile", "reranker"]);
    // The message has to identify *which* declaration is unhonoured, or a caller
    // holding several profiles cannot act on it.
    expect(gaps[0]!.message).toContain(domainA.profile.name);
    expect(gaps[0]!.message).toContain("stable-linear-v1");
  });

  test("a profile declaring no reranker yields nothing — absence is not a gap", () => {
    expect(detectCapabilityGaps(domainA.profile)).toEqual([]);
  });

  test("severity is warning, not error: the plan is still deliverable", () => {
    // Guards against a later well-meaning upgrade to `error`, which would claim the
    // selected set or the budget is invalid. Neither is affected by the gap.
    expect(detectCapabilityGaps(withReranker).every(d => d.severity !== "error")).toBe(true);
  });
});

describe("planSelection routes the gap into the plan", () => {
  test("the diagnostic lands in `conflicts`, the plan's required slot", () => {
    const plan = planFor(withReranker);

    expect(plan.conflicts.map(d => d.code)).toContain(RERANKER_NOT_IMPLEMENTED);
  });

  test("it survives serialisation, which `rationale` alone could not guarantee", () => {
    // `SelectionPlanIR.rationale` is optional and `conflicts` is required, so this
    // is the whole reason for the channel choice rather than a stylistic one.
    const roundTripped = JSON.parse(JSON.stringify(planFor(withReranker))) as {
      conflicts: { code: string }[];
    };

    expect(roundTripped.conflicts.map(d => d.code)).toContain(RERANKER_NOT_IMPLEMENTED);
  });

  test("no reranker declared means the code appears nowhere in the plan", () => {
    expect(JSON.stringify(planFor(domainA.profile))).not.toContain(RERANKER_NOT_IMPLEMENTED);
  });

  test("reporting the gap changes no selection outcome — it is explicit, not corrective", () => {
    const silent = planFor(domainA.profile);
    const explicit = planFor(withReranker);

    expect(explicit.selected).toEqual(silent.selected);
    expect(explicit.rejections).toEqual(silent.rejections);
    expect(explicit.projectionLoads).toEqual(silent.projectionLoads);
    expect(explicit.budget).toEqual(silent.budget);
    // Exactly one conflict is added, and it is the gap.
    expect(explicit.conflicts.length).toBe(silent.conflicts.length + 1);
    expect(explicit.conflicts.filter(d => d.code === RERANKER_NOT_IMPLEMENTED)).toHaveLength(1);
  });

  test("the gap is reported once, not once per candidate", () => {
    const plan = planFor(withReranker);

    expect(plan.conflicts.filter(d => d.code === RERANKER_NOT_IMPLEMENTED)).toHaveLength(1);
  });
});

describe("the real security-model fixture declares a reranker", () => {
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

  test("`audit-default` really declares it, loaded through the real model loader", () => {
    // Pins the premise of the whole case on the fixture rather than on a literal:
    // if the fixture stops declaring a reranker, the cases below must be revisited.
    expect(model.profiles["audit-default"]!.reranker).toBe("stable-linear-v1");
  });

  test("planSelection over the real model reports the gap", () => {
    const plan = planSelection(auditRequest({ text: "multi factor" }), model.context, {
      generators: securityGenerators,
    });

    expect(plan.conflicts.map(d => d.code)).toContain(RERANKER_NOT_IMPLEMENTED);
  });

  test("planWithConstraints reports it on the satisfiable path", () => {
    const result = planWithConstraints(auditRequest({ text: "multi factor" }), model.context, {
      generators: securityGenerators,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.conflicts.map(d => d.code)).toContain(RERANKER_NOT_IMPLEMENTED);
  });

  test("an over-budget plan carries the gap alongside the budget conflict, not instead of it", () => {
    // Two independent conflicts must coexist: routing both into `conflicts` is only
    // safe if neither displaces the other. Parameters mirror the existing
    // `exceeded-at-cheapest-projection` case in `security-model.test.ts`, which is
    // the only known way to force a budget conflict on this fixture.
    const result = planWithConstraints(
      auditRequest({
        text: "verification factor",
        seeds: ["@sec/control-multi-factor"],
        maxTokens: 20,
        fallbackProjections: ["core", "summary"],
      }),
      model.context,
      { generators: securityGenerators, mandatory: ["@sec/control-multi-factor"] },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const codes = result.plan.conflicts.map(d => d.code);
    expect(codes).toContain(RERANKER_NOT_IMPLEMENTED);
    expect(codes).toContain("BUDGET_EXCEEDED_AT_CHEAPEST_PROJECTION");
  });
});
