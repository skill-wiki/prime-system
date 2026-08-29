/**
 * @module base
 * Syntax-level primitives shared by the AST nodes.
 *
 * This file used to declare `PrimeBase` — the root of the v1 Knowledge / Method
 * / Rule ontology — together with the `PrimeType = "Knowledge" | "Method" |
 * "Rule"` closed set. Plan §3.1 puts that knowledge outside the engine: what
 * unit types exist, what fields they carry and how they relate is declared by a
 * Model Package, and the engine only sees `UnitIR`. The ontology had no
 * importer left anywhere in the workspace, so it is gone rather than adapted.
 *
 * What remains are the two aliases and the one decorator set the syntax layer
 * genuinely needs: they describe the *shape of source text*, not a domain.
 */

// ─── Primitive Value Types ──────────────────────────────────────────────────

/**
 * Unique identifier for a declaration.
 * Must be kebab-case: [a-z][a-z0-9-]*, max 64 characters.
 *
 * @example "tdd-red-green-refactor", "owasp-top-10"
 */
export type Identifier = string;

/**
 * Semantic version string following semver format.
 *
 * @example "1.0.0", "2.3.1"
 */
export type Version = string;

// ─── Decorator / Modifier Types ─────────────────────────────────────────────

/**
 * Declaration-level decorators that modify inheritance and visibility.
 *
 * These are lexical modifiers the parser recognises ahead of a declaration
 * keyword, so they belong to the syntax and not to any model's vocabulary.
 *
 * - `@abstract` — Cannot be used directly, must be inherited
 * - `@sealed` — Cannot be inherited, can only be referenced
 * - `@internal` — Not published to registry, local use only
 */
export type PrimeDecorator = "@abstract" | "@sealed" | "@internal";
