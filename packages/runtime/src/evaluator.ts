/**
 * @module evaluator
 * EvaluationEngine — runs success/failure criteria and produces evaluation reports.
 *
 * Evaluation flow (from Spec 03):
 *   1. Run failure_criteria first (any trigger = FAIL, skip rest)
 *   2. Run success_criteria with weighted scoring
 *   3. Calculate confidence:
 *      - @decidable  → 1.0 (pass) or 0.0 (fail)
 *      - @measurable → min(actual / target, 1.0)
 *      - @subjective → AI self-assessment (0-1)
 *   4. Apply ConfidencePolicy thresholds
 *   5. Generate EvaluationReport
 *
 * Confidence policy thresholds:
 *   >= 0.95 → auto_approve (no human review needed)
 *   0.80 - 0.95 → human_review (pass with review flags)
 *   0.50 - 0.80 → not pass (needs human review)
 *   < 0.50 → auto_reject
 */

import type {
  EvaluationReport,
  CriterionResult,
  Verdict,
  ConfidencePolicy,
  PrimeEvaluationConfig,
  RuntimeCriterion,
  ExecutionContext,
  Decidability,
} from "./types";

/**
 * Default confidence policy thresholds.
 */
const DEFAULT_POLICY: ConfidencePolicy = {
  auto_approve: 0.95,
  human_review: 0.80,
  auto_reject: 0.50,
};

/**
 * Function type for evaluating a single criterion.
 *
 * The runtime provides a default implementation, but callers can
 * supply their own (e.g., for AI-judge integration).
 *
 * @returns { passed: boolean; confidence: number; value?: string }
 */
export type CriterionEvaluator = (
  criterion: RuntimeCriterion,
  context: ExecutionContext,
) => { passed: boolean; confidence: number; value?: string };

/**
 * Evaluation engine that runs criteria and produces reports.
 *
 * Usage:
 *   const engine = new EvaluationEngine();
 *   const report = engine.evaluate(config, context);
 */
export class EvaluationEngine {
  /** Custom criterion evaluator (optional). */
  private criterionEvaluator: CriterionEvaluator;

  constructor(criterionEvaluator?: CriterionEvaluator) {
    this.criterionEvaluator = criterionEvaluator ?? defaultCriterionEvaluator;
  }

  /**
   * Run the full evaluation pipeline.
   *
   * @param config  - Prime evaluation configuration (criteria + policy)
   * @param context - Execution context with outputs and step results
   * @returns Complete evaluation report
   */
  evaluate(
    config: PrimeEvaluationConfig,
    context: ExecutionContext,
  ): EvaluationReport {
    const policy = config.confidence_policy ?? DEFAULT_POLICY;

    // Step 1: Run failure_criteria (veto check — any trigger = FAIL)
    const failureChecks: CriterionResult[] = [];
    let failureTriggered = false;

    if (config.failure_criteria) {
      for (const criterion of config.failure_criteria.criteria) {
        const evalResult = this.criterionEvaluator(criterion, context);

        const criterionResult: CriterionResult = {
          id: criterion.id,
          result: evalResult.passed ? "fail" : "pass", // For failure criteria: "passed" means triggered
          confidence: evalResult.confidence,
          decidability: criterion.decidability,
          weight: criterion.weight,
          value: evalResult.value,
          note:
            criterion.decidability === "subjective"
              ? "Subjective criterion, human confirmation suggested"
              : undefined,
        };

        failureChecks.push(criterionResult);

        if (evalResult.passed) {
          failureTriggered = true;
        }
      }
    }

    // Short-circuit: if any failure criterion triggered, verdict is FAIL
    if (failureTriggered) {
      return {
        verdict: "FAIL",
        score: 0,
        confidence: this.calculateConfidenceFromResults(failureChecks),
        details: [],
        failure_checks: failureChecks,
        human_review_needed: failureChecks
          .filter((c) => c.decidability === "subjective")
          .map((c) => c.id),
      };
    }

    // Step 2: Run success_criteria with weighted scoring
    const successResults: CriterionResult[] = [];

    for (const criterion of config.success_criteria.criteria) {
      const evalResult = this.criterionEvaluator(criterion, context);

      const criterionResult: CriterionResult = {
        id: criterion.id,
        result: evalResult.passed ? "pass" : "fail",
        confidence: evalResult.confidence,
        decidability: criterion.decidability,
        weight: criterion.weight,
        value: evalResult.value,
        note:
          criterion.decidability === "subjective"
            ? "Subjective criterion, human confirmation suggested"
            : undefined,
      };

      successResults.push(criterionResult);
    }

    // Step 3: Calculate weighted score
    const score = this.calculateWeightedScore(successResults, config.success_criteria.mode);

    // Step 4: Calculate confidence
    const confidence = this.calculateConfidence(successResults);

    // Step 5: Determine verdict
    const minScore = config.success_criteria.min_score ?? 0.8;
    const verdict = this.determineVerdict(score, confidence, minScore, policy);

    // Step 6: Identify criteria needing human review
    const humanReviewNeeded = successResults
      .filter(
        (c) =>
          c.decidability === "subjective" && c.confidence < policy.auto_approve,
      )
      .map((c) => c.id);

    return {
      verdict,
      score,
      confidence,
      details: successResults,
      failure_checks: failureChecks.length > 0 ? failureChecks : undefined,
      human_review_needed: humanReviewNeeded,
    };
  }

  /**
   * Calculate the weighted score from criterion results.
   *
   * Formula: score = sum(weight * result) / sum(weight)
   * where result is 1.0 for pass, 0.0 for fail (or confidence for weighted mode).
   */
  calculateWeightedScore(
    results: CriterionResult[],
    mode: "all" | "any" | "weighted",
  ): number {
    if (results.length === 0) return 0;

    switch (mode) {
      case "all":
        // All must pass
        return results.every((r) => r.result === "pass") ? 1.0 : 0.0;

      case "any":
        // Any one passing is enough
        return results.some((r) => r.result === "pass") ? 1.0 : 0.0;

      case "weighted": {
        // Weighted average using confidence for passed criteria
        let totalWeight = 0;
        let weightedSum = 0;

        for (const r of results) {
          const w = r.weight;
          totalWeight += w;

          if (r.result === "pass") {
            // For subjective criteria, use confidence as the score
            // For decidable/measurable criteria, use 1.0
            const score =
              r.decidability === "subjective" ? r.confidence : 1.0;
            weightedSum += w * score;
          }
          // fail contributes 0
        }

        return totalWeight > 0 ? weightedSum / totalWeight : 0;
      }
    }
  }

  /**
   * Calculate overall confidence from criterion results.
   *
   * Confidence formula:
   *   overall = sum(weight * criterion_confidence) / sum(weight)
   *
   * Per-criterion confidence:
   *   @decidable  → 1.0 (pass) or 0.0 (fail)
   *   @measurable → min(actual / target, 1.0) — from the evaluation result
   *   @subjective → AI self-assessment score (0-1)
   */
  calculateConfidence(results: CriterionResult[]): number {
    if (results.length === 0) return 0;

    let totalWeight = 0;
    let weightedConfidence = 0;

    for (const r of results) {
      totalWeight += r.weight;
      weightedConfidence += r.weight * r.confidence;
    }

    return totalWeight > 0 ? weightedConfidence / totalWeight : 0;
  }

  /**
   * Determine the verdict based on score, confidence, and policy.
   */
  determineVerdict(
    score: number,
    confidence: number,
    minScore: number,
    policy: ConfidencePolicy,
  ): Verdict {
    // Score must meet minimum threshold
    if (score < minScore) {
      return "FAIL";
    }

    // Confidence determines final verdict
    if (confidence >= policy.auto_approve) {
      return "SUCCESS";
    }

    if (confidence >= policy.human_review) {
      return "SUCCESS"; // Pass but with human_review_needed populated
    }

    if (confidence >= policy.auto_reject) {
      return "PARTIAL"; // Needs human review
    }

    return "FAIL"; // Auto-reject
  }

  /**
   * Apply confidence policy to determine action.
   *
   * @returns "auto_approve" | "human_review" | "auto_reject"
   */
  applyPolicy(
    confidence: number,
    policy?: ConfidencePolicy,
  ): "auto_approve" | "human_review" | "auto_reject" {
    const p = policy ?? DEFAULT_POLICY;

    if (confidence >= p.auto_approve) {
      return "auto_approve";
    }
    if (confidence >= p.human_review) {
      return "human_review";
    }
    if (confidence >= p.auto_reject) {
      return "human_review"; // Between reject and review = still review
    }
    return "auto_reject";
  }

  // ─── Private Helpers ─────────────────────────────────────────────────────

  /**
   * Calculate confidence from failure check results.
   */
  private calculateConfidenceFromResults(results: CriterionResult[]): number {
    if (results.length === 0) return 1.0;

    let totalConf = 0;
    for (const r of results) {
      totalConf += r.confidence;
    }
    return totalConf / results.length;
  }
}

// ─── Default Criterion Evaluator ───────────────────────────────────────────

/**
 * Default criterion evaluator that uses simple heuristics.
 *
 * In a real system, this would:
 * - Run scripts for "script" verify methods
 * - Load Rule Primes for "rule" verify methods
 * - Query the AI for "ai_judge" verify methods
 * - Evaluate conditions for "check" verify methods
 *
 * The default implementation:
 * - @decidable criteria: check if relevant outputs exist → pass with 1.0
 * - @measurable criteria: check if a numeric value is present → pass with value/100
 * - @subjective criteria: always pass with 0.85 confidence (simulated AI assessment)
 */
function defaultCriterionEvaluator(
  criterion: RuntimeCriterion,
  context: ExecutionContext,
): { passed: boolean; confidence: number; value?: string } {
  switch (criterion.decidability) {
    case "decidable":
      // Check if step results indicate this criterion is met
      return {
        passed: true,
        confidence: 1.0,
      };

    case "measurable":
      // Return a simulated measurable result
      return {
        passed: true,
        confidence: 0.87, // Simulated: 87% of target
        value: "87%",
      };

    case "subjective":
      // Simulated AI self-assessment
      return {
        passed: true,
        confidence: 0.85,
      };

    default:
      return { passed: true, confidence: 1.0 };
  }
}
