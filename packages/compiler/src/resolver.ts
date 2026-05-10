/**
 * @module resolver
 * Dependency resolver for Prime compilation.
 *
 * Responsibilities:
 * - Build dependency graph from use[] and links[]
 * - Detect circular dependencies (DFS cycle detection)
 * - Detect CONTRADICTS conflicts in dependency tree
 * - Detect version conflicts
 * - Output: DependencyGraph with nodes, edges, and resolved load order
 */

import type {
  PrimeAST,
  AtomDeclaration,
  ArrayNode,
  StringNode,
  ReferenceNode,
  LinkShorthandNode,
  ObjectNode,
  FieldNode,
} from "@skill-wiki/types";
import type {
  Diagnostic,
  InstalledPrime,
  DependencyGraph,
  DependencyNode,
  DependencyEdge,
} from "./types";

type AnyAST = PrimeAST | AtomDeclaration;

function isPrimeAST(ast: AnyAST): ast is PrimeAST {
  return ast.type === "PrimeDeclaration";
}

// ─── Internal Types ────────────────────────────────────────────────────────

interface RawDependency {
  /** Target Prime identifier */
  to: string;
  /** Relationship type */
  type: string;
  /** Whether this dependency is required */
  required: boolean;
  /** Temporal direction */
  direction: "before" | "after" | "during" | "any";
  /** Source line number for diagnostics */
  line: number;
  /** Version constraint (if any) */
  version?: string;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Default direction for a link verb.
 */
function defaultDirection(verb: string): "before" | "after" | "during" | "any" {
  switch (verb) {
    case "requires":
    case "REQUIRES":
    case "supplies_to":
    case "SUPPLIES":
      return "before";
    case "validates_with":
    case "VALIDATES":
      return "after";
    default:
      return "any";
  }
}

/**
 * Default required flag for a link verb.
 */
function defaultRequired(verb: string): boolean {
  switch (verb) {
    case "requires":
    case "REQUIRES":
    case "validates_with":
    case "VALIDATES":
    case "contradicts":
    case "CONTRADICTS":
    case "supplies_to":
    case "SUPPLIES":
      return true;
    case "enhances":
    case "ENHANCES":
    case "specializes":
    case "SPECIALIZES":
      return false;
    default:
      return false;
  }
}

/**
 * Normalize a link verb to its canonical LinkType form.
 */
function normalizeLinkType(verb: string): string {
  const map: Record<string, string> = {
    requires: "REQUIRES",
    enhances: "ENHANCES",
    validates_with: "VALIDATES",
    contradicts: "CONTRADICTS",
    specializes: "SPECIALIZES",
    supplies_to: "SUPPLIES",
  };
  return map[verb] || verb;
}

/**
 * Extract all dependencies (use[] + links[]) from an AST.
 */
function extractDependencies(ast: AnyAST): RawDependency[] {
  const deps: RawDependency[] = [];

  // Extract from use[]
  const useField = ast.body.find((f) => f.key === "use");
  if (useField && useField.value.type === "Array") {
    for (const item of (useField.value as ArrayNode).items) {
      if (item.type === "Reference") {
        const ref = item as ReferenceNode;
        deps.push({
          to: ref.path[0],
          type: "REQUIRES",
          required: true,
          direction: "before",
          line: item.loc.line,
          version: ref.path.length > 1 ? ref.path[1] : undefined,
        });
      } else if (item.type === "String") {
        deps.push({
          to: (item as StringNode).value,
          type: "REQUIRES",
          required: true,
          direction: "before",
          line: item.loc.line,
        });
      }
    }
  }

  // Extract from links[]
  const linksField = ast.body.find((f) => f.key === "links");
  if (linksField && linksField.value.type === "Array") {
    for (const item of (linksField.value as ArrayNode).items) {
      if (item.type === "LinkShorthand") {
        const link = item as LinkShorthandNode;
        deps.push({
          to: link.target,
          type: normalizeLinkType(link.verb),
          required: defaultRequired(link.verb),
          direction: defaultDirection(link.verb),
          line: item.loc.line,
        });
      } else if (item.type === "Object") {
        const obj = item as ObjectNode;
        const typeField = obj.fields.find((f) => f.key === "type");
        const toField = obj.fields.find((f) => f.key === "to");
        const requiredField = obj.fields.find((f) => f.key === "required");
        const directionField = obj.fields.find((f) => f.key === "direction");

        if (typeField && toField) {
          const verb =
            typeField.value.type === "Ident"
              ? typeField.value.value
              : typeField.value.type === "String"
                ? (typeField.value as StringNode).value
                : "";
          const to =
            toField.value.type === "String"
              ? (toField.value as StringNode).value
              : "";

          let required = defaultRequired(verb);
          if (requiredField && requiredField.value.type === "Boolean") {
            required = requiredField.value.value;
          }

          let direction = defaultDirection(verb);
          if (directionField && directionField.value.type === "Ident") {
            const d = directionField.value.value as "before" | "after" | "during" | "any";
            if (["before", "after", "during", "any"].includes(d)) {
              direction = d;
            }
          }

          deps.push({
            to,
            type: normalizeLinkType(verb),
            required,
            direction,
            line: item.loc.line,
          });
        }
      }
    }
  }

  return deps;
}

// ─── Cycle Detection ───────────────────────────────────────────────────────

/**
 * DFS-based cycle detection on the dependency graph.
 * Returns the first cycle found as an array of node IDs, or null.
 */
function detectCycle(
  adjacency: Map<string, string[]>,
  startNode: string
): string[] | null {
  const WHITE = 0; // unvisited
  const GRAY = 1;  // in current DFS path
  const BLACK = 2; // fully explored

  const color = new Map<string, number>();
  const parent = new Map<string, string | null>();

  // Initialize all nodes as WHITE
  for (const node of adjacency.keys()) {
    color.set(node, WHITE);
  }

  function dfs(u: string): string[] | null {
    color.set(u, GRAY);

    const neighbors = adjacency.get(u) || [];
    for (const v of neighbors) {
      if (!color.has(v)) {
        color.set(v, WHITE);
      }

      if (color.get(v) === GRAY) {
        // Found a cycle — reconstruct the path
        const cycle: string[] = [v, u];
        let curr = u;
        while (curr !== v && parent.has(curr)) {
          curr = parent.get(curr)!;
          if (curr) cycle.push(curr);
        }
        return cycle.reverse();
      }

      if (color.get(v) === WHITE) {
        parent.set(v, u);
        const result = dfs(v);
        if (result) return result;
      }
    }

    color.set(u, BLACK);
    return null;
  }

  parent.set(startNode, null);
  return dfs(startNode);
}

// ─── Topological Sort ──────────────────────────────────────────────────────

/**
 * Topological sort of the dependency graph using Kahn's algorithm.
 * Returns the sorted node IDs or throws if a cycle is detected.
 */
function topologicalSort(
  nodes: Set<string>,
  adjacency: Map<string, string[]>
): string[] {
  const inDegree = new Map<string, number>();
  for (const node of nodes) {
    inDegree.set(node, 0);
  }

  for (const [from, tos] of adjacency.entries()) {
    for (const to of tos) {
      if (nodes.has(to)) {
        inDegree.set(to, (inDegree.get(to) || 0) + 1);
      }
    }
  }

  const queue: string[] = [];
  for (const [node, degree] of inDegree.entries()) {
    if (degree === 0) {
      queue.push(node);
    }
  }

  const sorted: string[] = [];
  while (queue.length > 0) {
    const node = queue.shift()!;
    sorted.push(node);

    const neighbors = adjacency.get(node) || [];
    for (const neighbor of neighbors) {
      if (!nodes.has(neighbor)) continue;
      const newDegree = (inDegree.get(neighbor) || 1) - 1;
      inDegree.set(neighbor, newDegree);
      if (newDegree === 0) {
        queue.push(neighbor);
      }
    }
  }

  return sorted;
}

// ─── Main Resolver ─────────────────────────────────────────────────────────

/**
 * Resolve result containing the graph and any diagnostics.
 */
export interface ResolveResult {
  graph: DependencyGraph;
  diagnostics: Diagnostic[];
}

/**
 * Resolve the dependency graph for a Prime AST.
 *
 * @param ast - The parsed Prime AST (root node to resolve)
 * @param installedPrimes - Map of all installed Primes
 * @returns The resolved dependency graph and diagnostics
 */
export function resolve(
  ast: AnyAST,
  installedPrimes: Map<string, InstalledPrime> = new Map()
): ResolveResult {
  const diagnostics: Diagnostic[] = [];
  const nodes = new Map<string, DependencyNode>();
  const edges: DependencyEdge[] = [];
  const allContradicts = new Set<string>(); // "A|B" pairs

  // Get the root name
  const nameField = ast.body.find((f) => f.key === "name");
  const rootName =
    nameField && nameField.value.type === "String"
      ? (nameField.value as StringNode).value
      : ast.name;

  const versionField = ast.body.find((f) => f.key === "version");
  const rootVersion =
    versionField && versionField.value.type === "String"
      ? (versionField.value as StringNode).value
      : "0.0.0";

  const baseClass = (isPrimeAST(ast) ? ast.extends : undefined) || "Unknown";

  // Add root node
  nodes.set(rootName, { id: rootName, type: baseClass, version: rootVersion });

  // BFS to resolve transitive dependencies
  const visited = new Set<string>();
  const queue: Array<{ name: string; deps: RawDependency[] }> = [];
  const versionMap = new Map<string, { version: string; requiredBy: string; line: number }>();

  // Extract direct dependencies from the root AST
  const rootDeps = extractDependencies(ast);
  queue.push({ name: rootName, deps: rootDeps });
  visited.add(rootName);

  // Build adjacency list for "before" direction dependencies (for cycle detection)
  const adjacency = new Map<string, string[]>();
  adjacency.set(rootName, []);

  while (queue.length > 0) {
    const { name: currentName, deps } = queue.shift()!;

    for (const dep of deps) {
      // Add edge
      edges.push({
        from: currentName,
        to: dep.to,
        type: dep.type,
        required: dep.required,
        direction: dep.direction,
      });

      // Track CONTRADICTS relationships
      if (dep.type === "CONTRADICTS") {
        const key = [currentName, dep.to].sort().join("|");
        allContradicts.add(key);
      }

      // Add node for the dependency
      const installed = installedPrimes.get(dep.to);
      if (installed) {
        if (!nodes.has(dep.to)) {
          nodes.set(dep.to, {
            id: dep.to,
            type: installed.type,
            version: installed.version,
          });
        }

        // Version conflict detection
        if (dep.version) {
          const existing = versionMap.get(dep.to);
          if (existing && existing.version !== dep.version) {
            diagnostics.push({
              level: "error",
              line: dep.line,
              message: `Version conflict: "${dep.to}" required as ${dep.version} by ${currentName} but as ${existing.version} by ${existing.requiredBy}`,
              suggestion: "Unify the version requirement",
              source: "resolver",
            });
          } else {
            versionMap.set(dep.to, {
              version: dep.version,
              requiredBy: currentName,
              line: dep.line,
            });
          }
        }

        // Build adjacency for "before" direction deps (cycle detection)
        if (dep.direction === "before" && dep.type !== "CONTRADICTS") {
          if (!adjacency.has(currentName)) {
            adjacency.set(currentName, []);
          }
          adjacency.get(currentName)!.push(dep.to);
          if (!adjacency.has(dep.to)) {
            adjacency.set(dep.to, []);
          }
        }

        // Recursively resolve transitive dependencies
        if (!visited.has(dep.to) && dep.type !== "CONTRADICTS") {
          visited.add(dep.to);
          // If the installed Prime has its own AST, extract its dependencies
          if (installed.ast) {
            const transitiveDeps = extractDependencies(installed.ast as PrimeAST);
            queue.push({ name: dep.to, deps: transitiveDeps });
          } else if (installed.links) {
            // Use the pre-extracted links if available
            const transitiveDeps: RawDependency[] = installed.links.map((l) => ({
              to: l.to,
              type: normalizeLinkType(l.type),
              required: defaultRequired(l.type),
              direction: defaultDirection(l.type),
              line: 0,
            }));
            queue.push({ name: dep.to, deps: transitiveDeps });
          }
        }
      }
    }
  }

  // ── Circular dependency detection ─────────────────────────────────────
  const cycle = detectCycle(adjacency, rootName);
  if (cycle && cycle.length > 1) {
    diagnostics.push({
      level: "error",
      line: ast.loc.line,
      message: `Circular dependency detected: ${cycle.join(" -> ")}`,
      suggestion: "Break the cycle by changing one dependency direction or using ENHANCES instead of REQUIRES",
      source: "resolver",
    });
  }

  // ── CONTRADICTS conflict detection ────────────────────────────────────
  const allNodeIds = new Set(nodes.keys());
  for (const pair of allContradicts) {
    const [a, b] = pair.split("|");
    // Check if both sides of a CONTRADICTS are present in the dependency tree
    if (allNodeIds.has(a) && allNodeIds.has(b)) {
      diagnostics.push({
        level: "error",
        line: ast.loc.line,
        message: `CONTRADICTS conflict: "${a}" and "${b}" cannot coexist in the same dependency tree`,
        suggestion: `Remove one of "${a}" or "${b}" from the dependency tree`,
        source: "resolver",
      });
    }
  }

  // ── Compute load order via topological sort ───────────────────────────
  let loadOrder: string[];
  if (diagnostics.some((d) => d.level === "error" && d.message.includes("Circular"))) {
    // Can't topologically sort with cycles; return flat list
    loadOrder = Array.from(nodes.keys());
  } else {
    loadOrder = topologicalSort(allNodeIds, adjacency);
    // Reverse: topological sort gives dependents first, but load order needs dependencies first
    loadOrder.reverse();
    // Ensure all nodes are included (some may not be in adjacency graph)
    for (const id of allNodeIds) {
      if (!loadOrder.includes(id)) {
        loadOrder.push(id);
      }
    }
  }

  return {
    graph: {
      nodes: Array.from(nodes.values()),
      edges,
      loadOrder,
    },
    diagnostics,
  };
}
