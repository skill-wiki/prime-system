/**
 * @module scoring
 *
 * Merging generator output into one explainable candidate per unit.
 *
 * The engine contributes no axis and no weight. `RetrievalProfile.features` is
 * the complete list of axes that count and the complete set of weights; an axis a
 * generator produced but the profile did not weight is kept in the breakdown (so
 * the result stays explainable) and excluded from the total (so the profile stays
 * authoritative). `candidateGenerators[].weight` scales that generator's own
 * signal before it reaches the axis, which is how two generators writing the same
 * axis can be balanced against each other.
 */

import type { DiagnosticIR, SelectionCandidateIR } from "@skill-wiki/ir";
import type { RetrievalProfile } from "@skill-wiki/model-schema";
import { canonicalStrings, compareByScoreThenId, orderedRecord, quantize, sortedKeys } from "./deterministic.ts";
import type { CandidateGenerator } from "./types.ts";

export interface GeneratorOutput {
  readonly generator: CandidateGenerator;
  readonly weight: number;
  readonly candidates: readonly SelectionCandidateIR[];
}

export interface ScoringResult {
  readonly candidates: readonly SelectionCandidateIR[];
  readonly diagnostics: readonly DiagnosticIR[];
}

interface Accumulator {
  readonly unitId: string;
  readonly featureValues: Map<string, number>;
  readonly reasons: string[];
  /** Which generator last wrote each axis, used to detect axis collisions. */
  readonly writers: Map<string, string>;
}

/**
 * Combine per-generator candidates and score them.
 *
 * When two generators write the same axis the larger value wins rather than the
 * sum: summing would let recall from a second generator inflate an axis past the
 * [0, 1] range every generator normalises into, quietly re-weighting the profile.
 */
export function scoreCandidates(outputs: readonly GeneratorOutput[], profile: RetrievalProfile): ScoringResult {
  const accumulators = new Map<string, Accumulator>();
  const diagnostics: DiagnosticIR[] = [];
  const collisions = new Set<string>();

  for (const output of outputs) {
    for (const candidate of output.candidates) {
      let accumulator = accumulators.get(candidate.unitId);
      if (accumulator === undefined) {
        accumulator = {
          unitId: candidate.unitId,
          featureValues: new Map<string, number>(),
          reasons: [],
          writers: new Map<string, string>(),
        };
        accumulators.set(candidate.unitId, accumulator);
      }
      accumulator.reasons.push(...candidate.reasons);
      for (const axis of sortedKeys(candidate.featureValues)) {
        const value = candidate.featureValues[axis]! * output.weight;
        const previousWriter = accumulator.writers.get(axis);
        if (previousWriter !== undefined && previousWriter !== output.generator.name) {
          const key = `${axis}\u0000${previousWriter}\u0000${output.generator.name}`;
          if (!collisions.has(key)) {
            collisions.add(key);
            diagnostics.push({
              code: "FEATURE_AXIS_COLLISION",
              message: `Feature axis '${axis}' is written by both '${previousWriter}' and '${output.generator.name}'; the larger value is kept`,
              severity: "warning",
            });
          }
        }
        accumulator.writers.set(axis, output.generator.name);
        const existing = accumulator.featureValues.get(axis);
        accumulator.featureValues.set(axis, existing === undefined ? value : Math.max(existing, value));
      }
    }
  }

  const weightedAxes = new Set(Object.keys(profile.features));
  const unweighted = new Set<string>();

  const candidates = [...accumulators.values()]
    .map(accumulator => {
      let score = 0;
      const entries: (readonly [string, number])[] = [];
      for (const axis of [...accumulator.featureValues.keys()].sort()) {
        const value = quantize(accumulator.featureValues.get(axis)!);
        entries.push([axis, value]);
        const weight = profile.features[axis];
        if (weight === undefined) unweighted.add(axis);
        else score += weight * value;
      }
      return {
        unitId: accumulator.unitId,
        score: quantize(score),
        featureValues: orderedRecord(entries),
        reasons: canonicalStrings(accumulator.reasons),
      };
    })
    .sort(compareByScoreThenId);

  for (const axis of [...unweighted].sort()) {
    diagnostics.push({
      code: "FEATURE_AXIS_UNWEIGHTED",
      message: `Feature axis '${axis}' was produced but the retrieval profile '${profile.name}' does not weight it; it is reported but does not affect the score`,
      severity: "warning",
    });
  }

  for (const axis of [...weightedAxes].sort()) {
    if (candidates.some(candidate => axis in candidate.featureValues)) continue;
    diagnostics.push({
      code: "FEATURE_AXIS_UNPRODUCED",
      message: `Retrieval profile '${profile.name}' weights feature axis '${axis}' but no registered generator produced it`,
      severity: "warning",
    });
  }

  return { candidates, diagnostics };
}
