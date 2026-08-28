import { describe, expect, test } from "bun:test";
import { UNDECLARED_LABEL_CAPABILITY, deriveConstraints } from "../src/index.ts";
import { edge, relation, relations, unit } from "./support.ts";

const twoUnits = [unit("u1"), unit("u2")];

describe("constraint derivation from semantics alone", () => {
  test("selection 'closure' yields a hard requirement, 'expand' a soft preference", () => {
    const result = deriveConstraints({
      relations: relations(relation("rel-c", { selection: "closure", traversal: "transitive" }), relation("rel-e", { selection: "expand", traversal: "one-hop" })),
      edges: [edge("e1", "rel-c", "u1", "u2"), edge("e2", "rel-e", "u1", "u2")],
      units: twoUnits,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.constraints.hardRequirements).toEqual([{ kind: "hard-requirement", ref: "hr:e1", relationRef: "rel-c", edgeId: "e1", subject: "u1", target: "u2", traversal: "transitive" }]);
    expect(result.constraints.softPreferences).toEqual([{ kind: "soft-preference", ref: "sp:e2", relationRef: "rel-e", edgeId: "e2", subject: "u1", target: "u2", weight: 1 }]);
  });

  test("selection 'exclude' splits on conflictSeverity: error is hard, warning and none are advisory", () => {
    const result = deriveConstraints({
      relations: relations(
        relation("rel-x1", { selection: "exclude", traversal: "one-hop", conflictSeverity: "error" }),
        relation("rel-x2", { selection: "exclude", traversal: "one-hop", conflictSeverity: "warning" }),
        relation("rel-x3", { selection: "exclude", traversal: "one-hop", conflictSeverity: "none" }),
      ),
      edges: [edge("e1", "rel-x1", "u2", "u1"), edge("e2", "rel-x2", "u1", "u2"), edge("e3", "rel-x3", "u2", "u1")],
      units: twoUnits,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Endpoints are stored sorted, so an exclusion is direction-free even though the edge is not.
    expect(result.constraints.hardProhibitions).toEqual([{ kind: "hard-prohibition", ref: "hp:e1", relationRef: "rel-x1", edgeId: "e1", left: "u1", right: "u2" }]);
    expect(result.constraints.advisories.map(item => [item.ref, item.severity, item.left, item.right])).toEqual([["ax:e2", "warning", "u1", "u2"], ["ax:e3", "none", "u1", "u2"]]);
  });

  test("selection 'informational' derives nothing at all", () => {
    const result = deriveConstraints({ relations: relations(relation("rel-i", { selection: "informational", traversal: "transitive" })), edges: [edge("e1", "rel-i", "u1", "u2")], units: twoUnits });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([result.constraints.hardRequirements.length, result.constraints.hardProhibitions.length, result.constraints.softPreferences.length, result.constraints.orderings.length, result.constraints.advisories.length]).toEqual([0, 0, 0, 0, 0]);
  });

  test("traversal 'none' makes closure and expand inert, with a diagnostic instead of a silent drop", () => {
    const result = deriveConstraints({
      relations: relations(relation("rel-c", { selection: "closure", traversal: "none" }), relation("rel-e", { selection: "expand", traversal: "none" })),
      edges: [edge("e1", "rel-c", "u1", "u2"), edge("e2", "rel-e", "u1", "u2")],
      units: twoUnits,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.constraints.hardRequirements).toEqual([]);
    expect(result.constraints.softPreferences).toEqual([]);
    expect(result.diagnostics.map(diagnostic => diagnostic.code)).toEqual(["SELECTION_WITHOUT_TRAVERSAL", "SELECTION_WITHOUT_TRAVERSAL"]);
  });

  test("loadOrder 'before' points at the prerequisite while 'after' keeps edge direction", () => {
    const result = deriveConstraints({
      relations: relations(relation("rel-b", { loadOrder: "before" }), relation("rel-a", { loadOrder: "after" }), relation("rel-n", { loadOrder: "none" })),
      edges: [edge("e1", "rel-b", "u1", "u2"), edge("e2", "rel-a", "u1", "u2"), edge("e3", "rel-n", "u1", "u2")],
      units: twoUnits,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.constraints.orderings.map(item => [item.ref, item.before, item.after])).toEqual([["ord:e2", "u1", "u2"], ["ord:e1", "u2", "u1"]]);
  });

  test("an edge weight attribute overrides the default expansion weight", () => {
    const result = deriveConstraints({
      relations: relations(relation("rel-e", { selection: "expand", traversal: "one-hop" })),
      edges: [edge("e1", "rel-e", "u1", "u2", { weight: 7.5 })],
      units: twoUnits,
      defaultExpansionWeight: 2,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.constraints.softPreferences[0]?.weight).toBe(7.5);
  });

  test("fails closed on a duplicate edge id, an unresolved relation and a non-finite weight", () => {
    const duplicate = deriveConstraints({ relations: relations(relation("rel-c", { selection: "closure", traversal: "transitive" })), edges: [edge("e1", "rel-c", "u1", "u2"), edge("e1", "rel-c", "u2", "u1")], units: twoUnits });
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.diagnostics.map(diagnostic => diagnostic.code)).toContain("EDGE_ID_DUPLICATE");
    const unresolved = deriveConstraints({ relations: {}, edges: [edge("e1", "rel-missing", "u1", "u2")], units: twoUnits });
    expect(unresolved.ok).toBe(false);
    if (!unresolved.ok) expect(unresolved.diagnostics.map(diagnostic => diagnostic.code)).toEqual(["EDGE_RELATION_UNRESOLVED"]);
    const badWeight = deriveConstraints({ relations: relations(relation("rel-e", { selection: "expand", traversal: "one-hop" })), edges: [edge("e1", "rel-e", "u1", "u2", { weight: "heavy" })], units: twoUnits });
    expect(badWeight.ok).toBe(false);
    if (!badWeight.ok) expect(badWeight.diagnostics.map(diagnostic => diagnostic.code)).toEqual(["EDGE_WEIGHT_INVALID"]);
    const badPreference = deriveConstraints({ relations: {}, edges: [], units: twoUnits, requestPreferences: [{ unitId: "u1", weight: Number.NaN }] });
    expect(badPreference.ok).toBe(false);
    if (!badPreference.ok) expect(badPreference.diagnostics.map(diagnostic => diagnostic.code)).toEqual(["PREFERENCE_WEIGHT_INVALID"]);
  });

  test("a policy label denies by default when no requirement is declared for it", () => {
    const denied = deriveConstraints({ relations: {}, edges: [], units: [unit("u1", ["p-x"])] });
    expect(denied.ok).toBe(true);
    if (!denied.ok) return;
    expect(denied.constraints.runtimePolicies).toEqual([{ kind: "runtime-policy", ref: "rp:u1:p-x", target: "u1", label: "p-x", capabilities: [UNDECLARED_LABEL_CAPABILITY], sideEffect: "none" }]);
    const ignored = deriveConstraints({ relations: {}, edges: [], units: [unit("u1", ["p-x"])], undeclaredPolicyLabels: "ignore" });
    expect(ignored.ok).toBe(true);
    if (ignored.ok) expect(ignored.constraints.runtimePolicies).toEqual([]);
    const declared = deriveConstraints({ relations: {}, edges: [], units: [unit("u1", ["p-x"])], policyRequirements: { "p-x": { capabilities: ["cap-b", "cap-a"], sideEffect: "read" } } });
    expect(declared.ok).toBe(true);
    if (declared.ok) expect(declared.constraints.runtimePolicies[0]).toEqual({ kind: "runtime-policy", ref: "rp:u1:p-x", target: "u1", label: "p-x", capabilities: ["cap-a", "cap-b"], sideEffect: "read" });
  });
});
