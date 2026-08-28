/**
 * Budget solving: the contract is that nothing is silently truncated. Every test
 * here checks that the *reason* is present, not just that the number fits.
 */

import { describe, expect, test } from "bun:test";
import { solveBudget, type BudgetUnitInput } from "../src/budget.ts";
import { levelFromDefinition } from "../src/profile.ts";
import { projectionDef } from "./fixtures.ts";

const thin = levelFromDefinition(projectionDef("pf-one/lv-thin", 50));
const mid = levelFromDefinition(projectionDef("pf-one/lv-mid", 200));
const wide = levelFromDefinition(projectionDef("pf-one/lv-wide", 800));
const ladder = [thin, mid, wide];

function input(unitId: string, priority: number, levels = ladder): BudgetUnitInput {
  return { unitId, levels, priority };
}

describe("solveBudget — fitting", () => {
  test("takes the richest level when the budget allows it", () => {
    const plan = solveBudget([input("u-1", 1)], 1000);
    expect(plan.assignments).toEqual([{ unitId: "u-1", level: wide, tokens: 800 }]);
    expect(plan.degraded).toEqual([]);
    expect(plan.dropped).toEqual([]);
    expect(plan.consumedTokens).toBe(800);
  });

  test("consumedTokens is the sum of the chosen levels", () => {
    const plan = solveBudget([input("u-1", 2), input("u-2", 1)], 1600);
    expect(plan.consumedTokens).toBe(1600);
    expect(plan.assignments.length).toBe(2);
  });
});

describe("solveBudget — degradation carries a reason", () => {
  test("downgrades instead of overflowing", () => {
    const plan = solveBudget([input("u-1", 1)], 300);
    expect(plan.assignments[0]?.level).toBe(mid);
    expect(plan.consumedTokens).toBeLessThanOrEqual(300);
  });

  test("records the level lost and why", () => {
    const plan = solveBudget([input("u-1", 1)], 300);
    expect(plan.degraded.length).toBe(1);
    expect(plan.degraded[0]?.unitId).toBe("u-1");
    expect(plan.degraded[0]?.from).toBe(wide);
    expect(plan.degraded[0]?.to).toBe(mid);
    expect(plan.degraded[0]?.reason).toContain("300");
  });

  test("degrades the unit that releases the most tokens first", () => {
    // u-1 can shed 600 by dropping wide→mid; u-2 only has one level and cannot move.
    const plan = solveBudget([input("u-1", 1), input("u-2", 2, [mid])], 400);
    const byId = new Map(plan.assignments.map((a) => [a.unitId, a.level]));
    expect(byId.get("u-2")).toBe(mid);
    expect(byId.get("u-1")).toBe(mid);
    expect(plan.degraded.map((d) => d.unitId)).toEqual(["u-1"]);
  });

  test("degrades all the way to the cheapest level before dropping anything", () => {
    const plan = solveBudget([input("u-1", 1), input("u-2", 2)], 100);
    expect(plan.dropped).toEqual([]);
    expect(plan.assignments.every((a) => a.level === thin)).toBe(true);
    expect(plan.consumedTokens).toBe(100);
  });
});

describe("solveBudget — dropping carries a reason", () => {
  test("drops the lowest-priority unit when even the cheapest levels do not fit", () => {
    const plan = solveBudget([input("u-keep", 9), input("u-drop", 1)], 60);
    expect(plan.assignments.map((a) => a.unitId)).toEqual(["u-keep"]);
    expect(plan.dropped.length).toBe(1);
    expect(plan.dropped[0]?.unitId).toBe("u-drop");
    expect(plan.dropped[0]?.cheapest).toBe(thin);
    expect(plan.dropped[0]?.reason).toContain("60");
  });

  test("a unit with no applicable level is dropped with its own reason, not silently", () => {
    const plan = solveBudget([input("u-1", 1, [])], 1000);
    expect(plan.assignments).toEqual([]);
    expect(plan.dropped.length).toBe(1);
    expect(plan.dropped[0]?.reason).toContain("No applicable projection level");
    expect(plan.dropped[0]?.cheapest).toBeUndefined();
  });

  test("every input unit is accounted for in exactly one bucket", () => {
    const units = [input("u-1", 3), input("u-2", 2), input("u-3", 1), input("u-4", 0, [])];
    const plan = solveBudget(units, 120);
    const seen = [
      ...plan.assignments.map((a) => a.unitId),
      ...plan.dropped.map((d) => d.unitId),
    ].sort();
    expect(seen).toEqual(["u-1", "u-2", "u-3", "u-4"]);
    // Degradations refer to assigned units only — they are annotations, not a bucket.
    for (const degradation of plan.degraded) {
      expect(plan.assignments.some((a) => a.unitId === degradation.unitId)).toBe(true);
    }
  });

  test("a zero budget drops everything with reasons", () => {
    const plan = solveBudget([input("u-1", 1), input("u-2", 2)], 0);
    expect(plan.assignments).toEqual([]);
    expect(plan.dropped.length).toBe(2);
    expect(plan.dropped.every((d) => d.reason !== "")).toBe(true);
  });
});

describe("solveBudget — determinism and validation", () => {
  test("input order does not change the outcome for equal priorities", () => {
    const a = solveBudget([input("u-1", 1), input("u-2", 1)], 60);
    const b = solveBudget([input("u-2", 1), input("u-1", 1)], 60);
    expect(a.assignments.map((x) => x.unitId).sort()).toEqual(
      b.assignments.map((x) => x.unitId).sort(),
    );
    expect(a.consumedTokens).toBe(b.consumedTokens);
  });

  test("rejects a negative budget", () => {
    expect(() => solveBudget([input("u-1", 1)], -1)).toThrow();
  });

  test("rejects a non-finite budget", () => {
    expect(() => solveBudget([input("u-1", 1)], Number.POSITIVE_INFINITY)).toThrow();
  });

  test("an empty unit set yields an empty plan", () => {
    const plan = solveBudget([], 100);
    expect(plan.consumedTokens).toBe(0);
    expect(plan.assignments).toEqual([]);
  });
});
