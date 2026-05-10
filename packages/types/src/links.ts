/**
 * @module links
 * Relationship/link types for the Prime Language type system.
 *
 * The relationship system (Spec 02) connects Primes into a knowledge graph.
 * Links declare dependencies, enhancements, validations, contradictions,
 * specializations, and knowledge supply chains between Primes.
 */

import type { Identifier } from "./base";

// ─── Enums ──────────────────────────────────────────────────────────────────

/**
 * The six relationship types between Primes.
 *
 * - `REQUIRES` — Hard dependency. A cannot execute without B.
 * - `ENHANCES` — Soft dependency. A works better with B, but B is optional.
 * - `VALIDATES` — Verification. B (Rule) validates A (Method) output.
 * - `CONTRADICTS` — Mutual exclusion. A and B cannot coexist.
 * - `SPECIALIZES` — Specialization. A is a domain-specific version of B.
 * - `SUPPLIES` — Knowledge supply. A (Knowledge) feeds data into B (Method).
 */
export enum LinkType {
  /** Hard dependency — target must be loaded first */
  REQUIRES = "REQUIRES",
  /** Soft dependency — recommended but not mandatory */
  ENHANCES = "ENHANCES",
  /** Verification — target Rule validates source Method output */
  VALIDATES = "VALIDATES",
  /** Mutual exclusion — cannot coexist in the same dependency tree */
  CONTRADICTS = "CONTRADICTS",
  /** Specialization — source is a domain-specific version of target */
  SPECIALIZES = "SPECIALIZES",
  /** Knowledge supply — source provides data consumed by target */
  SUPPLIES = "SUPPLIES",
}

/**
 * Temporal direction of a relationship, indicating load/execution order.
 *
 * - `before` — Target Prime loads/executes before the source
 * - `after` — Target Prime executes after the source
 * - `during` — Target is consulted during execution (on-demand)
 * - `any` — No temporal ordering required
 */
export enum Direction {
  /** Target loads before the source */
  before = "before",
  /** Target executes after the source */
  after = "after",
  /** Target is referenced during execution */
  during = "during",
  /** No ordering constraint */
  any = "any",
}

/**
 * Relationship verb keywords used in shorthand link declarations.
 * Kept for backward compatibility with the parser.
 */
export type LinkVerb =
  | "requires"
  | "enhances"
  | "validates_with"
  | "contradicts"
  | "specializes"
  | "supplies_to";

// ─── Link Type ──────────────────────────────────────────────────────────────

/**
 * A relationship link between two Primes.
 *
 * Links form the edges of the Prime dependency graph and are used by the
 * compiler for conflict detection, load-order resolution, and coverage checks.
 */
export interface Link {
  /** The type of relationship */
  type: LinkType;
  /** The source Prime (the one declaring this link) */
  from?: Identifier;
  /** The target Prime */
  to: Identifier;
  /** Optional: target a specific block within the target Prime */
  to_block?: string;
  /** Whether this is a hard requirement (true) or a recommendation (false) */
  required: boolean;
  /** Temporal direction of the relationship */
  direction: Direction;
  /** Natural language explanation of why this relationship exists */
  reason: string;
  /** Optional condition under which this link is active */
  condition?: string;
}

// ─── Shorthand Mapping ──────────────────────────────────────────────────────

/**
 * Default values for shorthand link declarations in .prime files.
 *
 * | Shorthand         | LinkType      | direction | required |
 * |-------------------|---------------|-----------|----------|
 * | requires X        | REQUIRES      | before    | true     |
 * | enhances X        | ENHANCES      | any       | false    |
 * | validates_with X  | VALIDATES     | after     | true     |
 * | contradicts X     | CONTRADICTS   | any       | true     |
 * | specializes X     | SPECIALIZES   | any       | false    |
 * | supplies_to X     | SUPPLIES      | before    | true     |
 */
export interface LinkShorthandDefaults {
  type: LinkType;
  direction: Direction;
  required: boolean;
}

/**
 * Lookup table for shorthand link defaults, indexed by the shorthand keyword.
 */
export const LINK_SHORTHAND_DEFAULTS: Record<string, LinkShorthandDefaults> = {
  requires: { type: LinkType.REQUIRES, direction: Direction.before, required: true },
  enhances: { type: LinkType.ENHANCES, direction: Direction.any, required: false },
  validates_with: { type: LinkType.VALIDATES, direction: Direction.after, required: true },
  contradicts: { type: LinkType.CONTRADICTS, direction: Direction.any, required: true },
  specializes: { type: LinkType.SPECIALIZES, direction: Direction.any, required: false },
  supplies_to: { type: LinkType.SUPPLIES, direction: Direction.before, required: true },
};
