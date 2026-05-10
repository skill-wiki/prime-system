/**
 * @module knowledge
 * Knowledge class types for the Prime Language type system.
 *
 * Knowledge Primes define "what exists" — concepts, classifications,
 * facts, and relationships between concepts. They are loaded during
 * the "understanding" phase and are never executed, only consulted.
 */

import type { PrimeBase, Identifier } from "./base";

// ─── Knowledge Value Types ──────────────────────────────────────────────────

/**
 * A concept definition within a Knowledge Prime.
 * Defines a term and its meaning in natural language.
 */
export interface Definition {
  /** The term being defined */
  term: string;
  /** Meaning of the term (natural language) */
  meaning: string;
  /** Alternative names for the term (helps AI matching) */
  aliases?: string[];
  /** Context in which this definition applies */
  context?: string;
}

/**
 * A classification category that can contain nested sub-items.
 * Used to organize knowledge into hierarchical taxonomies.
 */
export interface Category {
  /** Category name */
  name: string;
  /** Description of the category */
  description: string;
  /** Sub-items within this category (can be nested recursively) */
  items?: CategoryItem[];
}

/**
 * A single item within a Category, supporting recursive nesting.
 */
export interface CategoryItem {
  /** Item name */
  name: string;
  /** Description of the item */
  description: string;
  /** Child items for recursive nesting */
  items?: CategoryItem[];
}

/**
 * A factual statement with an associated confidence level.
 */
export interface Fact {
  /** The fact expressed as a natural language statement */
  statement: string;
  /** Degree of certainty for this fact */
  confidence: Confidence;
  /** Source reference for this fact */
  source?: Source;
}

/**
 * Confidence level for a factual statement.
 *
 * - `proven` — Rigorously proven (mathematics, physics laws)
 * - `consensus` — Industry consensus (best practices, standards)
 * - `emerging` — Emerging viewpoint (evidence exists but not widely accepted)
 * - `disputed` — Disputed (different schools of thought disagree)
 */
export type Confidence = "proven" | "consensus" | "emerging" | "disputed";

/**
 * A relationship between two concepts within a Knowledge Prime.
 * Describes how one concept relates to another.
 *
 * @example { from: "Injection", relation: "causes", to: "SensitiveDataExposure" }
 */
export interface KnowledgeRelation {
  /** The source concept */
  from: string;
  /** Description of the relationship */
  relation: string;
  /** The target concept */
  to: string;
}

/**
 * An authoritative source reference for knowledge content.
 * At least one of `url` or `citation` should be present.
 */
export interface Source {
  /** Title of the source */
  title: string;
  /** URL to the source */
  url?: string;
  /** Academic citation format */
  citation?: string;
  /** Publication year */
  year?: number;
}

/**
 * A concrete example showing how knowledge is applied.
 */
export interface Example {
  /** Description of the scenario */
  scenario: string;
  /** How the knowledge is applied in this scenario */
  application: string;
  /** The outcome of applying the knowledge */
  outcome?: string;
}

// ─── Knowledge Meta-Evaluation ──────────────────────────────────────────────

/**
 * Meta-evaluation criteria specific to Knowledge Primes (Layer 3).
 * Assesses the quality of the knowledge itself.
 */
export interface KnowledgeMetaEvaluation {
  /** Whether the knowledge completely covers its declared domain */
  completeness: string;
  /** Whether the content is consistent with authoritative sources */
  accuracy: string;
  /** Whether the knowledge is current (used with valid_until) */
  currency: string;
  /** Whether authoritative source citations are present */
  citation: string;
}

// ─── Knowledge Prime ────────────────────────────────────────────────────────

/**
 * The Knowledge class Prime — defines "what exists" in the world.
 *
 * Knowledge Primes contain concepts, classifications, facts, and
 * relationships. They are consulted (not executed) by AI during the
 * understanding phase.
 *
 * Compiler rules:
 * - Must contain at least one of: definitions, categories, facts
 * - If valid_until is set and expired, emit a compile warning
 * - If sources are present, each must have a url or citation
 */
export interface Knowledge extends PrimeBase {
  /** Discriminant field */
  type: "Knowledge";

  // ─── Content (at least one required) ────────
  /** Concept definitions */
  definitions?: Definition[];
  /** Classification taxonomies */
  categories?: Category[];
  /** Factual statements */
  facts?: Fact[];
  /** Relationships between concepts */
  relationships?: KnowledgeRelation[];

  // ─── Optional ─────────────────────────────────
  /** Authoritative source references */
  sources?: Source[];
  /** Concrete examples of knowledge application */
  examples?: Example[];
  /** Expiration date for the knowledge (standards expire) */
  valid_until?: string;

  // ─── Meta-Evaluation ──────────────────────────
  /** Knowledge-specific meta-evaluation (Layer 3) */
  meta_evaluation?: KnowledgeMetaEvaluation;
}
