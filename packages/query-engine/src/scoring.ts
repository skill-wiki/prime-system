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
 *
 * An axis the profile weights but nothing produced is *not* renormalised away: it
 * contributes 0 and is reported. Renormalising the surviving weights would make
 * the engine rewrite the profile's declared weighting whenever a request happened
 * not to exercise one generator — the same override this module exists to prevent
 * one level up. The two ways an axis can go missing are told apart, because they
 * need different reactions: see `FEATURE_AXIS_UNPRODUCED` (a wiring fault) and
 * `FEATURE_AXIS_NOT_APPLICABLE` (a request shape).
 */

import type { DiagnosticIR, SelectionCandidateIR } from "@skill-wiki/ir";
import type { RetrievalProfile } from "@skill-wiki/model-schema";
import { canonicalStrings, compareByScoreThenId, orderedRecord, quantize, sortedKeys } from "./deterministic.ts";
import { linearScore } from "./reranker.ts";
import type { CandidateGenerator } from "./types.ts";

/** A profile weights an axis no registered generator even declares: a wiring fault. */
export const FEATURE_AXIS_UNPRODUCED = "FEATURE_AXIS_UNPRODUCED";

/**
 * A profile weights an axis a registered generator declares but did not produce
 * for *this* request. Severity `info`, not `warning`: nothing is mis-configured.
 */
export const FEATURE_AXIS_NOT_APPLICABLE = "FEATURE_AXIS_NOT_APPLICABLE";

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

  // Which registered generators *declare* each axis, regardless of whether they
  // produced a value this time. This is what separates a mis-wired profile from a
  // request that simply gave a generator nothing to work from — see the two
  // diagnostics at the bottom of this function.
  const declaredBy = new Map<string, string[]>();
  for (const output of outputs) {
    for (const axis of output.generator.featureAxes) {
      const writers = declaredBy.get(axis) ?? [];
      writers.push(output.generator.name);
      declaredBy.set(axis, writers);
    }
  }

  const candidates = [...accumulators.values()]
    .map(accumulator => {
      const entries: (readonly [string, number])[] = [];
      for (const axis of [...accumulator.featureValues.keys()].sort()) {
        const value = quantize(accumulator.featureValues.get(axis)!);
        entries.push([axis, value]);
        if (profile.features[axis] === undefined) unweighted.add(axis);
      }
      const featureValues = orderedRecord(entries);
      return {
        unitId: accumulator.unitId,
        // The single definition of "linear over the profile's features", shared
        // with `stable-linear-v1` so the published total and a reranker's derived
        // total cannot drift apart.
        score: linearScore(featureValues, profile.features),
        featureValues,
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
    const writers = declaredBy.get(axis);
    if (writers !== undefined) {
      // A registered generator owns this axis; it just had nothing to say about
      // this request. The canonical instance is `graphAffinity` on a query with no
      // seeds: the graph generator returns nothing because there is no seed to
      // measure proximity to, which is the correct behaviour and not a wiring
      // fault. Reporting it as `FEATURE_AXIS_UNPRODUCED` claimed "no registered
      // generator produced it", which read as a mis-wired model and sent readers
      // looking for a missing registration that was never missing.
      diagnostics.push({
        code: FEATURE_AXIS_NOT_APPLICABLE,
        message:
          `Retrieval profile '${profile.name}' weights feature axis '${axis}' (weight ${profile.features[axis]!}) ` +
          `and generator(s) [${canonicalStrings(writers).join(", ")}] declare it, but none produced a value for ` +
          `this request. The axis contributes 0 to every candidate and the remaining weights are NOT ` +
          `renormalised, so scores stay comparable with requests where it did apply — but they are lower in ` +
          `absolute terms, so a score threshold tuned on the full axis set will over-reject here.`,
        severity: "info",
      });
      continue;
    }
    diagnostics.push({
      code: FEATURE_AXIS_UNPRODUCED,
      message: `Retrieval profile '${profile.name}' weights feature axis '${axis}' but no registered generator declares or produced it`,
      severity: "warning",
    });
  }

  return { candidates, diagnostics };
}
