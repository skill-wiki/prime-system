/**
 * The plan §10.4 invariant, tested rather than asserted: a transport must not
 * change Query/Plan/Action semantics.
 *
 * The check is byte equality between what the transport returns and what a direct
 * in-process engine call returns for the same request. Comparing the *whole*
 * `SelectionPlanIR` rather than a few fields is the point: a transport that dropped
 * `rationale`, re-ordered `projectionLoads`, or rounded a score would pass a
 * field-by-field spot check and fail this one.
 */

import { describe, expect, test } from "bun:test";
import { planSelection, QueryEngineError, type QueryRequest } from "@skill-wiki/query-engine";
import { createEmbeddedTransport } from "../src/index.ts";
import { loadEngineContext, registry, SNAPSHOT, UNIT_IDS } from "./support/host.ts";

const engine = loadEngineContext();
const generators = registry();
const transport = createEmbeddedTransport({ snapshot: SNAPSHOT, engine, generators });

function request(overrides: Partial<QueryRequest> = {}): QueryRequest {
  return {
    requestId: "sdk-1",
    profile: "audit-default",
    principal: { id: "auditor", allowedVisibility: ["public", "shared"], grantedPolicyLabels: [] },
    maxTokens: 1000,
    text: "authentication factor",
    seeds: [UNIT_IDS.MFA],
    ...overrides,
  };
}

describe("embedded transport", () => {
  test("really runs: a plan comes back with selected units and a budget", async () => {
    const plan = await transport.plan(request());
    expect(plan.selected.length).toBeGreaterThan(0);
    expect(plan.snapshot).toEqual(SNAPSHOT);
    expect(plan.budget.maxTokens).toBe(1000);
    expect(plan.projectionLoads.flatMap(load => load.unitIds)).toContain(UNIT_IDS.MFA);
  });

  test("reports its transport kind without changing the plan's identity", async () => {
    expect(transport.kind).toBe("embedded");
    expect(await transport.snapshot()).toEqual(SNAPSHOT);
  });

  test("plan through the transport is byte-identical to a direct engine call", async () => {
    const direct = planSelection(request(), engine, { generators });
    const viaTransport = await transport.plan(request());
    expect(JSON.stringify(viaTransport)).toBe(JSON.stringify(direct));
  });

  test("query returns the plan alongside the projections the plan itself assigned", async () => {
    const result = await transport.query(request());
    const assigned = result.plan.projectionLoads.flatMap(load =>
      load.unitIds.map(unitId => `${unitId}@${load.projectionRef}`),
    );
    expect(result.projections.map(p => `${p.unitId}@${p.projectionRef}`)).toEqual(assigned);
    for (const projection of result.projections) expect(typeof projection.content).toBe("string");
  });

  test("`depends-on` closure and load order survive the transport", async () => {
    const ordered = (await transport.query(request())).projections.map(p => p.unitId);
    // The model declares `depends-on` as loadOrder: before, so the dependency is
    // materialised ahead of the dependent. A transport that re-sorted its output
    // would break this even though the plan it received was correct.
    expect(ordered.indexOf(UNIT_IDS.IDP)).toBeLessThan(ordered.indexOf(UNIT_IDS.MFA));
  });

  test("an engine error crosses the transport unchanged, not wrapped", async () => {
    const failure = transport.plan(request({ profile: "not-declared" }));
    await expect(failure).rejects.toThrow(QueryEngineError);
    try {
      await failure;
    } catch (error) {
      expect((error as QueryEngineError).diagnostics.map(d => d.code)).toEqual(["PROFILE_NOT_DECLARED"]);
    }
  });

  test("a host with no action runtime refuses actions instead of faking a run", async () => {
    const context = {
      principal: "auditor",
      roles: [],
      allowedCapabilities: [],
      budget: {},
      snapshot: SNAPSHOT.corpusRelease,
      trace: "t-1",
    };
    await expect(
      transport.execute({ action: "AuditControl", input: {}, context, idempotencyKey: "k-1" }),
    ).rejects.toThrow("activated no action runtime");
  });
});
