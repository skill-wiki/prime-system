import { describe, expect, test } from "bun:test";
import { admit, type QueryRequest } from "../src/index.ts";
import { anyPrincipal, clearedPrincipal, corpusA } from "./support/harness.ts";
import { domainA } from "./support/model.ts";

function request(overrides: Partial<QueryRequest>): QueryRequest {
  return {
    requestId: "r1",
    profile: domainA.profile.name,
    principal: anyPrincipal,
    maxTokens: 1000,
    ...overrides,
  };
}

describe("admission", () => {
  test("removes a unit the principal is not cleared for", () => {
    const result = admit(corpusA(), request({}));
    expect(result.graph.units.map(u => u.identity.id)).not.toContain("I6");
    expect(result.aclDeniedCount).toBe(1);
  });

  test("never names an ACL-denied unit, because that is the identifier being withheld", () => {
    const result = admit(corpusA(), request({}));
    expect(result.filtered.map(f => f.unitId)).not.toContain("I6");
    expect(JSON.stringify(result.filtered)).not.toContain("I6");
  });

  test("admits the same unit for a cleared principal", () => {
    const result = admit(corpusA(), request({ principal: clearedPrincipal }));
    expect(result.graph.units.map(u => u.identity.id)).toContain("I6");
    expect(result.aclDeniedCount).toBe(0);
  });

  test("a granted visibility is not enough without the label grant", () => {
    const result = admit(
      corpusA(),
      request({
        principal: { id: "half", allowedVisibility: ["public", "shared", "private"], grantedPolicyLabels: [] },
      }),
    );
    expect(result.graph.units.map(u => u.identity.id)).not.toContain("I6");
    expect(result.aclDeniedCount).toBe(1);
  });

  test("drops every edge touching a denied unit so expansion cannot walk back in", () => {
    const result = admit(corpusA(), request({}));
    expect(corpusA().edges.some(e => e.to === "I6")).toBe(true);
    expect(result.graph.edges.some(e => e.from === "I6" || e.to === "I6")).toBe(false);
    for (const unit of result.graph.units) {
      expect(unit.relations.some(e => e.from === "I6" || e.to === "I6")).toBe(false);
    }
  });

  test("request-side lifecycle filtering is reported with unit ids, unlike ACL", () => {
    const result = admit(corpusA(), request({ lifecycles: ["draft"] }));
    expect(result.graph.units).toEqual([]);
    expect(result.filtered.map(f => f.unitId)).toEqual(["I1", "I2", "I3", "I4", "I5", "N1"]);
    expect(result.filtered[0]!.reasons[0]).toContain("lifecycle 'active'");
  });

  test("a hard facet excludes before scoring and says which facet", () => {
    const result = admit(corpusA(), request({ requiredFacets: [{ kind: "typeRef", anyOf: ["Note"] }] }));
    expect(result.graph.units.map(u => u.identity.id)).toEqual(["N1"]);
    const issue = result.filtered.find(f => f.unitId === "I1");
    expect(issue?.reasons[0]).toContain("required facet unsatisfied");
  });

  test("scrubs denied ids out of the graph indexes as well", () => {
    const corpus = corpusA();
    const withIndex = { ...corpus, indexes: { byLabel: ["I1", "I6"] } };
    const result = admit(withIndex, request({}));
    expect(result.graph.indexes.byLabel).toEqual(["I1"]);
  });
});
