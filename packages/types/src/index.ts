/**
 * @module @skill-wiki/types
 * Syntax-level type definitions for the Prime language.
 *
 * This package is deliberately small: it describes the *shape of source text*
 * and nothing about any domain. It exports
 * - AST node types (parser output before any model is resolved)
 * - the two syntax primitives (`Identifier`, `Version`) and the declaration
 *   decorators those nodes refer to
 *
 * It used to also carry the v1 Knowledge / Method / Rule ontology (`PrimeBase`,
 * `Fact`, `Category`, `Method`, `Rule`, `Evaluation`, `Link`) — 961 lines with
 * no importer left in the workspace. Plan §3.1 forbids the engine from knowing
 * what a Fact is, and §15.2 puts a v1 vocabulary in
 * `adapters/sources/prime-v1/` as an external Model Package, not in Core. The
 * ontology was therefore deleted rather than re-homed inside the engine; the
 * live definition of the v1 vocabulary is `compat/prime-v1-model/`.
 */

export * from "./base";
export * from "./ast";
