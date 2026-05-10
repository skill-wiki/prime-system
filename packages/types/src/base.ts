/**
 * @module base
 * Base types for the Prime Language type system.
 *
 * PrimeBase is the root of all Prime types. Every Prime document
 * (Knowledge, Method, Rule) inherits these foundational fields.
 */

import type { Link } from "./links";
import type { Evaluation } from "./evaluation";

// ─── Primitive Value Types ──────────────────────────────────────────────────

/**
 * Unique identifier for a Prime document.
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

/**
 * Classification tag for a Prime document.
 * Must be kebab-case: [a-z][a-z0-9-]*, max 32 characters.
 *
 * @example "security", "testing", "web"
 */
export type Tag = string;

/**
 * Open-source license identifier.
 * Common values are enumerated; any valid SPDX identifier is allowed.
 */
export type License =
  | "MIT"
  | "Apache-2.0"
  | "CC-BY-4.0"
  | "CC-BY-SA-4.0"
  | (string & {});

/**
 * Author information for a Prime document.
 */
export interface Author {
  /** Author's display name */
  name: string;
  /** URL to the author's profile or website (e.g. GitHub profile) */
  url?: string;
  /** Organization the author belongs to */
  org?: string;
}

// ─── Decorator / Modifier Types ─────────────────────────────────────────────

/**
 * Field-level decorators that modify compiler checking behavior.
 */
export type FieldDecorator =
  | "@rule"
  | "@safe"
  | "@decidable"
  | "@subjective"
  | "@deprecated"
  | "@experimental";

/**
 * Prime-level decorators that modify the Prime's inheritance and visibility.
 *
 * - `@abstract` — Cannot be used directly, must be inherited
 * - `@sealed` — Cannot be inherited, can only be referenced
 * - `@internal` — Not published to registry, local use only
 */
export type PrimeDecorator = "@abstract" | "@sealed" | "@internal";

// ─── Prime Base Class Types ─────────────────────────────────────────────────

/**
 * The root type for all Prime documents.
 *
 * Every Prime (Knowledge, Method, Rule) extends PrimeBase.
 * It defines the minimum required metadata that all Primes share.
 */
export interface PrimeBase {
  // ─── Required ─────────────────────────────
  /** Unique identifier in kebab-case */
  name: Identifier;
  /** Semantic version (major.minor.patch) */
  version: Version;

  // ─── Recommended ──────────────────────────
  /** One-line description (used in Index) */
  description?: string;
  /** Classification tags */
  tags?: Tag[];
  /** Author information */
  author?: Author;
  /** Open-source license */
  license?: License;

  // ─── Cross-system Interfaces ──────────────
  /** Relationships with other Primes (see Spec 02) */
  links?: Link[];
  /** Evaluation criteria (see Spec 03) */
  evaluation?: Evaluation;

  // ─── Decorators ───────────────────────────
  /** Prime-level decorators (@abstract, @sealed, @internal) */
  decorators?: PrimeDecorator[];

  // ─── Inheritance ──────────────────────────
  /** The parent Prime this one extends (if any) */
  extends?: Identifier;
}

/**
 * Discriminated union of the three concrete Prime types.
 *
 * The `type` field serves as the discriminant, allowing type-safe
 * narrowing in switch/if statements.
 */
export type PrimeType = "Knowledge" | "Method" | "Rule";
