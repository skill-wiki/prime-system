/**
 * @module compiled
 * Compiled output types for the Prime Language compiler.
 *
 * After parsing and validation, .prime files are compiled into structured
 * outputs: indexes for discovery, bundles for distribution, and graph data
 * for dependency analysis.
 */

import type { Identifier, Version, Tag, PrimeType, Author, License } from "./base";
import type { LinkType, Direction } from "./links";

// ─── Index Entry ────────────────────────────────────────────────────────────

/**
 * An entry in the compiled Prime index.
 *
 * The index provides a searchable registry of all compiled Primes,
 * enabling discovery by name, type, tags, and description.
 */
export interface IndexEntry {
  /** Unique identifier of the Prime */
  name: Identifier;
  /** Semantic version */
  version: Version;
  /** The Prime class type */
  type: PrimeType;
  /** One-line description */
  description?: string;
  /** Classification tags */
  tags?: Tag[];
  /** Author information */
  author?: Author;
  /** License */
  license?: License;
  /** Direct dependencies (REQUIRES links) */
  dependencies?: Identifier[];
  /** Optional enhancements (ENHANCES links) */
  enhancements?: Identifier[];
  /** Contradictions (CONTRADICTS links) */
  contradictions?: Identifier[];
  /** Path to the source .prime file */
  source_path?: string;
  /** Path to the compiled output */
  compiled_path?: string;
  /** SHA-256 hash of the compiled content for integrity verification */
  content_hash?: string;
  /** Compilation timestamp */
  compiled_at?: string;
}

// ─── Bundle Entry ───────────────────────────────────────────────────────────

/**
 * A bundle entry containing the compiled content of a Prime and
 * all its resolved dependencies.
 *
 * Bundles are self-contained units for distribution and runtime loading.
 */
export interface BundleEntry {
  /** The primary Prime in this bundle */
  primary: Identifier;
  /** Version of the primary Prime */
  version: Version;
  /** All Primes included in this bundle (primary + dependencies) */
  includes: BundleInclude[];
  /** The resolved dependency graph for this bundle */
  graph: GraphData;
  /** Total size of the bundle in bytes */
  size_bytes?: number;
  /** When this bundle was created */
  created_at?: string;
}

/**
 * A single Prime included in a bundle.
 */
export interface BundleInclude {
  /** Identifier of the included Prime */
  name: Identifier;
  /** Version of the included Prime */
  version: Version;
  /** The Prime class type */
  type: PrimeType;
  /** Why this Prime is included (direct dependency, transitive, enhancement) */
  reason: "primary" | "dependency" | "transitive" | "enhancement";
  /** The compiled content (JSON-serialized Prime) */
  content: Record<string, unknown>;
}

// ─── Dependency Graph ───────────────────────────────────────────────────────

/**
 * The resolved dependency graph for a set of Primes.
 *
 * Used by the compiler for conflict detection, cycle detection,
 * and load-order resolution.
 */
export interface GraphData {
  /** All nodes (Primes) in the graph */
  nodes: GraphNode[];
  /** All edges (relationships) in the graph */
  edges: GraphEdge[];
  /** Detected conflicts (should be empty for valid compilations) */
  conflicts?: GraphConflict[];
  /** The resolved load order (topologically sorted) */
  load_order?: LoadPhase[];
}

/**
 * A node in the dependency graph representing a single Prime.
 */
export interface GraphNode {
  /** Identifier of the Prime */
  id: Identifier;
  /** Version of the Prime */
  version: Version;
  /** The Prime class type */
  type: PrimeType;
  /** Tags for filtering */
  tags?: Tag[];
}

/**
 * An edge in the dependency graph representing a relationship between Primes.
 */
export interface GraphEdge {
  /** Source Prime identifier */
  from: Identifier;
  /** Target Prime identifier */
  to: Identifier;
  /** Relationship type */
  link_type: LinkType;
  /** Temporal direction */
  direction: Direction;
  /** Whether this is a required relationship */
  required: boolean;
}

/**
 * A detected conflict in the dependency graph.
 */
export interface GraphConflict {
  /** Type of conflict */
  type: "contradiction" | "cycle" | "version_mismatch" | "transitive_contradiction";
  /** Primes involved in the conflict */
  involved: Identifier[];
  /** Human-readable description of the conflict */
  message: string;
  /** Severity of the conflict */
  severity: "error" | "warn";
}

/**
 * A phase in the resolved load order.
 * Primes within the same phase can be loaded in parallel.
 */
export interface LoadPhase {
  /** Phase number (0 = first to load) */
  phase: number;
  /** Phase timing relative to the primary Prime */
  timing: "before" | "execute" | "during" | "after";
  /** Primes to load in this phase */
  primes: Identifier[];
}

// ─── Compiled Output ────────────────────────────────────────────────────────

/**
 * The top-level compiled output of the Prime compiler.
 *
 * Contains the index of all compiled Primes, optional bundles for
 * distribution, and the global dependency graph.
 */
export interface CompiledOutput {
  /** Compiler version that produced this output */
  compiler_version: Version;
  /** When this compilation was performed */
  compiled_at: string;
  /** Index of all compiled Primes */
  index: IndexEntry[];
  /** Pre-built bundles for distribution */
  bundles?: BundleEntry[];
  /** Global dependency graph across all compiled Primes */
  graph: GraphData;
  /** Compilation diagnostics (errors, warnings) */
  diagnostics?: CompilationDiagnostic[];
}

/**
 * A compilation diagnostic message (error or warning).
 */
export interface CompilationDiagnostic {
  /** Severity level */
  severity: "error" | "warn" | "info";
  /** Diagnostic code (e.g. "E001", "W003") */
  code?: string;
  /** Human-readable message */
  message: string;
  /** The Prime this diagnostic applies to */
  prime?: Identifier;
  /** Source file path */
  file?: string;
  /** Line number in source */
  line?: number;
  /** Column number in source */
  column?: number;
}
