/**
 * @module method
 * Method class types for the Prime Language type system.
 *
 * Method Primes define "how to do things" — steps, flows, error handling,
 * and control flow. They are loaded during the "execution" phase and
 * processed step-by-step.
 */

import type { PrimeBase, Identifier, Version } from "./base";

// ─── Method Value Types ─────────────────────────────────────────────────────

/**
 * A parameter declaration for Method input or output.
 */
export interface Parameter {
  /** Parameter name (kebab-case identifier) */
  name: Identifier;
  /** The type of the parameter */
  type: ParamType;
  /** Human-readable description */
  description?: string;
  /** Whether this parameter is optional */
  optional?: boolean;
  /** Default value (as string representation) */
  default?: string;
}

/**
 * The type of a Method parameter.
 *
 * Built-in types:
 * - `string` — Natural language text
 * - `code` — Source code
 * - `number` — Numeric value
 * - `boolean` — Boolean value
 * - `list` — A list
 * - `file` — File path
 * - `any` — Any type
 *
 * Can also be an Identifier referencing another Prime's output type.
 */
export type ParamType =
  | "string"
  | "code"
  | "number"
  | "boolean"
  | "list"
  | "file"
  | "any"
  | Identifier;

/**
 * A single execution step within a Method.
 * Steps are ordered and can contain sub-steps for nesting.
 */
export interface Step {
  /** Step name (e.g. RED, GREEN, REFACTOR) */
  name: Identifier;
  /** Natural language description of the action to perform */
  description: string;
  /** Expected result after executing this step */
  expect?: ExpectResult;
  /** Error handling strategy (required — use "@safe" if no errors are possible) */
  error_handler: ErrorHandler;
  /** Nested sub-steps */
  sub_steps?: Step[];
  /** Primes referenced within this step */
  use?: Reference[];
}

/**
 * The expected result of a step execution.
 */
export interface ExpectResult {
  /** What result is expected */
  result: "pass" | "fail" | "any";
  /** How to verify the result (natural language) */
  verify?: string;
}

/**
 * Error handling strategy for a step.
 *
 * Can be one of:
 * - A simple error message string
 * - A structured error handler with retry/fallback/escalate options
 * - The literal `"@safe"` indicating no error handling is needed
 */
export type ErrorHandler = string | ErrorHandlerObject | "@safe";

/**
 * Structured error handler with retry and fallback options.
 */
export interface ErrorHandlerObject {
  /** Error message */
  message: string;
  /** Number of retry attempts */
  retry?: number;
  /** Fallback action if retries are exhausted */
  fallback?: string;
  /** Escalation message (e.g. notify a human) */
  escalate?: string;
}

/**
 * A precondition that must be satisfied before a Method can execute.
 */
export interface Precondition {
  /** The condition expressed in natural language */
  condition: string;
  /** Error message if the condition is not met */
  error_if_unmet: string;
}

/**
 * A reference to another Prime, optionally targeting specific blocks or steps.
 */
export interface Reference {
  /** Identifier of the referenced Prime */
  prime: Identifier;
  /** Version constraint for the referenced Prime */
  version?: Version;
  /** Target a specific block within the Prime (steps, checks, definitions, ...) */
  block?: string;
  /** Target a specific step within the Prime */
  step?: string;
  /** Local alias to use when referencing this Prime */
  alias?: string;
}

/**
 * Loop control for repeating the Method's steps.
 */
export interface LoopCondition {
  /** Natural language termination condition */
  until: string;
  /** Maximum iterations as a safety valve */
  max_iterations?: number;
}

/**
 * A conditional branch (global exception handling).
 */
export interface Branch {
  /** Trigger condition (natural language) */
  condition: string;
  /** Action to take when the condition is met */
  action: string;
}

/**
 * An anti-pattern warning with correction guidance.
 * Used to catch common mistakes and redirect the AI.
 */
export interface Warning {
  /** Trigger phrase (something the user might say) */
  trigger: string;
  /** Correction (what the AI should respond with) */
  correction: string;
}

/**
 * A criterion for judging success or failure of a Method execution.
 * Used in success_criteria and failure_criteria arrays.
 */
export interface Criterion {
  /** Natural language description of the criterion */
  description: string;
  /** Whether this criterion can be objectively determined */
  decidability: "@decidable" | "@subjective";
  /** Which Rule Prime to use for verification */
  verify_with?: Reference;
}

// ─── Method Meta-Evaluation ─────────────────────────────────────────────────

/**
 * Meta-evaluation criteria specific to Method Primes (Layer 3).
 * Assesses the quality of the method itself.
 */
export interface MethodMetaEvaluation {
  /** Whether the same input consistently produces the same output */
  determinism: string;
  /** Whether error handling covers all possible exceptions */
  error_coverage: string;
  /** Whether this Method can be automatically tested */
  testability: string;
  /** The boundary of this Method's applicability */
  scope: string;
}

// ─── Method Prime ───────────────────────────────────────────────────────────

/**
 * The Method class Prime — defines "how to do things".
 *
 * Method Primes contain ordered steps with error handling,
 * input/output declarations, control flow, and anti-pattern warnings.
 * They are executed step-by-step by the AI during the execution phase.
 *
 * Compiler rules:
 * - Every Step must have an error_handler (explicit or @safe)
 * - Every input parameter must be referenced in steps (warn if unused)
 * - Every output must be produced in steps (error if unreachable)
 * - success_criteria items must be marked @decidable or @subjective
 * - Referenced Primes (use) must exist and have compatible versions
 */
export interface Method extends PrimeBase {
  /** Discriminant field */
  type: "Method";

  // ─── Required ───────────────────────────────
  /** Input parameters the method accepts */
  input: Parameter[];
  /** Output parameters the method produces */
  output: Parameter[];
  /** Ordered execution steps */
  steps: Step[];

  // ─── Preconditions ──────────────────────────
  /** Conditions that must be met before execution */
  require?: Precondition[];

  // ─── References ─────────────────────────────
  /** Other Primes referenced by this Method */
  use?: Reference[];

  // ─── Control Flow ───────────────────────────
  /** Loop condition for repeating the steps */
  loop?: LoopCondition;
  /** Global exception branches */
  branches?: Branch[];

  // ─── Anti-patterns ──────────────────────────
  /** Common mistakes and their corrections */
  warnings?: Warning[];

  // ─── Judgment ───────────────────────────────
  /** Success criteria for this Method */
  success_criteria?: Criterion[];
  /** Failure criteria for this Method */
  failure_criteria?: Criterion[];

  // ─── Meta-Evaluation ──────────────────────────
  /** Method-specific meta-evaluation (Layer 3) */
  meta_evaluation?: MethodMetaEvaluation;
}
