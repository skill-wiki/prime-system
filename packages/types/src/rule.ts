/**
 * @module rule
 * Rule class types for the Prime Language type system.
 *
 * Rule Primes define "how to judge" — checklists, quantified thresholds,
 * severity levels, and exemptions. They are loaded during the "validation"
 * phase, after a Method has been executed, to perform self-checks.
 */

import type { PrimeBase, Identifier, Tag } from "./base";

// ─── Rule Value Types ───────────────────────────────────────────────────────

/**
 * A single check item within a Rule.
 * Each check has a natural language description and a pass condition.
 */
export interface Check {
  /** Description of what is being checked (natural language) */
  description: string;
  /** Condition that must be met for the check to pass (quantifiable or boolean) */
  pass_condition: string;
  /** Category this check belongs to */
  category?: string;
  /** Weight for aggregate scoring (0-1) */
  weight?: number;
}

/**
 * A quantified threshold for a specific metric.
 * Defines three severity tiers: block, warn, and pass.
 *
 * The values must be strictly increasing: block < warn < pass.
 */
export interface Threshold {
  /** Name of the metric being measured */
  metric: string;
  /** Unit of measurement (%, ms, count, ...) */
  unit?: string;
  /** Value at or below which the check is blocked */
  block: ThresholdValue;
  /** Value that triggers a warning */
  warn: ThresholdValue;
  /** Value at or above which the check passes */
  pass: ThresholdValue;
}

/**
 * A threshold value, either a simple number or a comparison expression.
 */
export type ThresholdValue =
  | number
  | ThresholdComparison;

/**
 * A threshold comparison with an explicit operator.
 */
export interface ThresholdComparison {
  /** Comparison operator */
  operator: "<" | "<=" | ">" | ">=" | "==";
  /** Numeric value to compare against */
  value: number;
}

/**
 * Severity level definitions for Rule outcomes.
 * Maps each severity level to the action that should be taken.
 */
export interface SeverityTable {
  /** Action for blocking severity (must fix before proceeding) */
  block: string;
  /** Action for warning severity (can proceed with caveats) */
  warn: string;
  /** Action for passing severity (all good) */
  pass: string;
  /** Action for critical severity — urgent (optional) */
  critical?: string;
}

/**
 * An exemption condition that allows bypassing a Rule.
 */
export interface Exemption {
  /** Condition under which the exemption applies (natural language) */
  condition: string;
  /** Reason why the exemption is justified */
  reason: string;
}

/**
 * Defines which Primes a Rule applies to.
 * Can be scoped by type, specific names, tags, or apply to all.
 */
export interface ApplyScope {
  /** Apply to Primes of these base types */
  prime_types?: ("Knowledge" | "Method" | "Rule")[];
  /** Apply to these specific Primes by identifier */
  prime_names?: Identifier[];
  /** Apply to Primes with any of these tags */
  tags?: Tag[];
  /** Apply to all Primes (default: false) */
  all?: boolean;
}

// ─── Rule Meta-Evaluation ───────────────────────────────────────────────────

/**
 * Meta-evaluation criteria specific to Rule Primes (Layer 3).
 * Assesses the quality of the rule itself.
 */
export interface RuleMetaEvaluation {
  /** Whether every check can be clearly determined (pass/fail) */
  decidability: string;
  /** Whether checks cover all aspects that should be verified */
  completeness: string;
  /** Whether checks are internally consistent (no contradictions) */
  consistency: string;
  /** Whether thresholds align with industry standards */
  calibration?: string;
}

// ─── Rule Prime ─────────────────────────────────────────────────────────────

/**
 * The Rule class Prime — defines "how to judge".
 *
 * Rule Primes contain check items, quantified thresholds, severity levels,
 * and exemptions. They are loaded after Method execution to validate
 * output quality.
 *
 * Compiler rules:
 * - Every Check must have a clear pass_condition
 * - pass_condition must be decidable (can yield true/false)
 * - Threshold values must satisfy: block < warn < pass (strictly increasing)
 * - If severity is present, it must cover block, warn, and pass levels
 */
export interface Rule extends PrimeBase {
  /** Discriminant field */
  type: "Rule";

  // ─── Required ───────────────────────────────
  /** Check items to evaluate */
  checks: Check[];

  // ─── Quantification ─────────────────────────
  /** Quantified metric thresholds */
  thresholds?: Threshold[];
  /** Severity level action table */
  severity?: SeverityTable;

  // ─── Exemptions ─────────────────────────────
  /** Conditions under which checks can be bypassed */
  exemptions?: Exemption[];

  // ─── Scope ──────────────────────────────────
  /** Which Primes this Rule applies to */
  applies_to?: ApplyScope;

  // ─── Meta-Evaluation ──────────────────────────
  /** Rule-specific meta-evaluation (Layer 3) */
  meta_evaluation?: RuleMetaEvaluation;
}
