import { describe, expect, test } from "bun:test";
import type { RelationDefIR } from "@skill-wiki/ir";
import { solve, type SolveRequest } from "../src/index.ts";
import { edge, relation, relations, snapshot, unit } from "./support.ts";

const base = { requestId: "r-1", snapshot } as const;
const units = (...ids: readonly string[]) => ids.map(id => unit(id));

function request(overrides: Partial<SolveRequest> & Pick<SolveRequest, "relations" | "edges" | "units" | "mandatory">): SolveRequest {
  return { ...base, ...overrides };
}

describe("mandatory closure", () => {
  test("traversal 'transitive' follows the chain while 'one-hop' stops after one step", () => {
    const edges = [edge("e1", "rel-c", "u1", "u2"), edge("e2", "rel-c", "u2", "u3")];
    const transitive = solve(request({ relations: relations(relation("rel-c", { selection: "closure", traversal: "transitive" })), edges, units: units("u1", "u2", "u3"), mandatory: ["u1"] }));
    expect(transitive.ok).toBe(true);
    if (transitive.ok) expect(transitive.order).toEqual(["u1", "u2", "u3"]);
    const oneHop = solve(request({ relations: relations(relation("rel-c", { selection: "closure", traversal: "one-hop" })), edges, units: units("u1", "u2", "u3"), mandatory: ["u1"] }));
    expect(oneHop.ok).toBe(true);
    if (oneHop.ok) expect(oneHop.order).toEqual(["u1", "u2"]);
  });

  test("a one-hop budget is per relation, so a different relation may still hop onward", () => {
    const result = solve(request({
      relations: relations(relation("rel-c1", { selection: "closure", traversal: "one-hop" }), relation("rel-c2", { selection: "closure", traversal: "one-hop" })),
      edges: [edge("e1", "rel-c1", "u1", "u2"), edge("e2", "rel-c2", "u2", "u3")],
      units: units("u1", "u2", "u3"),
      mandatory: ["u1"],
    }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.order).toEqual(["u1", "u2", "u3"]);
  });

  test("records each expansion hop for explainability", () => {
    const result = solve(request({ relations: relations(relation("rel-c", { selection: "closure", traversal: "transitive" })), edges: [edge("e1", "rel-c", "u1", "u2"), edge("e2", "rel-c", "u2", "u3")], units: units("u1", "u2", "u3"), mandatory: ["u1"] }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.plan.relationExpansions).toEqual([{ relationRef: "rel-c", from: "u1", discovered: ["u2"], depth: 1 }, { relationRef: "rel-c", from: "u2", discovered: ["u3"], depth: 2 }]);
  });

  test("an absent hard-requirement target invalidates the plan with a single-ref core", () => {
    const result = solve(request({ relations: relations(relation("rel-c", { selection: "closure", traversal: "transitive" })), edges: [edge("e1", "rel-c", "u1", "u9")], units: units("u1"), mandatory: ["u1"] }));
    expect(result.ok).toBe(false);
    if (result.ok || result.reason !== "unsat") throw new Error("expected an unsatisfiable plan");
    expect(result.blocker).toBe("missing-target");
    expect(result.unsatCore).toEqual([{ ref: "hr:e1", kind: "hard-requirement" }]);
    expect(result.plan.conflicts[0]?.code).toBe("HARD_REQUIREMENT_TARGET_MISSING");
  });

  test("a mandatory unit outside the graph is invalid input, not an unsat plan", () => {
    const result = solve(request({ relations: {}, edges: [], units: units("u1"), mandatory: ["u9"] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid-input");
  });
});

describe("exclusion", () => {
  test("an error-severity exclusion inside the mandatory closure is unsatisfiable with a minimal core", () => {
    const result = solve(request({
      relations: relations(relation("rel-c", { selection: "closure", traversal: "transitive" }), relation("rel-x", { selection: "exclude", traversal: "one-hop", conflictSeverity: "error" })),
      edges: [edge("e1", "rel-c", "u1", "u2"), edge("e2", "rel-c", "u1", "u3"), edge("e3", "rel-x", "u2", "u3"), edge("e4", "rel-c", "u1", "u4")],
      units: units("u1", "u2", "u3", "u4"),
      mandatory: ["u1"],
      preferences: [{ unitId: "u4", weight: 99 }],
    }));
    expect(result.ok).toBe(false);
    if (result.ok || result.reason !== "unsat") throw new Error("expected an unsatisfiable plan");
    expect(result.blocker).toBe("hard-prohibition");
    // Exactly the three constraints that fight each other: the unrelated fourth
    // requirement and every soft preference stay out of the core.
    expect(result.unsatCore.map(entry => entry.ref)).toEqual(["hp:e3", "hr:e1", "hr:e2"]);
    expect(result.unsatCore.some(entry => entry.ref.startsWith("sp:"))).toBe(false);
  });

  test("a warning-severity exclusion is recorded but does not block", () => {
    const result = solve(request({ relations: relations(relation("rel-x", { selection: "exclude", traversal: "one-hop", conflictSeverity: "warning" })), edges: [edge("e1", "rel-x", "u1", "u2")], units: units("u1", "u2"), mandatory: ["u1", "u2"] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.order).toEqual(["u1", "u2"]);
    expect(result.plan.conflicts).toEqual([{ code: "EXCLUSION_RECORDED", message: "Units 'u1' and 'u2' are declared exclusive at severity 'warning'", path: ["constraints", "ax:e1"], severity: "warning" }]);
  });

  test("a none-severity exclusion is informational only", () => {
    const result = solve(request({ relations: relations(relation("rel-x", { selection: "exclude", traversal: "one-hop", conflictSeverity: "none" })), edges: [edge("e1", "rel-x", "u1", "u2")], units: units("u1", "u2"), mandatory: ["u1", "u2"] }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.plan.conflicts.map(diagnostic => diagnostic.severity)).toEqual(["info"]);
  });
});

describe("load order and cycles at solve level", () => {
  test("loadOrder 'before' puts the prerequisite ahead of its subject in the plan", () => {
    const result = solve(request({ relations: relations(relation("rel-c", { selection: "closure", traversal: "transitive", loadOrder: "before" })), edges: [edge("e1", "rel-c", "u1", "u2")], units: units("u1", "u2"), mandatory: ["u1"] }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.plan.selected.map(candidate => candidate.unitId)).toEqual(["u2", "u1"]);
  });

  test("cyclePolicy 'reject' makes the plan unsat and the core names the cycle plus its support", () => {
    const result = solve(request({
      relations: relations(relation("rel-c", { selection: "closure", traversal: "transitive", loadOrder: "before", cyclePolicy: "reject" })),
      edges: [edge("e1", "rel-c", "u1", "u2"), edge("e2", "rel-c", "u2", "u1")],
      units: units("u1", "u2"),
      mandatory: ["u1"],
    }));
    expect(result.ok).toBe(false);
    if (result.ok || result.reason !== "unsat") throw new Error("expected an unsatisfiable plan");
    expect(result.blocker).toBe("cycle");
    expect(result.unsatCore.map(entry => entry.kind)).toContain("ordering");
  });

  test("cyclePolicy 'collapse' plans a cyclic selection and reports the contracted component", () => {
    const result = solve(request({
      relations: relations(relation("rel-c", { selection: "closure", traversal: "transitive", loadOrder: "before", cyclePolicy: "collapse" })),
      edges: [edge("e1", "rel-c", "u1", "u2"), edge("e2", "rel-c", "u2", "u1")],
      units: units("u1", "u2"),
      mandatory: ["u1"],
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.collapsedInto).toEqual({ u1: "u1", u2: "u1" });
    expect(result.components.map(component => component.members)).toEqual([["u1", "u2"]]);
  });

  test("cyclePolicy 'allow' plans the same selection without contracting it", () => {
    const result = solve(request({
      relations: relations(relation("rel-c", { selection: "closure", traversal: "transitive", loadOrder: "before", cyclePolicy: "allow" })),
      edges: [edge("e1", "rel-c", "u1", "u2"), edge("e2", "rel-c", "u2", "u1")],
      units: units("u1", "u2"),
      mandatory: ["u1"],
    }));
    expect(result.ok).toBe(true);
    if (result.ok) expect([result.collapsedInto, result.components[0]?.collapsed]).toEqual([{}, false]);
  });
});

describe("soft preferences and budget", () => {
  test("selection 'expand' offers a candidate that is taken when the budget allows", () => {
    const result = solve(request({ relations: relations(relation("rel-e", { selection: "expand", traversal: "transitive" })), edges: [edge("e1", "rel-e", "u1", "u2")], units: units("u1", "u2"), mandatory: ["u1"] }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.order).toEqual(["u1", "u2"]);
  });

  test("an expand chain honours its own traversal budget", () => {
    const edges = [edge("e1", "rel-e", "u1", "u2"), edge("e2", "rel-e", "u2", "u3")];
    const oneHop = solve(request({ relations: relations(relation("rel-e", { selection: "expand", traversal: "one-hop" })), edges, units: units("u1", "u2", "u3"), mandatory: ["u1"] }));
    expect(oneHop.ok).toBe(true);
    if (oneHop.ok) expect(oneHop.order).toEqual(["u1", "u2"]);
    const transitive = solve(request({ relations: relations(relation("rel-e", { selection: "expand", traversal: "transitive" })), edges, units: units("u1", "u2", "u3"), mandatory: ["u1"] }));
    expect(transitive.ok).toBe(true);
    if (transitive.ok) expect(transitive.order).toEqual(["u1", "u2", "u3"]);
  });

  test("the budget rejects the heavier preference and still admits the cheaper one", () => {
    const result = solve(request({
      relations: {},
      edges: [],
      units: units("u1", "u2", "u3"),
      mandatory: ["u1"],
      preferences: [{ unitId: "u2", weight: 10 }, { unitId: "u3", weight: 1 }],
      unitCost: { u1: 5, u2: 5, u3: 1 },
      budget: { maxTokens: 6 },
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.order).toEqual(["u1", "u3"]);
    expect(result.plan.rejections.map(rejection => [rejection.candidate.unitId, rejection.reasons])).toEqual([["u2", ["budget-exhausted"]]]);
    expect(result.plan.budget).toEqual({ maxTokens: 6, consumedTokens: 6 });
  });

  test("a mandatory closure over budget is still selected, with a warning instead of a silent drop", () => {
    const result = solve(request({
      relations: relations(relation("rel-c", { selection: "closure", traversal: "transitive" })),
      edges: [edge("e1", "rel-c", "u1", "u2")],
      units: units("u1", "u2"),
      mandatory: ["u1"],
      unitCost: { u1: 10, u2: 10 },
      budget: { maxTokens: 1 },
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.order).toEqual(["u1", "u2"]);
    expect(result.diagnostics.map(diagnostic => diagnostic.code)).toContain("BUDGET_EXCEEDED_BY_HARD_CONSTRAINTS");
  });
});

describe("runtime policy", () => {
  const policyUnits = [unit("u1"), unit("u2", ["p-1"])];
  const policyRequirements = { "p-1": { capabilities: ["cap-1"], sideEffect: "read" } } as const;

  test("denies a mandatory unit whose policy label the principal cannot satisfy", () => {
    const result = solve(request({ relations: {}, edges: [], units: policyUnits, mandatory: ["u2"], policyRequirements, principal: { capabilities: [], allowedSideEffects: ["read"] } }));
    expect(result.ok).toBe(false);
    if (result.ok || result.reason !== "unsat") throw new Error("expected an unsatisfiable plan");
    expect(result.blocker).toBe("runtime-policy");
    expect(result.unsatCore).toEqual([{ ref: "rp:u2:p-1", kind: "runtime-policy" }]);
  });

  test("admits the same unit once capability and side effect are both granted", () => {
    const granted = solve(request({ relations: {}, edges: [], units: policyUnits, mandatory: ["u2"], policyRequirements, principal: { capabilities: ["cap-1"], allowedSideEffects: ["read"] } }));
    expect(granted.ok).toBe(true);
    const wrongEffect = solve(request({ relations: {}, edges: [], units: policyUnits, mandatory: ["u2"], policyRequirements, principal: { capabilities: ["cap-1"] } }));
    expect(wrongEffect.ok).toBe(false);
  });

  test("a policy-denied soft preference is rejected, not promoted", () => {
    const result = solve(request({ relations: {}, edges: [], units: policyUnits, mandatory: ["u1"], preferences: [{ unitId: "u2", weight: 50 }], policyRequirements, principal: { capabilities: [] } }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.order).toEqual(["u1"]);
    expect(result.plan.rejections.map(rejection => [rejection.candidate.unitId, rejection.reasons[0]])).toEqual([["u2", "runtime-policy-denied"]]);
  });
});

describe("boundaries and determinism", () => {
  test("an empty problem yields an empty plan", () => {
    const result = solve(request({ relations: {}, edges: [], units: [], mandatory: [] }));
    expect(result.ok).toBe(true);
    if (result.ok) expect([result.order, result.plan.selected, result.plan.candidates, result.plan.budget.consumedTokens]).toEqual([[], [], [], 0]);
  });

  test("a single unit with no edges is selected alone", () => {
    const result = solve(request({ relations: {}, edges: [], units: units("u1"), mandatory: ["u1"] }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.plan.selected.map(candidate => [candidate.unitId, candidate.reasons])).toEqual([["u1", ["seed"]]]);
  });

  test("the same problem in a different input order produces a byte-identical plan", () => {
    const relationSet = relations(
      relation("rel-c", { selection: "closure", traversal: "transitive", loadOrder: "before" }),
      relation("rel-e", { selection: "expand", traversal: "one-hop" }),
      relation("rel-x", { selection: "exclude", traversal: "one-hop", conflictSeverity: "warning" }),
    );
    const edges = [edge("e1", "rel-c", "u1", "u2"), edge("e2", "rel-c", "u1", "u3"), edge("e3", "rel-e", "u2", "u4"), edge("e4", "rel-x", "u3", "u4"), edge("e5", "rel-c", "u3", "u5")];
    const all = units("u1", "u2", "u3", "u4", "u5");
    const forward = solve(request({ relations: relationSet, edges, units: all, mandatory: ["u1"], preferences: [{ unitId: "u5", weight: 3 }] }));
    const reversed = solve(request({ relations: relationSet, edges: [...edges].reverse(), units: [...all].reverse(), mandatory: ["u1"], preferences: [{ unitId: "u5", weight: 3 }] }));
    expect(forward.ok && reversed.ok).toBe(true);
    if (!forward.ok || !reversed.ok) return;
    expect(JSON.stringify(reversed.plan)).toBe(JSON.stringify(forward.plan));
  });

  test("an unsat core is identical across input orders, element order included", () => {
    const relationSet = relations(relation("rel-c", { selection: "closure", traversal: "transitive" }), relation("rel-x", { selection: "exclude", traversal: "one-hop", conflictSeverity: "error" }));
    const edges = [edge("e1", "rel-c", "u1", "u2"), edge("e2", "rel-c", "u1", "u3"), edge("e3", "rel-x", "u2", "u3")];
    const all = units("u1", "u2", "u3");
    const forward = solve(request({ relations: relationSet, edges, units: all, mandatory: ["u1"] }));
    const reversed = solve(request({ relations: relationSet, edges: [...edges].reverse(), units: [...all].reverse(), mandatory: ["u1"] }));
    if (forward.ok || forward.reason !== "unsat" || reversed.ok || reversed.reason !== "unsat") throw new Error("expected two unsatisfiable plans");
    expect(reversed.plan.unsatCore).toEqual(forward.plan.unsatCore);
  });

  test("invalid relation semantics stop the solve instead of defaulting a field", () => {
    // The double cast is the subject under test, not a convenience: `RelationDefIR`
    // types a payload that may have come from `JSON.parse`, so the solver must still
    // check a semantics block that only claims to be complete.
    const broken = { name: "rel-b", version: "1.0.0", from: "t-1", to: "t-1", cardinality: "many-to-many", directional: true, semantics: { traversal: "transitive" } } as unknown as RelationDefIR;
    const result = solve(request({ relations: { "rel-b": broken }, edges: [edge("e1", "rel-b", "u1", "u2")], units: units("u1", "u2"), mandatory: ["u1"] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid-input");
  });
});
