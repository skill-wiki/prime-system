/**
 * @module @skill-wiki/types
 * Core type definitions for the Prime Language system.
 *
 * This is the foundational package that all other Prime packages depend on.
 * It exports types for:
 * - Base primitives (PrimeBase, Identifier, Version, Author, etc.)
 * - Knowledge class (definitions, categories, facts, relations)
 * - Method class (steps, parameters, control flow, error handling)
 * - Rule class (checks, thresholds, severity, exemptions)
 * - Links (relationship graph between Primes)
 * - Evaluation (success/failure criteria, confidence, reports)
 * - AST (parser output before type checking)
 * - Compiled output (indexes, bundles, dependency graphs)
 */

export * from "./base";
export * from "./knowledge";
export * from "./method";
export * from "./rule";
export * from "./links";
export * from "./evaluation";
export * from "./ast";
export * from "./compiled";
