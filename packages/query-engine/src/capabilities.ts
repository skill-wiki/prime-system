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
 * This module only *reports*. It deliberately holds no reranker registry and no
 * reranker SPI: a hook with nothing behind it would make the gap harder to see,
 * not easier. Whoever implements reranking removes the check here at the same
 * time, so there is never a build in which both a stub and a real stage exist.
 */

import type { DiagnosticIR } from "@skill-wiki/ir";
import type { RetrievalProfile } from "@skill-wiki/model-schema";

/** A profile declared a reranker; this engine ranks by feature score only. */
export const RERANKER_NOT_IMPLEMENTED = "RERANKER_NOT_IMPLEMENTED";

/**
 * Diagnostics for every stage `profile` declares that this engine cannot run.
 *
 * Severity is `warning`, not `error`: the selected set is still correct and the
 * budget still holds, so the plan is deliverable — what the caller loses is the
 * refinement the declared reranker would have applied to the *order*. Calling it
 * an error would claim the plan is invalid, which is a different and false thing.
 * The reason it still cannot be missed is the channel it is routed into, not the
 * severity — see the callers in `engine.ts` and `solver-bridge.ts`.
 */
export function detectCapabilityGaps(profile: RetrievalProfile): readonly DiagnosticIR[] {
  const gaps: DiagnosticIR[] = [];

  if (profile.reranker !== undefined) {
    gaps.push({
      code: RERANKER_NOT_IMPLEMENTED,
      message:
        `Retrieval profile '${profile.name}' declares reranker '${profile.reranker}', which this engine ` +
        `does not implement. The returned order is the feature-scored order with no reranking applied; ` +
        `treat any ranking-sensitive decision accordingly.`,
      path: ["profile", "reranker"],
      severity: "warning",
    });
  }

  return gaps;
}
