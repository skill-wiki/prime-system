/**
 * @module types
 * Runtime-specific types for the Prime Language runtime system.
 *
 * These types are used by IndexManager and PrimeLoader.
 *
 * NOTE: the execution/evaluation half of this file (Step, ExecutionContext,
 * RuntimeCriterion and friends) described the deleted PrimeExecutor /
 * EvaluationEngine lifecycle. Those types are still on this package's public
 * export surface (`index.ts` does `export * from "./types"`) but no longer have
 * any implementation behind them. Whether to drop them needs a cross-package
 * consumer measurement — see `docs/lanes/W3-1-RUNTIME-VERTICAL.md` §3.
 */

import type { Identifier, PrimeType, Link } from "@skill-wiki/types";

// ─── Index Types ───────────────────────────────────────────────────────────

/**
 * A single entry in the prime.index file (~20 tokens each).
 * Kept minimal so the full index can live in the AI context window.
 */
export interface IndexEntry {
  /** Prime name (kebab-case identifier) */
  name: Identifier;
  /** Prime class type */
  type: PrimeType;
  /** Compact function signature, e.g. "tdd(task, lang) -> tests, impl" */
  sig: string;
  /** One-line description (for AI matching) */
  desc: string;
  /** Abbreviated relationship links */
  links?: string[];
}

/**
 * The complete index file loaded from .primes/prime.index.
 */
export interface PrimeIndex {
  /** All indexed Prime entries */
  primes: IndexEntry[];
}

// ─── Loader Types ──────────────────────────────────────────────────────────

/**
 * Loading levels for progressive detail.
 *
 * | Level | Content            | Approx Tokens |
 * |-------|--------------------|---------------|
 * | L0    | Index entry        | ~20           |
 * | L1    | Method/core block  | ~30-50        |
 * | L2    | Full compiled .md  | ~60-100       |
 * | L3    | .prime source      | ~150-300      |
 */
export type LoadLevel = 0 | 1 | 2 | 3;

/**
 * A single step in a relationship-driven load sequence.
 * Produced by PrimeLoader.resolveLoadOrder().
 */
export interface LoadStep {
  /** Which Prime to load */
  name: Identifier;
  /** At what level */
  level: LoadLevel;
  /** Why this load is needed */
  reason: string;
  /** Relationship that triggered this load step */
  relationship?: string;
  /** Whether this step runs before or after the primary Prime */
  phase: "before" | "primary" | "after";
}

// ─── Tool Definition Types ─────────────────────────────────────────────────

/**
 * A tool parameter definition for function calling integration.
 */
export interface ToolParameter {
  type: string;
  description: string;
  enum?: (string | number)[];
}

/**
 * A tool definition suitable for AI function calling.
 * Matches the standard tool/function schema used by LLM APIs.
 */
export interface ToolDefinition {
  /** Tool name (e.g. "prime_tdd") */
  name: string;
  /** Human-readable description for the AI */
  description: string;
  /** Parameter schema */
  parameters: Record<string, ToolParameter>;
}

// ─── Execution Types ───────────────────────────────────────────────────────

/**
 * Execution status for the state machine.
 */
export type ExecutionStatus =
  | "pending"
  | "loading"
  | "executing"
  | "evaluating"
  | "done"
  | "error";

/**
 * Tracks the runtime state of a Prime execution.
 */
export interface ExecutionState {
  /** Which Prime is being executed */
  prime: Identifier;
  /** Current status */
  status: ExecutionStatus;
  /** Currently executing step name, or null */
  current_step: string | null;
  /** Names of steps that have completed */
  steps_completed: string[];
  /** Current loop iteration (0-based) */
  loop_iteration: number;
  /** Errors encountered during execution */
  errors_encountered: ExecutionError[];
  /** Highest loaded level for this Prime */
  loaded_level: LoadLevel;
  /** Which blocks have been loaded */
  loaded_blocks: string[];
  /** Which dependency Primes have been loaded */
  dependencies_loaded: Identifier[];
  /** Evaluation result, populated after evaluation phase */
  evaluation_result: EvaluationReport | null;
}

/**
 * An error encountered during execution.
 */
export interface ExecutionError {
  /** Which step caused the error */
  step: string;
  /** Error message */
  message: string;
  /** Whether the error was handled (retried, fallback, etc.) */
  handled: boolean;
  /** How the error was handled */
  handler?: string;
}

/**
 * Result of checking a single precondition.
 */
export interface RequirementCheck {
  /** The condition text */
  condition: string;
  /** Whether the condition is met */
  met: boolean;
  /** Error message if not met */
  error?: string;
}

/**
 * Result of checking all preconditions for a Prime.
 */
export interface RequirementResult {
  /** Whether all requirements are satisfied */
  satisfied: boolean;
  /** Individual check results */
  checks: RequirementCheck[];
}

/**
 * The result of executing a Prime.
 */
export interface ExecutionResult {
  /** Whether execution completed successfully */
  success: boolean;
  /** The execution state at completion */
  state: ExecutionState;
  /** Output values produced by the execution */
  outputs: Record<string, any>;
  /** Evaluation report (if evaluation phase ran) */
  evaluation?: EvaluationReport;
}

// ─── Step Execution Types ──────────────────────────────────────────────────

/**
 * Result of executing a single step.
 */
export interface StepResult {
  /** Step name */
  name: string;
  /** Whether the step succeeded */
  success: boolean;
  /** Output or side-effect description */
  output?: string;
  /** Error if the step failed */
  error?: ExecutionError;
  /** Number of retries attempted */
  retries?: number;
}

// ─── Evaluation Types ──────────────────────────────────────────────────────

/**
 * Decidability classification for a criterion.
 */
export type Decidability = "decidable" | "measurable" | "subjective";

/**
 * Result detail for a single criterion evaluation.
 */
export interface CriterionResult {
  /** Criterion identifier */
  id: string;
  /** Pass or fail */
  result: "pass" | "fail";
  /** Confidence in this specific result (0-1) */
  confidence: number;
  /** Decidability of this criterion */
  decidability: Decidability;
  /** Weight used in scoring */
  weight: number;
  /** Measured value (for @measurable criteria) */
  value?: string;
  /** Additional note (e.g. "subjective, suggest human review") */
  note?: string;
}

/**
 * Overall verdict for an evaluation.
 */
export type Verdict = "SUCCESS" | "FAIL" | "PARTIAL";

/**
 * Confidence policy thresholds.
 */
export interface ConfidencePolicy {
  /** Score at or above which to auto-approve (default 0.95) */
  auto_approve: number;
  /** Score below which human review is needed (default 0.80) */
  human_review: number;
  /** Score below which to auto-reject (default 0.50) */
  auto_reject: number;
}

/**
 * The complete evaluation report generated after execution.
 * Matches the report format defined in Spec 03 / Spec 06.
 */
export interface EvaluationReport {
  /** Overall verdict */
  verdict: Verdict;
  /** Weighted score (0-1) */
  score: number;
  /** Overall confidence (0-1) */
  confidence: number;
  /** Per-criterion details */
  details: CriterionResult[];
  /** Criteria IDs that need human review */
  human_review_needed: string[];
  /** Failure criteria check results */
  failure_checks?: CriterionResult[];
}

// ─── Evaluation Input Types ────────────────────────────────────────────────

/**
 * A criterion definition passed to the evaluation engine.
 * Kept as the runtime-side shape, slightly different from the
 * @skill-wiki/types Criterion which is the AST/compiler representation.
 * Its former consumer (EvaluationEngine) was deleted; see the module note above.
 */
export interface RuntimeCriterion {
  /** Unique identifier */
  id: string;
  /** Description */
  description: string;
  /** Decidability tag */
  decidability: Decidability;
  /** Weight (0-1) for weighted scoring */
  weight: number;
  /** Verification method */
  verify_method?: RuntimeVerifyMethod;
}

/**
 * Verification method for a runtime criterion.
 */
export type RuntimeVerifyMethod =
  | { type: "rule"; prime: string }
  | { type: "script"; command: string }
  | { type: "check"; condition: string }
  | { type: "ai_judge"; prompt: string };

/**
 * Success criteria configuration passed to evaluation.
 */
export interface RuntimeSuccessCriteria {
  mode: "all" | "any" | "weighted";
  min_score?: number;
  criteria: RuntimeCriterion[];
}

/**
 * Failure criteria configuration passed to evaluation.
 */
export interface RuntimeFailureCriteria {
  mode: "any";
  criteria: RuntimeCriterion[];
}

/**
 * The Prime-level evaluation configuration passed into the engine.
 */
export interface PrimeEvaluationConfig {
  success_criteria: RuntimeSuccessCriteria;
  failure_criteria?: RuntimeFailureCriteria;
  confidence_policy?: ConfidencePolicy;
}

/**
 * Context data from execution, used by the evaluator to assess criteria.
 */
export interface ExecutionContext {
  /** Outputs produced during execution */
  outputs: Record<string, any>;
  /** Step results from execution */
  step_results: StepResult[];
  /** Any additional context */
  [key: string]: any;
}
