/**
 * @module corpus-graph
 * Corpus-level graph API for .prime atoms.
 *
 * Orthogonal to the per-atom `executor` / `loader` (which handle Method
 * execution). This module treats the full corpus as a directed graph and
 * exposes the queries a Skill or MCP server actually makes at runtime:
 *
 *   closure(name, verbs)    transitive closure over the chosen link verbs
 *   contradicts(a, b)       is there a contradicts edge between a and b?
 *   violations(selected)    all contradicts violations inside a selection
 *   neighbors(name, verb?)  one-hop neighbors (optionally filtered)
 *   topologicalOrder()      `requires` topological ordering (for loading)
 *
 * The graph itself is built once from parsed ASTs and then cached — subsequent
 * lookups are O(1) or O(closure size). Building is O(atoms + edges).
 */

import type {
  PrimeAST,
  AtomDeclaration,
  FieldNode,
  ArrayNode,
  ObjectNode,
  StringNode,
  LinkShorthandNode,
  ValueNode,
} from "@prime-lang/types";

type AnyAST = PrimeAST | AtomDeclaration;

function isPrimeAST(ast: AnyAST): ast is PrimeAST {
  return ast.type === "PrimeDeclaration";
}

/** Relationship verbs the graph understands. */
export type LinkVerb =
  | "requires"
  | "enhances"
  | "validates_with"
  | "supplies_to"
  | "contradicts"
  | "specializes";

export const LINK_VERBS: readonly LinkVerb[] = Object.freeze([
  "requires",
  "enhances",
  "validates_with",
  "supplies_to",
  "contradicts",
  "specializes",
]);

export interface CorpusNode {
  name: string;
  extends: string;
  tags: string[];
  ast: AnyAST;
}

export interface CorpusEdge {
  from: string;
  to: string;
  verb: LinkVerb;
}

export interface CorpusGraphStats {
  atoms: number;
  edges: number;
  byVerb: Partial<Record<LinkVerb, number>>;
  danglingEdges: number;
  /** (from, verb, to) for the first N dangling edges — surfaces what got dropped. */
  danglingSamples: Array<{ from: string; verb: LinkVerb; to: string }>;
  cycles: string[][];
}

function fieldAsString(ast: AnyAST, key: string): string | undefined {
  const f = ast.body.find((x) => x.key === key);
  if (!f || f.value.type !== "String") return undefined;
  return (f.value as StringNode).value;
}

function extractTags(ast: AnyAST): string[] {
  const f = ast.body.find((x) => x.key === "tags");
  if (!f || f.value.type !== "Array") return [];
  const tags: string[] = [];
  for (const v of (f.value as ArrayNode).items) {
    if (v.type === "String") tags.push((v as StringNode).value);
  }
  return tags;
}

/**
 * Extract every link edge originating from this AST.
 * Accepts link declarations in these forms at the TOP LEVEL of the prime:
 *   verb: "<target>"                                  (field with string value)
 *   verb: ["<t1>", "<t2>"]                            (field with string array)
 *   links: [{ verb: "requires", target: "x" }, ...]   (objects inside a links: array)
 *   verb "<target>"                                   (LinkShorthand AST node anywhere)
 *
 * Nested fields named after a link verb but appearing inside arbitrary
 * structures (e.g. taxonomy[0].requires holding prose) are NOT links.
 */
function extractEdges(ast: AnyAST): Array<{ verb: LinkVerb; target: string }> {
  const LINK_SET = new Set<string>(LINK_VERBS);
  const out: Array<{ verb: LinkVerb; target: string }> = [];

  function push(verb: string, target: unknown): void {
    if (!LINK_SET.has(verb)) return;
    if (typeof target !== "string" || target.length === 0) return;
    out.push({ verb: verb as LinkVerb, target });
  }

  for (const field of ast.body) {
    // Top-level verb fields
    if (LINK_SET.has(field.key)) {
      if (field.value.type === "String") {
        push(field.key, (field.value as StringNode).value);
      } else if (field.value.type === "Array") {
        for (const item of (field.value as ArrayNode).items) {
          if (item.type === "String") push(field.key, (item as StringNode).value);
          else if (item.type === "LinkShorthand") {
            const l = item as LinkShorthandNode;
            push(l.verb, l.target);
          }
        }
      }
      continue;
    }
    // Special case: the `links:` array can hold object-literal link declarations.
    if (field.key === "links" && field.value.type === "Array") {
      for (const item of (field.value as ArrayNode).items) {
        if (item.type === "LinkShorthand") {
          const l = item as LinkShorthandNode;
          push(l.verb, l.target);
        } else if (item.type === "Object") {
          const fields = (item as ObjectNode).fields;
          const verbField = fields.find((f) => f.key === "verb" || f.key === "type");
          const targetField = fields.find((f) => f.key === "target" || f.key === "to");
          if (
            verbField &&
            verbField.value.type === "String" &&
            targetField &&
            targetField.value.type === "String"
          ) {
            push((verbField.value as StringNode).value, (targetField.value as StringNode).value);
          }
        }
      }
      continue;
    }
    // LinkShorthand AST nodes anywhere in other top-level arrays still count —
    // parser only emits them in link-declaration contexts.
    if (field.value.type === "Array") {
      for (const item of (field.value as ArrayNode).items) {
        if (item.type === "LinkShorthand") {
          const l = item as LinkShorthandNode;
          push(l.verb, l.target);
        }
      }
    }
  }

  return out;
}

export interface CorpusGraphOptions {
  /** Drop dangling edges (target not in corpus) silently. Default true. */
  ignoreDangling?: boolean;
}

/**
 * The compiled corpus graph. Construct once, query many times.
 */
export class CorpusGraph {
  private readonly nodes: Map<string, CorpusNode> = new Map();
  private readonly edgesFrom: Map<string, CorpusEdge[]> = new Map();
  private readonly edgesTo: Map<string, CorpusEdge[]> = new Map();
  private readonly allEdges: CorpusEdge[] = [];
  private readonly danglingCount: number;
  private readonly danglingSamples: Array<{ from: string; verb: LinkVerb; to: string }> = [];

  constructor(asts: AnyAST[], options: CorpusGraphOptions = {}) {
    const ignoreDangling = options.ignoreDangling !== false;

    for (const ast of asts) {
      const name = fieldAsString(ast, "name") ?? ast.name;
      if (!name) continue;
      if (this.nodes.has(name)) continue; // first-wins; C1 reports collisions elsewhere
      this.nodes.set(name, {
        name,
        extends: (isPrimeAST(ast) ? ast.extends : undefined) ?? "Unknown",
        tags: extractTags(ast),
        ast,
      });
    }

    let dangling = 0;
    for (const node of this.nodes.values()) {
      const rawEdges = extractEdges(node.ast);
      for (const { verb, target } of rawEdges) {
        if (!this.nodes.has(target)) {
          dangling++;
          if (this.danglingSamples.length < 20) {
            this.danglingSamples.push({ from: node.name, verb, to: target });
          }
          if (ignoreDangling) continue;
        }
        const edge: CorpusEdge = { from: node.name, to: target, verb };
        this.allEdges.push(edge);
        (this.edgesFrom.get(node.name) ?? this.edgesFrom.set(node.name, []).get(node.name)!)
          .push(edge);
        (this.edgesTo.get(target) ?? this.edgesTo.set(target, []).get(target)!)
          .push(edge);
      }
    }
    this.danglingCount = dangling;
  }

  /** All atom names known to the graph. */
  atoms(): string[] {
    return [...this.nodes.keys()];
  }

  /** Get a node by name; undefined if not in corpus. */
  get(name: string): CorpusNode | undefined {
    return this.nodes.get(name);
  }

  /** One-hop outbound edges, optionally filtered by verb. */
  outgoing(name: string, verb?: LinkVerb): CorpusEdge[] {
    const edges = this.edgesFrom.get(name) ?? [];
    return verb ? edges.filter((e) => e.verb === verb) : edges;
  }

  /** One-hop inbound edges, optionally filtered by verb. */
  incoming(name: string, verb?: LinkVerb): CorpusEdge[] {
    const edges = this.edgesTo.get(name) ?? [];
    return verb ? edges.filter((e) => e.verb === verb) : edges;
  }

  /** Names of one-hop outbound neighbors along the given verb(s). */
  neighbors(name: string, verbs: LinkVerb[] = [...LINK_VERBS]): string[] {
    const set = new Set<LinkVerb>(verbs);
    return this.outgoing(name)
      .filter((e) => set.has(e.verb))
      .map((e) => e.to);
  }

  /**
   * Transitive closure from `name` along the chosen verbs, excluding `name`
   * itself. Default verbs are requires + supplies_to (the "load before me"
   * relations). Caller may pass [] to disable traversal and get just the
   * seed node.
   */
  closure(name: string, verbs: LinkVerb[] = ["requires", "supplies_to"]): string[] {
    const set = new Set<LinkVerb>(verbs);
    const seen = new Set<string>();
    const queue: string[] = [name];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const edge of this.outgoing(cur)) {
        if (!set.has(edge.verb)) continue;
        if (seen.has(edge.to)) continue;
        seen.add(edge.to);
        queue.push(edge.to);
      }
    }
    seen.delete(name);
    return [...seen];
  }

  /** True iff there is a contradicts edge in either direction between a and b. */
  contradicts(a: string, b: string): boolean {
    for (const edge of this.outgoing(a, "contradicts")) if (edge.to === b) return true;
    for (const edge of this.outgoing(b, "contradicts")) if (edge.to === a) return true;
    return false;
  }

  /**
   * All contradicts violations found inside a selection.
   * Each violation is returned as a [from, to] pair in alphabetical order so
   * that (a,b) and (b,a) don't report twice.
   */
  violations(selected: string[]): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    const seen = new Set<string>();
    const selectedSet = new Set(selected);
    for (const name of selected) {
      for (const edge of this.outgoing(name, "contradicts")) {
        if (!selectedSet.has(edge.to)) continue;
        const pair: [string, string] = edge.from < edge.to ? [edge.from, edge.to] : [edge.to, edge.from];
        const key = `${pair[0]}→${pair[1]}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(pair);
      }
    }
    return out;
  }

  /**
   * Topological order for the `requires` sub-graph. Atoms with no `requires`
   * come first, then atoms whose requires are already resolved, etc.
   * Throws if a cycle is detected.
   */
  topologicalOrder(): string[] {
    const visited = new Set<string>();
    const temp = new Set<string>();
    const order: string[] = [];

    const visit = (name: string, path: string[]): void => {
      if (visited.has(name)) return;
      if (temp.has(name)) {
        throw new Error(`cycle in requires: ${[...path, name].join(" → ")}`);
      }
      temp.add(name);
      for (const edge of this.outgoing(name, "requires")) {
        if (this.nodes.has(edge.to)) visit(edge.to, [...path, name]);
      }
      temp.delete(name);
      visited.add(name);
      order.push(name);
    };

    for (const name of this.nodes.keys()) visit(name, []);
    return order;
  }

  /** Detect `requires` cycles without throwing. Returns each cycle once. */
  detectRequiresCycles(): string[][] {
    const visited = new Set<string>();
    const cycles: string[][] = [];

    const visit = (name: string, path: string[]): void => {
      const idx = path.indexOf(name);
      if (idx >= 0) {
        cycles.push([...path.slice(idx), name]);
        return;
      }
      if (visited.has(name)) return;
      visited.add(name);
      for (const edge of this.outgoing(name, "requires")) {
        if (this.nodes.has(edge.to)) visit(edge.to, [...path, name]);
      }
    };

    for (const name of this.nodes.keys()) visit(name, []);
    return cycles;
  }

  stats(): CorpusGraphStats {
    const byVerb: Partial<Record<LinkVerb, number>> = {};
    for (const e of this.allEdges) byVerb[e.verb] = (byVerb[e.verb] ?? 0) + 1;
    return {
      atoms: this.nodes.size,
      edges: this.allEdges.length,
      byVerb,
      danglingEdges: this.danglingCount,
      danglingSamples: [...this.danglingSamples],
      cycles: this.detectRequiresCycles(),
    };
  }
}
