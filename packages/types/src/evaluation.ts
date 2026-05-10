/**
 * @module evaluation
 * Evaluation and judgment types for the Prime Language type system.
 *
 * The evaluation system (Spec 03) provides three layers of assessment:
 * - Layer 1: Runtime evaluation (did this execution succeed?)
 * - Layer 2: Cross-evaluation (do Primes work well together?)
 * - Layer 3: Meta-evaluation (is the Prime itself well-designed?)
 */

import type { Identifier } from "./base";

// ─── Layer 1: Runtime Evaluation ────────────────────────────────────────────

/**
 * Success criteria for a Method execution.
 * Defines how to determine if an execution was successful.
 */
export interface SuccessCriteria {
  /** How criteria are combined: all must pass, any can pass, or weighted scoring */
  mode: "all" | "any" | "weighted";
  /** Minimum aggregate score for weighted mode (0-1) */
  min_score?: number;
  /** The individual criteria to evaluate */
  criteria: EvaluationCriterion[];
}

/**
 * Failure criteria for a Method execution.
 * If any criterion triggers, the execution is considered failed.
 */
export interface FailureCriteria {
  /** Failure mode is always "any" — any single trigger means failure */
  mode: "any";
  /** The individual failure criteria */
  criteria: EvaluationCriterion[];
}

/**
 * A single evaluation criterion with verification method.
 * Used in both success and failure criteria.
 */
export interface EvaluationCriterion {
  /** Unique identifier for this criterion */
  id: string;
  /** Natural language description */
  description: string;
  /** How objectively this criterion can be determined */
  decidability: Decidability;
  /** How to verify this criterion */
  verify_method: VerifyMethod;
  /** Weight for weighted scoring mode (0-1) */
  weight?: number;
}

/**
 * Decidability classification for an evaluation criterion.
 *
 * - `@decidable` — Can be objectively determined (true/false)
 * - `@measurable` — Can be quantified (produces a numeric value)
 * - `@subjective` — Requires subjective judgment (AI provides confidence)
 */
export type Decidability = "@decidable" | "@measurable" | "@subjective";

/**
 * Verification method for an evaluation criterion.
 * Discriminated union on the `type` field.
 */
export type VerifyMethod =
  | VerifyByRule
  | VerifyByScript
  | VerifyByCheck
  | VerifyByAIJudge;

/**
 * Verify using a Rule Prime.
 */
export interface VerifyByRule {
  type: "rule";
  /** Identifier of the Rule Prime to use */
  prime: Identifier;
}

/**
 * Verify by running a script/command.
 */
export interface VerifyByScript {
  type: "script";
  /** Shell command to execute for verification */
  command: string;
}

/**
 * Verify by evaluating a condition expression.
 */
export interface VerifyByCheck {
  type: "check";
  /** Condition expression to evaluate */
  condition: string;
}

/**
 * Verify using AI judgment (for subjective criteria).
 */
export interface VerifyByAIJudge {
  type: "ai_judge";
  /** Prompt for the AI to make a judgment */
  prompt: string;
}

// ─── Confidence System ──────────────────────────────────────────────────────

/**
 * Confidence score breakdown for an evaluation.
 * Combines scores from decidable, measurable, and subjective criteria.
 */
export interface ConfidenceScore {
  /** Overall confidence (0-1) */
  overall: number;
  /** Breakdown by decidability category */
  breakdown: {
    /** Score from objectively decidable criteria (pass = 1.0, fail = 0.0) */
    decidable_score: number;
    /** Score from measurable criteria (actual/target ratio) */
    measurable_score: number;
    /** AI's self-assessed confidence for subjective criteria */
    subjective_score: number;
  };
  /** Per-criterion confidence factors */
  factors: ConfidenceFactor[];
}

/**
 * Confidence factor for a single criterion.
 */
export interface ConfidenceFactor {
  /** ID of the criterion this factor applies to */
  criterion_id: string;
  /** Confidence level for this criterion (0-1) */
  confidence: number;
  /** Explanation of where this confidence comes from */
  reason: string;
}

/**
 * Policy thresholds for automatic approval, human review, or rejection.
 */
export interface ConfidencePolicy {
  /** Confidence above this threshold triggers auto-approval (default 0.95) */
  auto_approve: number;
  /** Confidence below this threshold requires human review (default 0.80) */
  human_review: number;
  /** Confidence below this threshold triggers auto-rejection (default 0.50) */
  auto_reject: number;
}

/** Default confidence policy values */
export const DEFAULT_CONFIDENCE_POLICY: ConfidencePolicy = {
  auto_approve: 0.95,
  human_review: 0.80,
  auto_reject: 0.50,
};

// ─── Evaluation Report ──────────────────────────────────────────────────────

/**
 * Verdict of an evaluation: success, failure, or needs review.
 */
export type EvaluationVerdict = "SUCCESS" | "FAILURE" | "NEEDS_REVIEW";

/**
 * Result of a single criterion evaluation.
 */
export interface CriterionResult {
  /** Criterion ID */
  id: string;
  /** Whether the criterion passed, failed, or was not triggered */
  result: "pass" | "fail" | "not_triggered";
  /** Confidence in this result (0-1) */
  confidence: number;
  /** Verification method used */
  method?: string;
  /** Evidence supporting the result */
  evidence?: string;
  /** Measured value (for measurable criteria) */
  value?: string;
  /** Additional notes (e.g. "subjective judgment, recommend human review") */
  note?: string;
}

/**
 * Validation rule application result.
 */
export interface ValidationRuleResult {
  /** The Rule Prime that was applied */
  prime: Identifier;
  /** Overall result */
  result: "pass" | "warn" | "block";
  /** Detailed per-metric results */
  details: Record<string, string>;
}

/**
 * Human review request for a specific criterion.
 */
export interface HumanReviewRequest {
  /** The criterion that needs human review */
  criterion: string;
  /** Why human review is needed */
  reason: string;
}

/**
 * Execution statistics for the evaluation report.
 */
export interface ExecutionStats {
  /** Number of steps executed */
  steps_executed: number;
  /** Names of the steps executed */
  step_names?: string[];
  /** Number of loop iterations */
  loops?: number;
  /** Number of errors that were handled */
  errors_handled?: number;
  /** Total tokens consumed */
  total_tokens?: number;
  /** Total execution duration (e.g. "45s") */
  duration?: string;
}

/**
 * A complete evaluation report generated after Prime execution.
 * Contains the verdict, scores, per-criterion results, and review requests.
 */
export interface EvaluationReport {
  /** The Prime that was evaluated */
  prime: Identifier;
  /** Version of the Prime */
  version: string;
  /** When the evaluation was performed */
  timestamp: string;
  /** Input that was provided to the Prime */
  input: Record<string, unknown>;

  /** Overall verdict */
  verdict: EvaluationVerdict;
  /** Aggregate score (0-1) */
  score: number;
  /** Overall confidence (0-1) */
  confidence: number;

  /** Results for each success criterion */
  criteria_results: CriterionResult[];
  /** Results for each failure criterion check */
  failure_checks: CriterionResult[];
  /** Validation rules that were applied */
  validation_rules_applied?: ValidationRuleResult[];
  /** Criteria that need human review */
  human_review_needed?: HumanReviewRequest[];

  /** Execution statistics */
  execution_stats?: ExecutionStats;
}

// ─── Top-level Evaluation (embedded in PrimeBase) ───────────────────────────

/**
 * The top-level Evaluation object embedded in every Prime via PrimeBase.
 *
 * For Method Primes, this includes runtime success/failure criteria
 * and the confidence policy.
 *
 * For Knowledge and Rule Primes, this contains meta-evaluation fields
 * expressed as free-form strings describing quality aspects.
 *
 * This is a flexible container — the specific meta-evaluation types
 * (KnowledgeMetaEvaluation, MethodMetaEvaluation, RuleMetaEvaluation)
 * are defined in their respective modules and referenced via the
 * meta_evaluation field on each Prime type.
 */
export interface Evaluation {
  // ─── Layer 1: Runtime Evaluation (Method only) ──
  /** Success criteria for execution evaluation */
  success_criteria?: SuccessCriteria;
  /** Failure criteria for execution evaluation */
  failure_criteria?: FailureCriteria;
  /** Confidence policy overrides */
  confidence_policy?: ConfidencePolicy;

  // ─── Layer 3: Meta-Evaluation (all types) ──────
  /** Whether the Prime completely covers its declared domain */
  completeness?: string;
  /** Whether the content is consistent with authoritative sources (Knowledge) */
  accuracy?: string;
  /** Whether the knowledge is current (Knowledge, used with valid_until) */
  currency?: string;
  /** Whether authoritative source citations are present (Knowledge) */
  citation?: string;
  /** Whether the same input consistently produces the same output (Method) */
  determinism?: string;
  /** Whether error handling covers all possible exceptions (Method) */
  error_coverage?: string;
  /** Whether this Method can be automatically tested (Method) */
  testability?: string;
  /** The boundary of this Method's applicability (Method) */
  scope?: string;
  /** Whether every check can be clearly determined (Rule) */
  decidability?: string;
  /** Whether checks are internally consistent (Rule) */
  consistency?: string;
  /** Whether thresholds align with industry standards (Rule) */
  calibration?: string;
}
