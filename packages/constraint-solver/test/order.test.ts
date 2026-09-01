import { describe, expect, test } from "bun:test";
import type { OrderingObligation } from "../src/index.ts";
import { planLoadOrder } from "../src/index.ts";
import type { CyclePolicyIR } from "@aoe/ir";

function ordering(ref: string, before: string, after: string, cyclePolicy: CyclePolicyIR = "allow", relationRef = "rel-o"): OrderingObligation {
  return { kind: "ordering", ref, relationRef, edgeId: ref.replace("ord:", ""), before, after, cyclePolicy };
}

describe("load order", () => {
  test("orders an acyclic chain and ignores obligations that leave the selected set", () => {
    const result = planLoadOrder(["u1", "u2", "u3"], [ordering("ord:e1", "u3", "u2"), ordering("ord:e2", "u2", "u1"), ordering("ord:e3", "u9", "u1")]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.order).toEqual(["u3", "u2", "u1"]);
  });

  test("empty and single-node inputs are ordered without diagnostics", () => {
    const empty = planLoadOrder([], []);
    expect(empty.ok).toBe(true);
    if (empty.ok) expect([empty.order, empty.components, empty.diagnostics]).toEqual([[], [], []]);
    const single = planLoadOrder(["u1"], []);
    expect(single.ok).toBe(true);
    if (single.ok) expect([single.order, single.components.map(component => [component.key, component.cyclic, component.collapsed])]).toEqual([["u1"], [["u1", false, false]]]);
  });

  test("cyclePolicy 'reject' fails with the refs inside the cycle and nothing else", () => {
    const result = planLoadOrder(["u1", "u2", "u3"], [ordering("ord:e1", "u1", "u2", "reject"), ordering("ord:e2", "u2", "u1", "reject"), ordering("ord:e3", "u2", "u3", "reject")]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.cycle.members).toEqual(["u1", "u2"]);
    expect(result.cycle.refs).toEqual(["ord:e1", "ord:e2"]);
    expect(result.diagnostics.at(-1)?.code).toBe("CYCLE_REJECTED");
  });

  test("cyclePolicy 'allow' keeps the cycle as one component without collapsing it", () => {
    const result = planLoadOrder(["u1", "u2", "u3"], [ordering("ord:e1", "u1", "u2", "allow"), ordering("ord:e2", "u2", "u1", "allow"), ordering("ord:e3", "u2", "u3", "allow")]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.order).toEqual(["u1", "u2", "u3"]);
    expect(result.components.map(component => [component.key, component.members, component.cyclic, component.collapsed])).toEqual([["u1", ["u1", "u2"], true, false], ["u3", ["u3"], false, false]]);
    expect(result.collapsedInto).toEqual({});
    expect(result.diagnostics.map(diagnostic => diagnostic.code)).toEqual(["CYCLE_ALLOWED"]);
  });

  test("cyclePolicy 'collapse' contracts the SCC into one node that downstream units follow", () => {
    const result = planLoadOrder(["u1", "u2", "u3", "u4"], [ordering("ord:e1", "u1", "u2", "collapse"), ordering("ord:e2", "u2", "u3", "collapse"), ordering("ord:e3", "u3", "u1", "collapse"), ordering("ord:e4", "u2", "u4", "collapse")]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.order).toEqual(["u1", "u2", "u3", "u4"]);
    expect(result.components.map(component => [component.key, component.members, component.collapsed])).toEqual([["u1", ["u1", "u2", "u3"], true], ["u4", ["u4"], false]]);
    expect(result.collapsedInto).toEqual({ u1: "u1", u2: "u1", u3: "u1" });
    expect(result.diagnostics.map(diagnostic => diagnostic.code)).toEqual(["CYCLE_COLLAPSED"]);
  });

  test("a self-loop counts as a cycle for every policy", () => {
    expect(planLoadOrder(["u1"], [ordering("ord:e1", "u1", "u1", "reject")]).ok).toBe(false);
    const collapsed = planLoadOrder(["u1"], [ordering("ord:e1", "u1", "u1", "collapse")]);
    expect(collapsed.ok).toBe(true);
    if (collapsed.ok) expect([collapsed.components[0]?.cyclic, collapsed.collapsedInto]).toEqual([true, { u1: "u1" }]);
  });

  test("the most conservative policy in one SCC wins over the laxest", () => {
    const rejects = planLoadOrder(["u1", "u2"], [ordering("ord:e1", "u1", "u2", "allow", "rel-a"), ordering("ord:e2", "u2", "u1", "reject", "rel-b")]);
    expect(rejects.ok).toBe(false);
    if (!rejects.ok) expect(rejects.cycle.relationRefs).toEqual(["rel-a", "rel-b"]);
    const collapses = planLoadOrder(["u1", "u2"], [ordering("ord:e1", "u1", "u2", "allow", "rel-a"), ordering("ord:e2", "u2", "u1", "collapse", "rel-b")]);
    expect(collapses.ok).toBe(true);
    if (collapses.ok) expect(collapses.components[0]?.collapsed).toBe(true);
  });

  test("component order does not depend on obligation input order", () => {
    const obligations = [ordering("ord:e1", "u3", "u2"), ordering("ord:e2", "u2", "u1"), ordering("ord:e3", "u5", "u4")];
    const forward = planLoadOrder(["u1", "u2", "u3", "u4", "u5"], obligations);
    const reversed = planLoadOrder(["u5", "u4", "u3", "u2", "u1"], [...obligations].reverse());
    expect(forward.ok && reversed.ok).toBe(true);
    if (forward.ok && reversed.ok) expect(forward.order).toEqual(reversed.order);
  });
});
