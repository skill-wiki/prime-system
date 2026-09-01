/**
 * §16 Phase 3 conformance: one engine, two model packages that share no
 * vocabulary. Domain A is issue tracking, domain B is cooking. They disagree on
 * type names, relation names, relation semantics, projection names, token sizes,
 * feature axis names *and* the names their generators are registered under. Every
 * assertion below is written against the fixture's own declarations, so a domain
 * constant leaking into the engine would break one of the two.
 */

import { describe, expect, test } from "bun:test";
import type { GraphIR, SelectionPlanIR } from "@aoe/ir";
import { planSelection, type QueryRequest } from "../src/index.ts";
import {
  anyPrincipal,
  contextFor,
  corpusA,
  corpusB,
  registryFor,
  type DomainFixture,
} from "./support/harness.ts";
import { domainA, domainB } from "./support/model.ts";

interface Case {
  readonly label: string;
  readonly domain: DomainFixture;
  readonly corpus: () => GraphIR;
  readonly text: string;
  readonly seed: string;
  readonly facet: QueryRequest["facets"];
  /** A unit the seed's expand/closure relations must pull in. */
  readonly expectedPull: string;
  /** The relation that does the pulling, named by the fixture. */
  readonly pullRelation: string;
  readonly cheapProjection: string;
}

const cases: readonly Case[] = [
  {
    label: "domain A (issue tracking)",
    domain: domainA,
    corpus: corpusA,
    text: "database migration rollback",
    seed: "I1",
    facet: [{ kind: "typeRef", anyOf: ["Issue"] }],
    expectedPull: "I5",
    pullRelation: "blocked-by",
    cheapProjection: "brief",
  },
  {
    label: "domain B (cooking)",
    domain: domainB,
    corpus: corpusB,
    text: "arborio rice",
    seed: "D1",
    facet: [{ kind: "typeRef", anyOf: ["Dish"] }],
    expectedPull: "G1",
    pullRelation: "needs-ingredient",
    cheapProjection: "card",
  },
];

function run(testCase: Case, overrides: Partial<QueryRequest> = {}): SelectionPlanIR {
  const request: QueryRequest = {
    requestId: `conformance-${testCase.domain.profile.name}`,
    profile: testCase.domain.profile.name,
    principal: anyPrincipal,
    maxTokens: 1000,
    text: testCase.text,
    seeds: [testCase.seed],
    facets: testCase.facet,
    ...overrides,
  };
  return planSelection(request, contextFor(testCase.domain, testCase.corpus()), {
    generators: registryFor(testCase.domain),
  });
}

for (const testCase of cases) {
  describe(testCase.label, () => {
    test("produces a plan whose feature axes are exactly the model's own", () => {
      const result = run(testCase);
      const declared = new Set(Object.keys(testCase.domain.profile.features));
      const produced = new Set(result.candidates.flatMap(c => Object.keys(c.featureValues)));
      expect(produced.size).toBeGreaterThan(0);
      for (const axis of produced) expect(declared.has(axis)).toBe(true);
      // No axis from the *other* domain can appear, which is what a leaked default
      // axis name in the engine would look like.
      const other = testCase.domain === domainA ? domainB : domainA;
      for (const axis of Object.keys(other.profile.features)) expect(produced.has(axis)).toBe(false);
    });

    test("reports no unweighted or unproduced axis for a fully wired profile", () => {
      const codes = (run(testCase).rationale ?? []).map(d => d.code);
      expect(codes).not.toContain("FEATURE_AXIS_UNWEIGHTED");
      expect(codes).not.toContain("FEATURE_AXIS_UNPRODUCED");
    });

    test("pulls in the unit its own expand/closure relation declares", () => {
      const result = run(testCase);
      const expansion = result.relationExpansions.find(e => e.relationRef === testCase.pullRelation);
      expect(expansion?.discovered).toContain(testCase.expectedPull);
      expect(result.selected.map(c => c.unitId)).toContain(testCase.expectedPull);
    });

    test("uses its own primary projection and its own fallback under pressure", () => {
      const roomy = run(testCase);
      expect(roomy.projectionLoads.map(l => l.projectionRef)).toContain(
        testCase.domain.profile.projection,
      );

      const primaryCost = testCase.domain.projections[testCase.domain.profile.projection]!.targetTokens;
      const cheapCost = testCase.domain.projections[testCase.cheapProjection]!.targetTokens;
      // Exactly one primary plus one fallback fits: enough room to prove the chain
      // is walked, not enough to let everything take the primary projection.
      const tight = run(testCase, {
        maxTokens: primaryCost + cheapCost,
        fallbackProjections: [testCase.cheapProjection],
      });
      const refs = tight.projectionLoads.map(l => l.projectionRef);
      expect(refs).toContain(testCase.domain.profile.projection);
      expect(refs).toContain(testCase.cheapProjection);
      expect(tight.budget.consumedTokens!).toBeLessThanOrEqual(primaryCost + cheapCost);
    });

    test("is byte-deterministic", () => {
      expect(JSON.stringify(run(testCase))).toBe(JSON.stringify(run(testCase)));
    });

    test("rejections are populated with real reasons under a tight budget", () => {
      const tight = run(testCase, { maxTokens: 30 });
      expect(tight.rejections.length).toBeGreaterThan(0);
      for (const rejection of tight.rejections) expect(rejection.reasons.length).toBeGreaterThan(0);
    });
  });
}

describe("the two domains do not contaminate each other", () => {
  test("a domain A profile name is unknown in a domain B context", () => {
    expect(() =>
      planSelection(
        {
          requestId: "x",
          profile: domainA.profile.name,
          principal: anyPrincipal,
          maxTokens: 100,
        },
        contextFor(domainB, corpusB()),
        { generators: registryFor(domainB) },
      ),
    ).toThrow(/PROFILE_NOT_DECLARED/);
  });

  test("domain B's exclude relation warns instead of dropping, because it declares 'warning'", () => {
    const result = planSelection(
      {
        requestId: "swap",
        profile: domainB.profile.name,
        principal: anyPrincipal,
        maxTokens: 1000,
        text: "rice",
        seeds: ["D1"],
      },
      contextFor(domainB, corpusB()),
      { generators: registryFor(domainB) },
    );
    const conflict = result.conflicts.find(d => d.message.includes("swaps-with"));
    expect(conflict?.severity).toBe("warning");
    const ids = result.selected.map(c => c.unitId);
    // Both sides of the swap survive: severity 'warning' must not drop anything.
    expect(ids).toContain("G1");
    expect(ids).toContain("G2");
  });
});
