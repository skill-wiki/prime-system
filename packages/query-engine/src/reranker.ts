/**
 * @module reranker
 *
 * The reranking stage. `RetrievalProfile.reranker` names it, this registry
 * resolves the name, and the engine runs the resolved stage between scoring and
 * the rank cutoff (see `runRetrieval`). Placement is a contract, not a detail:
 * running before the cutoff means the reranker decides *which* candidates survive
 * `limit`, which is the only placement at which reranking can affect what the
 * caller receives rather than only the order of what it already had.
 *
 * A reranker may only permute. It may not add a unit (admission ran three stages
 * earlier and a unit introduced here would never have been ACL-checked) and it may
 * not drop one (dropping is the cutoff's, the exclusion stage's and the budget's
 * job, each of which reports its removals). `applyReranker` enforces both.
 *
 * ## What `stable-linear-v1` is
 *
 * The name is the whole specification, and the profile supplies the rest:
 *
 *   linear  score(u) = Σ_axis  profile.features[axis] * u.featureValues[axis]
 *   stable  descending quantized score, ties broken by ascending unit id
 *
 * Two consequences are deliberate and load-bearing.
 *
 * First, **an axis absent from a candidate contributes 0 and the remaining weights
 * are not renormalised.** A no-seed query produces no `graphAffinity`; renormalising
 * the surviving axes would silently turn a declared `{lexicalScore 0.7,
 * graphAffinity 0.3}` into `{lexicalScore 1.0}` — the engine overriding model
 * policy, which is the one thing this package must never do. The absence is
 * reported instead, by `scoreCandidates`, as `FEATURE_AXIS_NOT_APPLICABLE`.
 *
 * Second, **`stable-linear-v1` is order-preserving with respect to the unreranked
 * path, by construction rather than by luck**: it re-derives the score with the same
 * `linearScore` helper `scoreCandidates` uses, so it cannot drift from it. That is
 * the correct outcome for this declaration. A profile saying `stable-linear-v1` is
 * not asking for a *different* order from a stable linear combination of its own
 * declared weights — it is naming the order it wants and demanding that the engine
 * say whether it honoured it. Before this stage existed the engine could only answer
 * "no" (`RERANKER_NOT_IMPLEMENTED`); it can now answer "yes" and name the stage.
 * The stage is nonetheless live and not dead code: a reranker with different
 * semantics registered under a different name really does change the ranking, which
 * `reranker.test.ts` pins directly.
 *
 * Because it re-derives rather than trusts, it also catches an upstream stage that
 * changed a candidate's `score` without changing the `featureValues` it publishes
 * (or the reverse) — `RERANK_SCORE_DISAGREEMENT`. That divergence is invisible in
 * the plan otherwise: a consumer reading the breakdown and a consumer reading the
 * total would disagree about the same candidate.
 */

import type { DiagnosticIR, SelectionCandidateIR } from "@aoe/ir";
import type { RetrievalProfile } from "@aoe/model-schema";
import { compareStrings, quantize } from "./deterministic.ts";
import { diagnostic, fail, QueryEngineError } from "./types.ts";

/** The one reranker this engine implements. */
export const STABLE_LINEAR_V1 = "stable-linear-v1";

/** A declared reranker ran; emitted once per plan, naming the stage. */
export const RERANKER_APPLIED = "RERANKER_APPLIED";

/** A candidate's published total disagrees with its published per-axis breakdown. */
export const RERANK_SCORE_DISAGREEMENT = "RERANK_SCORE_DISAGREEMENT";

export interface RerankContext {
  readonly profile: RetrievalProfile;
  /** Rerankers surface data problems here instead of throwing or logging. */
  report(diagnostic: DiagnosticIR): void;
}

/**
 * The pluggable reranking SPI. Mirrors `CandidateGenerator`: named, resolved from
 * the profile, handed the profile so every weight it uses is model data.
 */
export interface Reranker {
  readonly name: string;
  /**
   * Return the same units in a possibly different order. Adding or removing a
   * unit is a contract violation and is rejected by `applyReranker`.
   */
  rerank(
    candidates: readonly SelectionCandidateIR[],
    ctx: RerankContext,
  ): readonly SelectionCandidateIR[];
}

/**
 * The linear model, in one place. Shared by `scoreCandidates` (which publishes the
 * total on each candidate) and by `stable-linear-v1` (which re-derives it), so the
 * two cannot disagree about what "linear over the profile's features" means.
 *
 * An axis the profile does not weight is excluded from the total and kept in the
 * breakdown; an axis the profile weights but the candidate lacks contributes 0.
 */
export function linearScore(
  featureValues: Readonly<Record<string, number>>,
  features: Readonly<Record<string, number>>,
): number {
  let score = 0;
  for (const axis of Object.keys(featureValues).sort(compareStrings)) {
    const weight = features[axis];
    if (weight === undefined) continue;
    score += weight * quantize(featureValues[axis]!);
  }
  return quantize(score);
}

export function createStableLinearReranker(name: string = STABLE_LINEAR_V1): Reranker {
  return {
    name,
    rerank(candidates, ctx) {
      const rescored = candidates.map(candidate => {
        const derived = linearScore(candidate.featureValues, ctx.profile.features);
        if (derived !== quantize(candidate.score)) {
          ctx.report({
            code: RERANK_SCORE_DISAGREEMENT,
            message:
              `Candidate '${candidate.unitId}' publishes score ${quantize(candidate.score)} but its per-axis ` +
              `breakdown under profile '${ctx.profile.name}' sums to ${derived}; the breakdown is authoritative ` +
              `and was used for ranking`,
            severity: "warning",
          });
        }
        return { candidate, derived };
      });

      return rescored
        .sort((a, b) => {
          // Not `compareByScoreThenId`: that reads `candidate.score`, and the whole
          // point here is to rank by the value derived from the breakdown.
          const delta = b.derived - a.derived;
          if (delta !== 0) return delta > 0 ? 1 : -1;
          return compareStrings(a.candidate.unitId, b.candidate.unitId);
        })
        .map(entry => entry.candidate);
    },
  };
}

/**
 * Rerankers are resolved by the name a `RetrievalProfile` uses, exactly like
 * generators. Unlike `CandidateGeneratorRegistry`, this one *is* pre-populated —
 * see `builtinRerankers()` for why that is not the same mistake.
 */
export class RerankerRegistry {
  private readonly byName = new Map<string, Reranker>();

  register(reranker: Reranker): this {
    if (reranker.name.length === 0) fail("RERANKER_NAME_EMPTY", "Reranker name must be non-empty");
    if (this.byName.has(reranker.name)) {
      fail("RERANKER_DUPLICATE", `Reranker '${reranker.name}' is already registered`);
    }
    this.byName.set(reranker.name, reranker);
    return this;
  }

  get(name: string): Reranker | undefined {
    return this.byName.get(name);
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  names(): readonly string[] {
    return [...this.byName.keys()].sort(compareStrings);
  }
}

/**
 * A fresh registry holding every reranker this engine implements.
 *
 * `CandidateGeneratorRegistry` deliberately registers nothing by default, because
 * a default generator set also ships default *axis names* and the profile stops
 * being the single source of retrieval configuration. `stable-linear-v1` carries no
 * such payload: every axis name and every weight it uses is read out of
 * `profile.features` at call time, and it names no relation, type or tag. So
 * shipping it costs no policy, while withholding it would mean every host has to
 * re-register the engine's own default ordering under the name the spec gives it.
 *
 * Returns a new registry each call so a host that adds its own reranker
 * (`builtinRerankers().register(mine)`) cannot mutate anyone else's set.
 */
export function builtinRerankers(): RerankerRegistry {
  return new RerankerRegistry().register(createStableLinearReranker());
}

export interface RerankOutcome {
  readonly candidates: readonly SelectionCandidateIR[];
  /** Name of the reranker that ran, or `undefined` when the profile declared none. */
  readonly applied: string | undefined;
}

/**
 * Run the profile's declared reranker, if this engine has it.
 *
 * A profile declaring no reranker is not a gap: the engine's own scoring order
 * stands, untouched. A profile declaring one this registry does not hold is
 * reported by `detectCapabilityGaps`, not here, so that the gap reaches the plan's
 * required `conflicts` slot rather than the optional `rationale`.
 */
export function applyReranker(
  candidates: readonly SelectionCandidateIR[],
  profile: RetrievalProfile,
  rerankers: RerankerRegistry,
  report: (diagnostic: DiagnosticIR) => void,
): RerankOutcome {
  const declared = profile.reranker;
  if (declared === undefined) return { candidates, applied: undefined };
  const reranker = rerankers.get(declared);
  if (reranker === undefined) return { candidates, applied: undefined };

  const reranked = reranker.rerank(candidates, { profile, report });

  // A permutation, or nothing. Checked rather than trusted because a third-party
  // reranker sits downstream of admission: a unit it invented would reach the
  // caller having never been ACL-checked.
  if (reranked.length !== candidates.length) {
    throw new QueryEngineError([
      diagnostic(
        "RERANKER_CHANGED_MEMBERSHIP",
        `Reranker '${declared}' returned ${reranked.length} candidate(s) for ${candidates.length} input(s); ` +
          `a reranker may only permute, because admission and every removal stage run elsewhere`,
        "error",
        ["profile", "reranker"],
      ),
    ]);
  }
  const before = new Set(candidates.map(candidate => candidate.unitId));
  const introduced = reranked.filter(candidate => !before.has(candidate.unitId));
  if (introduced.length > 0) {
    throw new QueryEngineError([
      diagnostic(
        "RERANKER_CHANGED_MEMBERSHIP",
        `Reranker '${declared}' introduced unit(s) [${introduced
          .map(candidate => candidate.unitId)
          .sort(compareStrings)
          .join(", ")}] that were not in its input; a reranker may only permute`,
        "error",
        ["profile", "reranker"],
      ),
    ]);
  }

  report({
    code: RERANKER_APPLIED,
    message:
      `Retrieval profile '${profile.name}' declares reranker '${declared}' and it ran: the ranked order ` +
      `below is the reranked order, not the raw feature-scored one`,
    path: ["profile", "reranker"],
    severity: "info",
  });

  return { candidates: reranked, applied: declared };
}
