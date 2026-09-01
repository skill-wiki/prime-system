/**
 * @module test/reranker
 *
 * The reranking stage, and the two claims that decide whether implementing it was
 * real work or a hook with nothing behind it:
 *
 *   1. `stable-linear-v1` is order-preserving with respect to the unreranked path.
 *      This is the *expected* result — the declaration names a stable linear
 *      combination of the profile's own weights, which is exactly what the scorer
 *      already computes — so it is asserted rather than assumed, and asserted
 *      together with (2) so that "no change" cannot be read as "nothing ran".
 *
 *   2. A reranker with different semantics, registered under a different name,
 *      really does change what the caller receives — both the order and, under a
 *      `limit`, the membership. If (2) failed, the stage would be dead code and (1)
 *      would be vacuous.
 *
 * Plus the no-seed case codex flagged: a weighted axis that no generator produced
 * for this request contributes 0 and the remaining weights are not renormalised.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import type { SelectionCandidateIR } from "@aoe/ir";
import type { RetrievalProfile } from "@aoe/model-schema";
import {
  FEATURE_AXIS_NOT_APPLICABLE,
  FEATURE_AXIS_UNPRODUCED,
  RERANKER_APPLIED,
  RERANK_SCORE_DISAGREEMENT,
  RerankerRegistry,
  STABLE_LINEAR_V1,
  applyReranker,
  builtinRerankers,
  createStableLinearReranker,
  linearScore,
  planSelection,
  type QueryRequest,
  type Reranker,
} from "../src/index.ts";
import { loadSecurityModel, securityRegistry, type SecurityModel } from "./support/security-model.ts";

const AUDIT = "audit-default";
const MFA = "@sec/control-multi-factor";

let model: SecurityModel;

beforeAll(() => {
  model = loadSecurityModel();
});

function auditRequest(overrides: Partial<QueryRequest> = {}): QueryRequest {
  return {
    requestId: "rerank-1",
    profile: AUDIT,
    principal: { id: "auditor", allowedVisibility: ["public", "shared"], grantedPolicyLabels: [] },
    maxTokens: 100_000,
    text: "multi factor authentication control",
    ...overrides,
  };
}

/** The same context with `audit-default` replaced. */
function contextWith(profile: RetrievalProfile) {
  return { ...model.context, profiles: { ...model.profiles, [AUDIT]: profile } };
}

/** Reverses whatever order it is handed. Deliberately nothing to do with scores. */
const reversing: Reranker = {
  name: "reverse-v1",
  rerank(candidates) {
    return [...candidates].reverse();
  },
};

describe("linearScore is the one definition of the profile's linear model", () => {
  test("weights come from the profile and unweighted axes are excluded", () => {
    expect(linearScore({ a: 0.5, b: 1 }, { a: 2, b: 0.25 })).toBe(1.25);
    expect(linearScore({ a: 0.5, ignored: 1 }, { a: 2 })).toBe(1);
  });

  test("an axis the profile weights but the candidate lacks contributes 0, not a renormalisation", () => {
    // 0.7 * 1 with `graphAffinity` absent must stay 0.7, not become 1.0. This is
    // the arithmetic behind the no-seed case below.
    expect(linearScore({ lexicalScore: 1 }, { lexicalScore: 0.7, graphAffinity: 0.3 })).toBe(0.7);
  });
});

describe("the registry", () => {
  test("ships `stable-linear-v1` and nothing else", () => {
    expect(builtinRerankers().names()).toEqual([STABLE_LINEAR_V1]);
  });

  test("a host extends its own copy without touching anyone else's", () => {
    const mine = builtinRerankers().register(reversing);
    expect(mine.names()).toEqual([STABLE_LINEAR_V1, "reverse-v1"].sort());
    // The next caller gets a clean set, so registration cannot leak across hosts.
    expect(builtinRerankers().names()).toEqual([STABLE_LINEAR_V1]);
  });

  test("a duplicate name is refused rather than silently overriding", () => {
    expect(() => builtinRerankers().register(createStableLinearReranker())).toThrow(/RERANKER_DUPLICATE/);
  });
});

describe("stable-linear-v1 over the real security model", () => {
  test("it runs, and the plan says so once", () => {
    const plan = planSelection(auditRequest({ seeds: [MFA] }), model.context, {
      generators: securityRegistry(),
    });
    const applied = (plan.rationale ?? []).filter(d => d.code === RERANKER_APPLIED);
    expect(applied).toHaveLength(1);
    expect(applied[0]!.message).toContain(STABLE_LINEAR_V1);
    expect(applied[0]!.severity).toBe("info");
  });

  test("its order equals the unreranked order — by construction, and here by measurement", () => {
    // Same model with the declaration removed: the only difference is whether the
    // stage runs at all.
    const unreranked: RetrievalProfile = { ...model.profiles[AUDIT]! };
    delete (unreranked as { reranker?: string }).reranker;

    const withStage = planSelection(auditRequest({ seeds: [MFA] }), model.context, {
      generators: securityRegistry(),
    });
    const without = planSelection(auditRequest({ seeds: [MFA] }), contextWith(unreranked), {
      generators: securityRegistry(),
    });

    expect(withStage.selected.map(c => c.unitId)).toEqual(without.selected.map(c => c.unitId));
    expect(withStage.projectionLoads).toEqual(without.projectionLoads);
  });

  test("it reports nothing about score disagreement, because the scorer shares its formula", () => {
    const plan = planSelection(auditRequest({ seeds: [MFA] }), model.context, {
      generators: securityRegistry(),
    });
    expect((plan.rationale ?? []).map(d => d.code)).not.toContain(RERANK_SCORE_DISAGREEMENT);
  });

  test("it ranks by the published breakdown, so a doctored total is caught not obeyed", () => {
    // The invariant `stable-linear-v1` buys beyond ordering: a candidate whose
    // total contradicts its own per-axis breakdown is a plan two consumers would
    // read differently. Only reachable by calling the stage directly, because no
    // engine stage produces that state.
    const reported: string[] = [];
    const profile = model.profiles[AUDIT]!;
    const doctored: readonly SelectionCandidateIR[] = [
      { unitId: "U-liar", score: 999, featureValues: { lexicalScore: 0.1 }, reasons: [] },
      { unitId: "U-honest", score: linearScore({ lexicalScore: 0.9 }, profile.features), featureValues: { lexicalScore: 0.9 }, reasons: [] },
    ];

    const outcome = applyReranker(doctored, profile, builtinRerankers(), d => reported.push(d.code));

    expect(outcome.applied).toBe(STABLE_LINEAR_V1);
    expect(outcome.candidates.map(c => c.unitId)).toEqual(["U-honest", "U-liar"]);
    expect(reported).toContain(RERANK_SCORE_DISAGREEMENT);
  });
});

describe("the stage is live, not dead code", () => {
  test("a different reranker changes the delivered order", () => {
    const rerankers = builtinRerankers().register(reversing);
    const reversed: RetrievalProfile = { ...model.profiles[AUDIT]!, reranker: "reverse-v1" };

    const normal = planSelection(auditRequest({ seeds: [MFA] }), model.context, {
      generators: securityRegistry(),
    });
    const flipped = planSelection(auditRequest({ seeds: [MFA] }), contextWith(reversed), {
      generators: securityRegistry(),
      rerankers,
    });

    expect(normal.selected.length).toBeGreaterThan(1);
    // Same units, different order: proof the stage reaches the caller rather than
    // being overwritten by a later sort.
    expect([...flipped.selected.map(c => c.unitId)].sort()).toEqual(
      [...normal.selected.map(c => c.unitId)].sort(),
    );
    expect(flipped.selected.map(c => c.unitId)).not.toEqual(normal.selected.map(c => c.unitId));
  });

  test("running before the rank cutoff means it decides membership, not only order", () => {
    // The placement claim from `engine.ts`. With `limit: 1` the reversed reranker
    // must hand a *different* unit to the cutoff, not merely reorder the same one.
    const rerankers = builtinRerankers().register(reversing);
    const reversed: RetrievalProfile = { ...model.profiles[AUDIT]!, reranker: "reverse-v1" };

    const normal = planSelection(auditRequest({ limit: 1 }), model.context, {
      generators: securityRegistry(),
    });
    const flipped = planSelection(auditRequest({ limit: 1 }), contextWith(reversed), {
      generators: securityRegistry(),
      rerankers,
    });

    expect(normal.selected.length).toBeGreaterThan(0);
    expect(flipped.selected.length).toBeGreaterThan(0);
    expect(flipped.selected[0]!.unitId).not.toBe(normal.selected[0]!.unitId);
  });

  test("a reranker that drops or invents a unit is rejected, because admission ran upstream", () => {
    const profile = model.profiles[AUDIT]!;
    const input: readonly SelectionCandidateIR[] = [
      { unitId: "A", score: 0, featureValues: {}, reasons: [] },
      { unitId: "B", score: 0, featureValues: {}, reasons: [] },
    ];
    const dropper: Reranker = { name: "drop", rerank: candidates => candidates.slice(1) };
    const inventor: Reranker = {
      name: "invent",
      rerank: candidates => [...candidates.slice(1), { unitId: "Z", score: 0, featureValues: {}, reasons: [] }],
    };
    const withProfile = (name: string): RetrievalProfile => ({ ...profile, reranker: name });

    expect(() =>
      applyReranker(input, withProfile("drop"), new RerankerRegistry().register(dropper), () => {}),
    ).toThrow(/RERANKER_CHANGED_MEMBERSHIP/);
    expect(() =>
      applyReranker(input, withProfile("invent"), new RerankerRegistry().register(inventor), () => {}),
    ).toThrow(/RERANKER_CHANGED_MEMBERSHIP/);
  });
});

describe("a weighted axis no generator produced for this request", () => {
  test("a no-seed query loses graphAffinity and says so as `info`, not as a wiring warning", () => {
    // codex's second finding. `graph-neighbors` is registered and declares
    // `graphAffinity`; with no seed there is nothing to measure proximity to, so it
    // produces nothing. That is the request's shape, not a mis-wired model.
    const plan = planSelection(auditRequest(), model.context, { generators: securityRegistry() });
    const rationale = plan.rationale ?? [];
    const notApplicable = rationale.filter(d => d.code === FEATURE_AXIS_NOT_APPLICABLE);

    expect(notApplicable).toHaveLength(1);
    expect(notApplicable[0]!.severity).toBe("info");
    expect(notApplicable[0]!.message).toContain("graphAffinity");
    expect(notApplicable[0]!.message).toContain("graph-neighbors");
    expect(rationale.map(d => d.code)).not.toContain(FEATURE_AXIS_UNPRODUCED);
  });

  test("a seeded query on the same model reports neither", () => {
    const codes = (
      planSelection(auditRequest({ seeds: [MFA] }), model.context, { generators: securityRegistry() })
        .rationale ?? []
    ).map(d => d.code);
    expect(codes).not.toContain(FEATURE_AXIS_NOT_APPLICABLE);
    expect(codes).not.toContain(FEATURE_AXIS_UNPRODUCED);
  });

  test("an axis nothing even declares is still a warning, because that one is a wiring fault", () => {
    const invented: RetrievalProfile = {
      ...model.profiles[AUDIT]!,
      features: { ...model.profiles[AUDIT]!.features, nobodysAxis: 0.5 },
    };
    const codes = (
      planSelection(auditRequest({ seeds: [MFA] }), contextWith(invented), {
        generators: securityRegistry(),
      }).rationale ?? []
    ).map(d => d.code);
    expect(codes).toContain(FEATURE_AXIS_UNPRODUCED);
  });

  test("the missing axis costs its own weight and nothing more — no renormalisation", () => {
    // The substantive half of the semantics. If the engine renormalised, dropping
    // `graphAffinity` would leave the top unit's score unchanged (its remaining
    // axes rescaled to sum to 1). It must instead fall by exactly the graph
    // contribution, leaving the *other* axes' weights untouched.
    const profile = model.profiles[AUDIT]!;
    const seeded = planSelection(auditRequest({ seeds: [MFA] }), model.context, {
      generators: securityRegistry(),
    });
    const unseeded = planSelection(auditRequest(), model.context, { generators: securityRegistry() });

    const seededMfa = seeded.candidates.find(c => c.unitId === MFA)!;
    const unseededMfa = unseeded.candidates.find(c => c.unitId === MFA)!;
    expect(seededMfa.featureValues["graphAffinity"]).toBeGreaterThan(0);
    expect(unseededMfa.featureValues["graphAffinity"]).toBeUndefined();

    // Every score in the unseeded plan is exactly the linear model over the axes
    // that *were* produced, with the profile's original weights.
    for (const candidate of unseeded.candidates) {
      expect(candidate.score).toBe(linearScore(candidate.featureValues, profile.features));
    }
    // And the axes that survived kept their measured values, so the loss is
    // confined to the absent axis rather than smeared across the others.
    expect(unseededMfa.featureValues["lexicalScore"]).toBe(seededMfa.featureValues["lexicalScore"]);
    expect(unseededMfa.featureValues["severityWeight"]).toBe(seededMfa.featureValues["severityWeight"]);
  });
});
