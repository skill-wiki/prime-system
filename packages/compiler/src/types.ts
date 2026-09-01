/**
 * @module types
 * Diagnostic, compile result, and options types for the AOE compiler.
 */

// ─── Diagnostic ────────────────────────────────────────────────────────────

/**
 * A single diagnostic message emitted by any checker level.
 */
export interface Diagnostic {
  /** Severity: error blocks compilation, warn is advisory, suggestion is optional */
  level: "error" | "warn" | "suggestion";
  /** Source line number (1-based) where the issue was detected */
  line: number;
  /** Human-readable description of the issue */
  message: string;
  /** Suggested fix (natural language) */
  suggestion?: string;
  /** Which checker phase produced this diagnostic */
  source?:
    | "L1:structure"
    | "L2:logic"
    | "L3:domain"
    | "L3:cross:C1"
    | "L3:cross:C2"
    | "L3:cross:C3"
    | "L3:cross:C4"
    | "resolver"
    | string;
}

// ─── Compile Options ───────────────────────────────────────────────────────

/**
 * Options for the compile() function.
 */
export interface CompileOptions {
  /**
   * Check depth level.
   * - 1: Structural checks only (deterministic, no AI, offline)
   * - 2: Structural + Logic checks (AI-powered)
   * - 3: Structural + Logic + Domain checks (AI-powered, --deep)
   *
   * @default 1
   */
  level?: 1 | 2 | 3;

  /** Output directory for compiled artifacts */
  output?: string;

  /** Whether to generate a .bundle.md with inlined dependencies */
  bundle?: boolean;

  /**
   * Map of installed AOE names to their AST representations.
   * Used for cross-AOE reference checking and dependency resolution.
   */
  installedPrimes?: Map<string, InstalledPrime>;
}

// ─── Installed AOE ───────────────────────────────────────────────────────

/**
 * Minimal representation of an installed AOE used for cross-referencing.
 */
export interface InstalledPrime {
  name: string;
  version: string;
  type: string;
  /** The raw AST of the installed AOE */
  ast?: unknown;
  /** The compiled Markdown content */
  compiled?: string;
  /** Link declarations from this AOE */
  links?: Array<{ type: string; to: string }>;
  /** Decorator names on this AOE */
  decorators?: string[];
}

// ─── Compile Result ────────────────────────────────────────────────────────

/**
 * The result of compiling a .prime source file.
 */
export interface CompileResult {
  /** Whether compilation succeeded (no errors) */
  success: boolean;
  /** All diagnostics from all checker levels */
  diagnostics: Diagnostic[];
  /** Compiled output artifacts (only if success=true) */
  outputs?: CompileOutputs;
}

/**
 * The set of compiled output files.
 */
export interface CompileOutputs {
  /** Optimized Markdown (compiled/name.md) */
  md: string;
  /** Bundle with inlined dependencies (compiled/name.bundle.md) — only if bundle=true */
  bundle?: string;
  /** Index entry YAML (compiled/name.index.yaml) */
  index: string;
  /** Graph data YAML (compiled/name.graph.yaml) */
  graph: string;
}

// ─── Dependency Graph ──────────────────────────────────────────────────────

/**
 * A node in the dependency graph.
 */
export interface DependencyNode {
  /** AOE identifier (kebab-case) */
  id: string;
  /** AOE type (Knowledge, Method, Rule) */
  type: string;
  /** Resolved version */
  version: string;
}

/**
 * An edge in the dependency graph.
 */
export interface DependencyEdge {
  /** Source AOE identifier */
  from: string;
  /** Target AOE identifier */
  to: string;
  /** Relationship type */
  type: string;
  /** Whether this dependency is required */
  required: boolean;
  /** Temporal direction */
  direction?: "before" | "after" | "during" | "any";
}

/**
 * The resolved dependency graph for a AOE and all its transitive dependencies.
 */
export interface DependencyGraph {
  /** All nodes (unique Primes) */
  nodes: DependencyNode[];
  /** All edges (relationships) */
  edges: DependencyEdge[];
  /** Topologically sorted load order (identifiers) */
  loadOrder: string[];
}
