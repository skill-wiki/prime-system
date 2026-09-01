import { describe, expect, test } from "bun:test";
import type { ConstraintRefIR } from "@aoe/ir";
import { solve, type Constraint, type HardConstraint, type RuntimePolicyConstraint, type SolveRequest, type WeightBearingKinds } from "../src/index.ts";
import { edge, relation, relations, snapshot, unit } from "./support.ts";

/** Structural identity check: fails to compile if the two types drift apart. */
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

function request(overrides: Partial<SolveRequest> & Pick<SolveRequest, "relations" | "edges" | "units" | "mandatory">): SolveRequest {
  return { requestId: "r-1", snapshot, ...overrides };
}

describe("hard constraints are never overridden by weight", () => {
  test("only the soft class carries a weight, at the type level", () => {
    const onlySoftIsWeighted: Equals<WeightBearingKinds, "soft-preference"> = true;
    expect(onlySoftIsWeighted).toBe(true);
    const hardHasNoWeight: Equals<Extract<HardConstraint, { readonly weight: number }>, never> = true;
    const policyHasNoWeight: Equals<Extract<RuntimePolicyConstraint, { readonly weight: number }>, never> = true;
    expect([hardHasNoWeight, policyHasNoWeight]).toEqual([true, true]);
    const everyKind: Constraint["kind"][] = ["hard-requirement", "hard-prohibition", "soft-preference", "runtime-policy", "ordering", "advisory-exclusion"];
    expect(new Set(everyKind).size).toBe(6);
  });

  test("an unbounded preference weight cannot defeat a hard prohibition", () => {
    for (const weight of [1, 1e9, Number.MAX_SAFE_INTEGER]) {
      const result = solve(request({
        relations: relations(relation("rel-x", { selection: "exclude", traversal: "one-hop", conflictSeverity: "error" })),
        edges: [edge("e1", "rel-x", "u1", "u2")],
        units: [unit("u1"), unit("u2")],
        mandatory: ["u1"],
        preferences: [{ unitId: "u2", weight }],
      }));
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.order).toEqual(["u1"]);
      expect(result.plan.rejections.map(rejection => [rejection.candidate.unitId, rejection.reasons[0]])).toEqual([["u2", "hard-prohibition-violated"]]);
    }
  });

  test("an unbounded preference weight cannot buy its way past the budget for a hard closure", () => {
    const result = solve(request({
      relations: relations(relation("rel-c", { selection: "closure", traversal: "transitive" })),
      edges: [edge("e1", "rel-c", "u2", "u3")],
      units: [unit("u1"), unit("u2"), unit("u3")],
      mandatory: ["u1"],
      preferences: [{ unitId: "u2", weight: Number.MAX_SAFE_INTEGER }],
      unitCost: { u1: 1, u2: 1, u3: 10 },
      budget: { maxTokens: 5 },
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Admitting u2 would drag its whole hard closure in, which does not fit; the
    // weight cannot split the pair.
    expect(result.order).toEqual(["u1"]);
    expect(result.plan.rejections.map(rejection => rejection.reasons)).toEqual([["budget-exhausted"]]);
  });

  test("an unbounded preference weight cannot defeat a runtime policy", () => {
    const result = solve(request({
      relations: {},
      edges: [],
      units: [unit("u1"), unit("u2", ["p-1"])],
      mandatory: ["u1"],
      preferences: [{ unitId: "u2", weight: Number.MAX_SAFE_INTEGER }],
      policyRequirements: { "p-1": { capabilities: ["cap-1"], sideEffect: "none" } },
      principal: { capabilities: [] },
    }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.order).toEqual(["u1"]);
  });

  test("no soft preference ever reaches an unsat core", () => {
    const result = solve(request({
      relations: relations(relation("rel-c", { selection: "closure", traversal: "transitive" }), relation("rel-x", { selection: "exclude", traversal: "one-hop", conflictSeverity: "error" }), relation("rel-e", { selection: "expand", traversal: "transitive" })),
      edges: [edge("e1", "rel-c", "u1", "u2"), edge("e2", "rel-c", "u1", "u3"), edge("e3", "rel-x", "u2", "u3"), edge("e4", "rel-e", "u1", "u4")],
      units: [unit("u1"), unit("u2"), unit("u3"), unit("u4")],
      mandatory: ["u1"],
      preferences: [{ unitId: "u4", weight: Number.MAX_SAFE_INTEGER }],
    }));
    expect(result.ok).toBe(false);
    if (result.ok || result.reason !== "unsat") throw new Error("expected an unsatisfiable plan");
    // The core type cannot even name the soft class, so this is proven statically
    // and then re-checked on the emitted refs.
    const coreExcludesSoft: Equals<Extract<ConstraintRefIR["kind"], "soft-preference" | "advisory-exclusion">, never> = true;
    expect(coreExcludesSoft).toBe(true);
    expect(result.unsatCore.some(entry => entry.ref.startsWith("sp:"))).toBe(false);
    expect(result.unsatCore.map(entry => entry.ref)).toEqual(["hp:e3", "hr:e1", "hr:e2"]);
  });
});
