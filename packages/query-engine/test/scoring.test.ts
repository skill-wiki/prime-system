import { describe, expect, test } from "bun:test";
import type { SelectionCandidateIR } from "@skill-wiki/ir";
import type { RetrievalProfile } from "@skill-wiki/model-schema";
import { scoreCandidates, type CandidateGenerator, type GeneratorOutput } from "../src/index.ts";

function stub(name: string, axis: string, values: Readonly<Record<string, number>>): GeneratorOutput {
  const generator: CandidateGenerator = { name, featureAxes: [axis], generate: () => [] };
  const candidates: SelectionCandidateIR[] = Object.entries(values).map(([unitId, value]) => ({
    unitId,
    score: 0,
    featureValues: { [axis]: value },
    reasons: [`${name}: stub`],
  }));
  return { generator, weight: 1, candidates };
}

function profileWith(features: Readonly<Record<string, number>>): RetrievalProfile {
  return {
    kind: "retrieval-profile",
    name: "p",
    version: "1.0.0",
    projection: "x",
    candidateGenerators: [{ name: "a", weight: 1 }],
    features,
    constraints: [],
  };
}

describe("scoring", () => {
  test("the profile's weights decide the ranking, nothing else", () => {
    const outputs = [stub("g1", "alpha", { U1: 1, U2: 0 }), stub("g2", "beta", { U1: 0, U2: 1 })];

    const alphaFirst = scoreCandidates(outputs, profileWith({ alpha: 2, beta: 1 }));
    expect(alphaFirst.candidates.map(c => c.unitId)).toEqual(["U1", "U2"]);

    // Same generator output, inverted weights, inverted ranking. The engine holds
    // no opinion of its own about which axis matters.
    const betaFirst = scoreCandidates(outputs, profileWith({ alpha: 1, beta: 2 }));
    expect(betaFirst.candidates.map(c => c.unitId)).toEqual(["U2", "U1"]);
  });

  test("every candidate carries a per-axis breakdown, not only a total", () => {
    const result = scoreCandidates(
      [stub("g1", "alpha", { U1: 0.5 }), stub("g2", "beta", { U1: 0.25 })],
      profileWith({ alpha: 2, beta: 4 }),
    );
    expect(result.candidates[0]!.featureValues).toEqual({ alpha: 0.5, beta: 0.25 });
    expect(result.candidates[0]!.score).toBe(2);
  });

  test("an axis the profile does not weight is reported but does not score", () => {
    const result = scoreCandidates([stub("g1", "alpha", { U1: 1 })], profileWith({ beta: 3 }));
    expect(result.candidates[0]!.score).toBe(0);
    expect(result.candidates[0]!.featureValues.alpha).toBe(1);
    expect(result.diagnostics.map(d => d.code)).toContain("FEATURE_AXIS_UNWEIGHTED");
  });

  test("an axis the profile weights but nobody produces is reported", () => {
    const result = scoreCandidates([stub("g1", "alpha", { U1: 1 })], profileWith({ alpha: 1, gamma: 1 }));
    const unproduced = result.diagnostics.find(d => d.code === "FEATURE_AXIS_UNPRODUCED");
    expect(unproduced?.message).toContain("gamma");
  });

  test("the generator weight scales that generator's own signal", () => {
    const output = stub("g1", "alpha", { U1: 0.5 });
    const doubled = scoreCandidates([{ ...output, weight: 2 }], profileWith({ alpha: 1 }));
    expect(doubled.candidates[0]!.featureValues.alpha).toBe(1);
  });

  test("two generators on one axis keep the larger value and say so", () => {
    const result = scoreCandidates(
      [stub("g1", "alpha", { U1: 0.2 }), stub("g2", "alpha", { U1: 0.9 })],
      profileWith({ alpha: 1 }),
    );
    expect(result.candidates[0]!.featureValues.alpha).toBe(0.9);
    expect(result.diagnostics.map(d => d.code)).toContain("FEATURE_AXIS_COLLISION");
  });

  test("reasons from every generator survive, deduplicated and canonically ordered", () => {
    const result = scoreCandidates(
      [stub("zeta", "alpha", { U1: 1 }), stub("alpha", "beta", { U1: 1 })],
      profileWith({ alpha: 1, beta: 1 }),
    );
    expect(result.candidates[0]!.reasons).toEqual(["alpha: stub", "zeta: stub"]);
  });

  test("ties break on unit id so the ranking never depends on discovery order", () => {
    const result = scoreCandidates(
      [stub("g1", "alpha", { zz: 1, aa: 1, mm: 1 })],
      profileWith({ alpha: 1 }),
    );
    expect(result.candidates.map(c => c.unitId)).toEqual(["aa", "mm", "zz"]);
  });
});
