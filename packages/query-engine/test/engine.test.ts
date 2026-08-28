import { describe, expect, test } from "bun:test";
import type { GraphIR } from "@skill-wiki/ir";
import {
  CandidateGeneratorRegistry,
  QueryEngineError,
  createLexicalGenerator,
  planSelection,
  type QueryRequest,
} from "../src/index.ts";
import { anyPrincipal, clearedPrincipal, contextFor, corpusA, registryFor } from "./support/harness.ts";
import { domainA } from "./support/model.ts";

const generators = registryFor(domainA);

function request(overrides: Partial<QueryRequest>): QueryRequest {
  return {
    requestId: "req-1",
    profile: domainA.profile.name,
    principal: anyPrincipal,
    maxTokens: 1000,
    ...overrides,
  };
}

function plan(overrides: Partial<QueryRequest>, corpus: GraphIR = corpusA()) {
  return planSelection(request(overrides), contextFor(domainA, corpus), { generators });
}

describe("plan shape", () => {
  test("every SelectionPlanIR field is populated, not stubbed", () => {
    const result = plan({ text: "login submit", seeds: ["I1"], facets: [{ kind: "typeRef", anyOf: ["Issue"] }] });

    expect(result.requestId).toBe("req-1");
    expect(result.snapshot).toEqual(corpusA().snapshot);
    expect(result.query.profile).toBe("triage");
    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.selected.length).toBeGreaterThan(0);
    expect(result.rejections.length).toBeGreaterThan(0);
    expect(result.relationExpansions.length).toBeGreaterThan(0);
    expect(result.conflicts.length).toBeGreaterThan(0);
    expect(result.budget.maxTokens).toBe(1000);
    expect(result.budget.consumedTokens).toBeGreaterThan(0);
    expect(result.projectionLoads.length).toBeGreaterThan(0);
    expect(result.rationale?.length).toBeGreaterThan(0);
  });

  test("every rejection carries at least one real reason", () => {
    const result = plan({ text: "login submit", seeds: ["I1"], limit: 2 });
    expect(result.rejections.length).toBeGreaterThan(0);
    for (const rejection of result.rejections) {
      expect(rejection.reasons.length).toBeGreaterThan(0);
      for (const reason of rejection.reasons) expect(reason.length).toBeGreaterThan(0);
    }
  });

  test("every selected candidate carries a per-axis breakdown", () => {
    const result = plan({ text: "login", facets: [{ kind: "typeRef", anyOf: ["Issue"] }], seeds: ["I1"] });
    const scored = result.selected.filter(c => c.score > 0);
    expect(scored.length).toBeGreaterThan(0);
    for (const candidate of scored) {
      expect(Object.keys(candidate.featureValues).length).toBeGreaterThan(0);
      expect(candidate.reasons.length).toBeGreaterThan(0);
    }
  });

  test("the query echo omits nothing the caller supplied and sorts what it echoes", () => {
    const result = plan({
      text: "login",
      seeds: ["I5", "I1"],
      limit: 3,
      fallbackProjections: ["brief"],
      lifecycles: ["active"],
    });
    expect(result.query.seeds).toEqual(["I1", "I5"]);
    expect(result.query.limit).toBe(3);
    expect(result.query.fallbackProjections).toEqual(["brief"]);
    expect(Object.keys(result.query)).toEqual([...Object.keys(result.query)].sort());
  });
});

describe("ACL is enforced before generation and never leaks", () => {
  test("a plan for an uncleared principal contains the denied id nowhere at all", () => {
    const result = plan({ text: "login credentials", seeds: ["I1"] });
    expect(JSON.stringify(result)).not.toContain("I6");
    expect(result.rationale?.some(d => d.code === "ADMISSION_ACL_FILTERED")).toBe(true);
  });

  test("a closure cannot drag in a unit the principal may not see", () => {
    // I1 --blocked-by--> I6 exists in the corpus, and blocked-by is a closure.
    const uncleared = plan({ seeds: ["I1"], text: "login" });
    expect(uncleared.relationExpansions.flatMap(e => e.discovered)).not.toContain("I6");

    const cleared = planSelection(
      request({ seeds: ["I1"], text: "login", principal: clearedPrincipal }),
      contextFor(domainA, corpusA()),
      { generators },
    );
    expect(cleared.relationExpansions.flatMap(e => e.discovered)).toContain("I6");
  });

  test("an ACL-denied unit does not shift the lexical scores of the units that remain", () => {
    // If admission ran after generation, I6's tokens would be in the IDF table for
    // both principals and the shared units would score identically. Because it runs
    // first, the two principals see different corpora and therefore different IDF —
    // the divergence is the evidence that the filter is early.
    const uncleared = plan({ text: "login" });
    const clearedPlan = planSelection(
      request({ text: "login", principal: clearedPrincipal }),
      contextFor(domainA, corpusA()),
      { generators },
    );
    const shared = uncleared.candidates.find(c => c.unitId === "I1")!;
    const same = clearedPlan.candidates.find(c => c.unitId === "I1")!;
    expect(same.featureValues).not.toEqual(shared.featureValues);
  });
});

describe("relation semantics reach the plan", () => {
  test("a closure relation contributes relationExpansions and load order", () => {
    const result = plan({ seeds: ["I1"], text: "login" });
    const expansion = result.relationExpansions.find(e => e.relationRef === "blocked-by");
    expect(expansion?.discovered).toContain("I5");
    const ordered = result.projectionLoads.flatMap(load => load.unitIds);
    expect(ordered.indexOf("I5")).toBeLessThan(ordered.indexOf("I1"));
  });

  test("an exclude relation with conflictSeverity 'error' drops the weaker side and says why", () => {
    const result = plan({ text: "login page crashes on submit again" });
    const conflict = result.conflicts.find(d => d.code === "RELATION_EXCLUSION");
    expect(conflict?.severity).toBe("error");
    expect(conflict?.message).toContain("duplicate-of");

    const selectedIds = result.selected.map(c => c.unitId);
    expect(selectedIds.includes("I1") && selectedIds.includes("I4")).toBe(false);
    const dropped = result.rejections.find(r => r.reasons.some(x => x.includes("excluded by relation")));
    expect(dropped?.reasons[0]).toContain("conflicts with higher-ranked");
  });

  test("a unit below the rank cutoff that a relation requires is reinstated, not rejected twice", () => {
    const result = plan({ seeds: ["I1"], text: "login", limit: 1 });
    const ids = result.selected.map(c => c.unitId);
    expect(ids).toContain("I5");
    expect(result.rejections.map(r => r.candidate.unitId)).not.toContain("I5");
    const reinstated = result.selected.find(c => c.unitId === "I5")!;
    expect(reinstated.reasons.some(r => r.includes("pulled in by relation"))).toBe(true);
  });
});

describe("budget", () => {
  test("a tight budget drops units and reports the arithmetic", () => {
    const result = plan({ text: "login submit", maxTokens: 130 });
    expect(result.budget.consumedTokens).toBeLessThanOrEqual(130);
    const budgetRejection = result.rejections.find(r =>
      r.reasons.some(reason => reason.includes("token budget exhausted")),
    );
    expect(budgetRejection?.reasons[0]).toContain("of 130 remain");
  });

  test("a fallback projection keeps a unit that the primary projection could not fit", () => {
    const withFallback = plan({ text: "login submit", maxTokens: 150, fallbackProjections: ["brief"] });
    const withoutFallback = plan({ text: "login submit", maxTokens: 150 });
    expect(withFallback.selected.length).toBeGreaterThan(withoutFallback.selected.length);
    expect(withFallback.projectionLoads.map(l => l.projectionRef)).toContain("brief");
  });

  test("projectionLoads cover exactly the selected units, in load order", () => {
    const result = plan({ text: "login submit", seeds: ["I1"] });
    expect(result.projectionLoads.flatMap(l => l.unitIds)).toEqual(result.selected.map(c => c.unitId));
  });
});

describe("determinism", () => {
  function shuffled(corpus: GraphIR): GraphIR {
    return {
      ...corpus,
      units: [...corpus.units].reverse(),
      edges: [...corpus.edges].reverse(),
    };
  }

  test("the same snapshot and request serialize to identical bytes", () => {
    const args = { text: "login submit auth", seeds: ["I1"], facets: [{ kind: "typeRef" as const, anyOf: ["Issue"] }] };
    const first = JSON.stringify(plan(args));
    for (let attempt = 0; attempt < 5; attempt += 1) expect(JSON.stringify(plan(args))).toBe(first);
  });

  test("corpus insertion order does not change a single byte of the plan", () => {
    const args = { text: "login submit auth", seeds: ["I1"], facets: [{ kind: "typeRef" as const, anyOf: ["Issue"] }] };
    expect(JSON.stringify(plan(args, shuffled(corpusA())))).toBe(JSON.stringify(plan(args, corpusA())));
  });

  test("record key order is sorted, so serialization cannot depend on discovery order", () => {
    const result = plan({ text: "login submit", facets: [{ kind: "typeRef", anyOf: ["Issue"] }], seeds: ["I1"] });
    for (const candidate of result.candidates) {
      expect(Object.keys(candidate.featureValues)).toEqual([...Object.keys(candidate.featureValues)].sort());
    }
  });

  test("scores are quantized, so a float tail cannot decide a ranking", () => {
    const result = plan({ text: "login submit auth", seeds: ["I1"] });
    for (const candidate of result.candidates) {
      expect(candidate.score).toBe(Math.round(candidate.score * 1e6) / 1e6);
      for (const value of Object.values(candidate.featureValues)) {
        expect(value).toBe(Math.round(value * 1e6) / 1e6);
      }
    }
  });
});

describe("error paths", () => {
  test("an empty requestId is rejected", () => {
    expect(() => plan({ requestId: "" })).toThrow(/REQUEST_ID_EMPTY/);
  });

  test("an unknown profile names the declared ones", () => {
    try {
      plan({ profile: "nope" });
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(QueryEngineError);
      expect((error as QueryEngineError).message).toContain("triage");
    }
  });

  test("a profile with no feature weights cannot rank anything and is refused", () => {
    const empty = { ...domainA.profile, name: "empty", features: {} };
    expect(() =>
      planSelection(request({ profile: "empty" }), {
        ...contextFor(domainA, corpusA()),
        profiles: { empty },
      }, { generators }),
    ).toThrow(/PROFILE_NO_FEATURES/);
  });

  test("a non-positive budget is refused", () => {
    expect(() => plan({ maxTokens: 0 })).toThrow(/BUDGET_INVALID/);
  });

  test("a profile naming an unregistered generator is refused", () => {
    const lonely = new CandidateGeneratorRegistry().register(
      createLexicalGenerator({ name: "lexical", featureAxis: "textMatch" }),
    );
    expect(() =>
      planSelection(request({ text: "login" }), contextFor(domainA, corpusA()), { generators: lonely }),
    ).toThrow(/GENERATOR_NOT_REGISTERED/);
  });

  test("an empty corpus yields an empty but well-formed plan", () => {
    const result = plan({ text: "login" }, { ...corpusA(), units: [], edges: [] });
    expect(result.candidates).toEqual([]);
    expect(result.selected).toEqual([]);
    expect(result.projectionLoads).toEqual([]);
    expect(result.budget.consumedTokens).toBe(0);
  });
});
