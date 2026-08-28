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

// ─── Link Type ──────────────────────────────────────────────────────────────

/**
 * A relationship link between two Primes.
 *
 * Links form the edges of the Prime dependency graph and are used by the
 * compiler for conflict detection, load-order resolution, and coverage checks.
 */
export interface Link {
  /**
   * The relation this link instantiates, as the name a Model Package declared
   * it under. The engine deliberately does not enumerate the legal values: what
   * `requires` or `contradicts` mean for traversal, load order and conflict is
   * declared in the model's relation semantics, never here.
   */
  type: string;
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
