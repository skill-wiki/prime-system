/**
 * End-to-end `query -> plan` over the real `security-model` fixture, and the
 * query-engine <-> constraint-solver handoff decided in D-2.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { degradeToFit, planSelection, planWithConstraints, toRelationDefIR, type QueryRequest } from "../src/index.ts";
import { loadSecurityModel, securityRegistry, type SecurityModel } from "./support/security-model.ts";

let model: SecurityModel;
const generators = securityRegistry();

const MFA = "@sec/control-multi-factor";
const IDP = "@sec/control-identity-provider";

beforeAll(() => {
  model = loadSecurityModel();
});

function request(overrides: Partial<QueryRequest>): QueryRequest {
  return {
    requestId: "audit-1",
    profile: "audit-default",
    principal: { id: "auditor", allowedVisibility: ["public", "shared"], grantedPolicyLabels: [] },
    maxTokens: 1000,
    ...overrides,
  };
}

describe("the fixture is a real model package, loaded through the real loaders", () => {
  test("declares the relations, projections and profile the engine consumes", () => {
    expect(Object.keys(model.relations).sort()).toEqual([
      "assesses",
      "depends-on",
      "endangers",
      "evidenced-by",
      "guards",
      "incompatible-with",
      "mitigated-by",
      "mitigates",
    ]);
    expect(Object.keys(model.projections).sort()).toEqual(["core", "full", "summary"]);
    expect(model.profiles["audit-default"]!.features).toEqual({
      lexicalScore: 0.5,
      graphAffinity: 0.2,
      severityWeight: 0.3,
    });
    expect(model.graph.units.length).toBeGreaterThan(5);
  });

  test("the corpus publishes measured tokens per projection, so the budget is not notional", () => {
    expect(model.tokenCost(MFA, "summary")).toBe(24);
    expect(model.tokenCost(MFA, "core")).toBe(62);
    expect(model.tokenCost(MFA, "full")).toBe(140);
  });
});

describe("query -> plan over the security model", () => {
  test("the profile's three axes all get produced, with no unweighted or unproduced axis", () => {
    const plan = planSelection(
      request({ text: "credential stuffing authentication", seeds: [MFA] }),
      model.context,
      { generators },
    );
    const produced = new Set(plan.candidates.flatMap(candidate => Object.keys(candidate.featureValues)));
    expect([...produced].sort()).toEqual(["graphAffinity", "lexicalScore", "severityWeight"]);
    const codes = (plan.rationale ?? []).map(d => d.code);
    expect(codes).not.toContain("FEATURE_AXIS_UNWEIGHTED");
    expect(codes).not.toContain("FEATURE_AXIS_UNPRODUCED");
  });

  test("`depends-on` (transitive closure, loadOrder before) puts dependencies ahead of their dependent", () => {
    const plan = planSelection(request({ seeds: [MFA], text: "verification factor" }), model.context, {
      generators,
    });
    const expansion = plan.relationExpansions.find(entry => entry.relationRef === "depends-on");
    expect(expansion?.from).toBe(MFA);
    expect(expansion?.discovered).toContain(IDP);
    const ordered = plan.projectionLoads.flatMap(load => load.unitIds);
    expect(ordered.indexOf(IDP)).toBeLessThan(ordered.indexOf(MFA));
  });

  test("`assesses` and `endangers` declare `informational`, so they never widen the selection", () => {
    const plan = planSelection(request({ seeds: [MFA], text: "verification" }), model.context, { generators });
    for (const relationRef of ["assesses", "endangers"]) {
      expect(plan.relationExpansions.some(entry => entry.relationRef === relationRef)).toBe(false);
    }
  });

  test("the plan is byte-deterministic over the real corpus", () => {
    const args = { text: "credential stuffing identity provider", seeds: [MFA] };
    const first = JSON.stringify(planSelection(request(args), model.context, { generators }));
    expect(JSON.stringify(planSelection(request(args), model.context, { generators }))).toBe(first);
  });
});

describe("constraint-solver handoff", () => {
  test("relations reach the solver as RelationDefIR with the five semantics fields intact", () => {
    const asIR = toRelationDefIR(model.relations);
    expect(asIR["depends-on"]!.semantics).toEqual({
      traversal: "transitive",
      selection: "closure",
      loadOrder: "before",
      cyclePolicy: "reject",
      conflictSeverity: "none",
    });
    // `cardinality` / `directional` / `inverse` now have a home in RelationDefIR
    // (D-3), so the model's own declaration reaches the solver instead of being
    // dropped here. `incompatible-with` declares itself non-directional, which is
    // why treating its endpoints as an unordered pair is the model's statement and
    // no longer the conversion's guess.
    expect(asIR["incompatible-with"]!.directional).toBe(false);
    expect(asIR["depends-on"]!.directional).toBe(true);
    expect(asIR["incompatible-with"]!.cardinality).toBe("many-to-many");
    expect(asIR["evidenced-by"]!.cardinality).toBe("one-to-many");
    expect(asIR["mitigates"]!.inverse).toBe("mitigated-by");
    expect(asIR["depends-on"]!.inverse).toBeUndefined();
    // `aliases` stays dropped on purpose: the loader resolves a spelling before an
    // edge exists, so carrying it would invite a consumer to resolve names twice.
    expect("aliases" in asIR["incompatible-with"]!).toBe(false);
  });

  test("the solver decides membership and order; this package fills projectionLoads", () => {
    const result = planWithConstraints(
      request({ text: "verification factor", seeds: [MFA] }),
      model.context,
      { generators, mandatory: [MFA] },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.order).toContain(MFA);
    expect(result.order).toContain(IDP);
    // The solver leaves projectionLoads empty by contract; a filled one is proof
    // the projection layer ran.
    expect(result.plan.projectionLoads.length).toBeGreaterThan(0);
    expect(result.plan.projectionLoads.flatMap(load => load.unitIds)).toEqual([...result.order]);
    expect(result.plan.budget.consumedTokens).toBeGreaterThan(0);
  });

  test("candidates keep BOTH the retrieval breakdown and the solver's membership ground", () => {
    const result = planWithConstraints(
      request({ text: "credential stuffing", seeds: [MFA] }),
      model.context,
      { generators, mandatory: [MFA] },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const scored = result.plan.selected.find(candidate => "lexicalScore" in candidate.featureValues);
    expect(scored).toBeDefined();
    // Retrieval ground (this package) and membership ground (the solver) coexist.
    expect(scored!.reasons.some(reason => reason.startsWith("lexical:"))).toBe(true);
    expect(
      scored!.reasons.some(reason => ["seed", "hard-requirement", "soft-preference"].includes(reason)),
    ).toBe(true);
  });

  test("ACL runs once, before the solver, so a withheld unit is never a hard target", () => {
    const restricted = {
      ...model.context,
      graph: {
        ...model.graph,
        units: model.graph.units.map(unit =>
          unit.identity.id === IDP ? { ...unit, visibility: "private" as const } : unit,
        ),
      },
    };
    const result = planWithConstraints(
      request({ text: "verification factor", seeds: [MFA] }),
      restricted,
      { generators, mandatory: [MFA] },
    );
    // The dependency is gone with its edges, so the closure is satisfiable rather
    // than unsat-on-a-unit-the-principal-may-not-see, and the id never appears.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.stringify(result.plan)).not.toContain(IDP);
    expect((result.plan.rationale ?? []).some(d => d.code === "ADMISSION_ACL_FILTERED")).toBe(true);
  });
});

describe("D-2: budget is resolved by projection degradation, never by dropping units", () => {
  const chain = ["full", "core", "summary"] as const;

  test("a roomy budget keeps the richest tier", () => {
    const ordered = [IDP, MFA];
    const result = degradeToFit(ordered, chain, 10_000, model.projections, model.tokenCost);
    expect(result.handoff.state).toBe("within-budget");
    expect(result.assignments.every(assignment => assignment.projectionRef === "full")).toBe(true);
  });

  test("a tight budget degrades the tier and keeps every unit", () => {
    const ordered = [IDP, MFA];
    // full = 130 + 140 = 270; core = 58 + 62 = 120.
    const result = degradeToFit(ordered, chain, 150, model.projections, model.tokenCost);
    expect(result.handoff.state).toBe("degraded-to-fit");
    expect(result.assignments.map(assignment => assignment.unitId)).toEqual(ordered);
    expect(result.handoff.consumedTokens).toBeLessThanOrEqual(150);
    expect(result.diagnostics.map(d => d.code)).toContain("BUDGET_PROJECTION_DEGRADED");
  });

  test("leftover budget is spent upgrading units back up the chain, in load order", () => {
    const ordered = [IDP, MFA];
    // core = 120, and 130 + 62 = 192 <= 200, so the first unit in load order is
    // upgraded to `full` while the second stays on `core`.
    const result = degradeToFit(ordered, chain, 200, model.projections, model.tokenCost);
    expect(result.assignments).toEqual([
      { unitId: IDP, projectionRef: "full", tokens: 130 },
      { unitId: MFA, projectionRef: "core", tokens: 62 },
    ]);
    expect(result.handoff.consumedTokens).toBe(192);
  });

  test("below the cheapest tier it reports an explicit over-budget state, not unsat, and drops nothing", () => {
    const ordered = [IDP, MFA];
    // summary = 22 + 24 = 46, against a budget of 30.
    const result = degradeToFit(ordered, chain, 30, model.projections, model.tokenCost);
    expect(result.handoff.state).toBe("exceeded-at-cheapest-projection");
    expect(result.handoff.shortfall).toBe(16);
    expect(result.assignments.map(assignment => assignment.unitId)).toEqual(ordered);
    const blocking = result.diagnostics.find(d => d.code === "BUDGET_EXCEEDED_AT_CHEAPEST_PROJECTION");
    expect(blocking?.severity).toBe("error");
  });

  test("through the full pipeline the over-budget state lands in `conflicts`, where a caller cannot skim it", () => {
    const result = planWithConstraints(
      request({ text: "verification factor", seeds: [MFA], maxTokens: 20, fallbackProjections: ["core", "summary"] }),
      model.context,
      { generators, mandatory: [MFA] },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.handoff.state).toBe("exceeded-at-cheapest-projection");
    expect(result.handoff.shortfall).toBeGreaterThan(0);
    // Membership survived: the mandatory unit is still selected and still loaded.
    expect(result.plan.selected.map(candidate => candidate.unitId)).toContain(MFA);
    expect(result.plan.projectionLoads.flatMap(load => load.unitIds)).toContain(MFA);
    expect(result.plan.conflicts.some(d => d.code === "BUDGET_EXCEEDED_AT_CHEAPEST_PROJECTION")).toBe(true);
    // D-8: the verdict has to survive serialisation. Before `SelectionPlanIR.budget`
    // carried `state`/`shortfall`, an over-budget plan sent across a transport
    // arrived looking indistinguishable from one that fitted.
    const roundTripped = JSON.parse(JSON.stringify(result.plan)) as typeof result.plan;
    expect(roundTripped.budget.state).toBe("exceeded-at-cheapest-projection");
    expect(roundTripped.budget.shortfall).toBe(result.handoff.shortfall);
    expect(roundTripped.budget.maxTokens).toBe(20);
  });

  test("an empty selection is within budget rather than an error", () => {
    const result = degradeToFit([], chain, 10, model.projections, model.tokenCost);
    expect(result.handoff.state).toBe("within-budget");
    expect(result.projectionLoads).toEqual([]);
  });

  test("an unknown projection in the chain throws instead of being skipped", () => {
    expect(() => degradeToFit([MFA], ["ghost"], 100, model.projections, model.tokenCost)).toThrow(
      /PROJECTION_NOT_DECLARED/,
    );
  });
});
