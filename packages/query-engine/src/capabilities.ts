/**
 * @module capabilities
 *
 * Declared-but-absent pipeline stages.
 *
 * A `RetrievalProfile` names the stages the engine is expected to run. When the
 * profile declares a stage this engine has no implementation for, silence is the
 * worst available answer: the caller receives a plan that looks like the declared
 * pipeline ran end to end. §9.7 forbids exactly this shape for evaluation — a
 * result must carry `skipped`/`skipReason` rather than let a default pass stand in
 * for a provider that never ran — and a declared reranker that never runs is the
 * same discrepancy one stage earlier.
 *
 * This module only *reports*, and it now reports against a real registry rather
 * than against the fact that no registry existed. The distinction it draws is
 * between two situations the earlier version could not tell apart:
 *
 *   profile names a reranker this engine implements      -> no gap; it runs
 *   profile names one this engine does not implement     -> gap; nothing ran
 *
 * The second case did not go away when reranking was implemented and must not be
 * deleted with it: a model is free to declare any reranker name, and a host that
 * registers `stable-linear-v1` alone still has to be told that a profile asking
 * for `weighted-blend-v2` got the unreranked order. What changed is only that the
 * check now consults `RerankerRegistry` instead of assuming the answer is always
 * "not implemented".
 */

import type { DiagnosticIR } from "@aoe/ir";
import type { RetrievalProfile } from "@aoe/model-schema";
import type { RerankerRegistry } from "./reranker.ts";

/** A profile declared a reranker this engine has no implementation for. */
export const RERANKER_NOT_IMPLEMENTED = "RERANKER_NOT_IMPLEMENTED";

/**
 * Diagnostics for every stage `profile` declares that `rerankers` cannot supply.
 *
 * Severity is `warning`, not `error`: the selected set is still correct and the
 * budget still holds, so the plan is deliverable — what the caller loses is the
 * refinement the declared reranker would have applied to the *order*. Calling it
 * an error would claim the plan is invalid, which is a different and false thing.
 * The reason it still cannot be missed is the channel it is routed into, not the
 * severity — see the callers in `engine.ts` and `solver-bridge.ts`.
 *
 * The message names what *is* available, because "unknown reranker" is most often
 * a typo or a host that forgot to register one, and both are unactionable without
 * the registered set.
 */
export function detectCapabilityGaps(
  profile: RetrievalProfile,
  rerankers: RerankerRegistry,
): readonly DiagnosticIR[] {
  const gaps: DiagnosticIR[] = [];

  if (profile.reranker !== undefined && !rerankers.has(profile.reranker)) {
    const registered = rerankers.names();
    gaps.push({
      code: RERANKER_NOT_IMPLEMENTED,
      message:
        `Retrieval profile '${profile.name}' declares reranker '${profile.reranker}', which this engine ` +
        `does not implement (registered: [${registered.join(", ")}]). The returned order is the ` +
        `feature-scored order with no reranking applied; treat any ranking-sensitive decision accordingly.`,
      path: ["profile", "reranker"],
      severity: "warning",
    });
  }

  return gaps;
}
