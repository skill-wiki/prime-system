import { describe, expect, test } from "bun:test";
import { QueryEngineError, planBudget, resolveProjectionChain } from "../src/index.ts";
import { domainA, projection } from "./support/model.ts";

const projections = domainA.projections;

describe("projection chain", () => {
  test("the profile's projection comes first, then the request's fallbacks", () => {
    expect(resolveProjectionChain("detailed", ["brief"], projections)).toEqual(["detailed", "brief"]);
  });

  test("a duplicate fallback is collapsed", () => {
    expect(resolveProjectionChain("brief", ["brief"], projections)).toEqual(["brief"]);
  });

  test("an unknown projection throws instead of being skipped", () => {
    expect(() => resolveProjectionChain("ghost", undefined, projections)).toThrow(
      /PROJECTION_NOT_DECLARED/,
    );
    expect(() => resolveProjectionChain("detailed", ["ghost"], projections)).toThrow(QueryEngineError);
  });
});

describe("budget", () => {
  test("falls back to a cheaper projection rather than dropping the unit", () => {
    // detailed=120, brief=30. 150 fits one detailed, then only a brief.
    const result = planBudget(["a", "b"], ["detailed", "brief"], 150, projections, undefined);
    expect(result.assignments).toEqual([
      { unitId: "a", projectionRef: "detailed", tokens: 120 },
      { unitId: "b", projectionRef: "brief", tokens: 30 },
    ]);
    expect(result.consumedTokens).toBe(150);
    expect(result.rejections).toEqual([]);
  });

  test("a rejection carries the arithmetic that excluded it", () => {
    const result = planBudget(["a", "b"], ["detailed"], 130, projections, undefined);
    expect(result.assignments.map(x => x.unitId)).toEqual(["a"]);
    expect(result.rejections[0]!.unitId).toBe("b");
    expect(result.rejections[0]!.reasons[0]).toContain("needs 120 tokens, 10 of 130 remain");
    expect(result.rejections[0]!.reasons[1]).toContain("detailed=120");
  });

  test("load order is preserved rather than reordered to fit more units", () => {
    // A knapsack solver would take the two cheap units; a load-order-preserving
    // pass must spend the budget on the unit that has to load first.
    const cost = (unitId: string): number | undefined => (unitId === "big" ? 90 : 30);
    const result = planBudget(["big", "s1", "s2"], ["detailed"], 100, projections, cost);
    expect(result.assignments.map(x => x.unitId)).toEqual(["big"]);
    expect(result.rejections.map(x => x.unitId)).toEqual(["s1", "s2"]);
  });

  test("a measured token cost overrides the projection's declared target", () => {
    const result = planBudget(["a"], ["detailed"], 20, projections, () => 15);
    expect(result.assignments).toEqual([{ unitId: "a", projectionRef: "detailed", tokens: 15 }]);
    expect(result.consumedTokens).toBe(15);
  });

  test("a non-positive or fractional budget is a programmer error, not a diagnostic", () => {
    expect(() => planBudget(["a"], ["brief"], 0, projections, undefined)).toThrow(/BUDGET_INVALID/);
    expect(() => planBudget(["a"], ["brief"], -1, projections, undefined)).toThrow(/BUDGET_INVALID/);
    expect(() => planBudget(["a"], ["brief"], 1.5, projections, undefined)).toThrow(/BUDGET_INVALID/);
  });

  test("a unit larger than the whole budget is rejected, not silently truncated", () => {
    const huge = { huge: projection("huge", 10_000) };
    const result = planBudget(["a"], ["huge"], 10, huge, undefined);
    expect(result.assignments).toEqual([]);
    expect(result.consumedTokens).toBe(0);
    expect(result.rejections[0]!.reasons[0]).toContain("needs 10000 tokens, 10 of 10 remain");
  });
});
