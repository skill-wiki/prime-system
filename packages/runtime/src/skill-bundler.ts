/**
 * @module skill-bundler
 * Turn a set of selected primes into a single compact Skill-style Markdown
 * artifact that existing Skill / MCP runtimes can consume as one unit.
 *
 * Input: a CorpusGraph + a list of seed prime names (from CorpusIndex.search
 * or chosen manually). Output: a single `.md` string with:
 *
 *   - a YAML frontmatter header (name, version, primes[], total_tokens)
 *   - one "## <name>" section per prime, ordered by requires topology,
 *     with a terse body emitted by the same rules as emitMarkdown().
 *   - a "## Conflicts" section listing any contradicts inside the selection.
 *
 * Behaviour:
 *   - auto-expands the selection with the transitive requires closure of
 *     every seed, so the bundle is self-contained
 *   - dedupes atoms
 *   - topologically orders the bundle so later sections may reference
 *     earlier ones without forward dependencies
 *   - surfaces any contradicts pair (error condition the caller should fix
 *     before shipping the bundle)
 */

import type {
  PrimeAST,
  AtomDeclaration,
  ArrayNode,
  ObjectNode,
  StringNode,
  ValueNode,
} from "@prime-lang/types";

type AnyAST = PrimeAST | AtomDeclaration;

function isPrimeAST(ast: AnyAST): ast is PrimeAST {
  return ast.type === "PrimeDeclaration";
}
import { CorpusGraph } from "./corpus-graph";

export interface BundleOptions {
  /**
   * Skill name emitted into frontmatter. Must be kebab-case and unique
   * within the Claude Skills registry when published. Default "prime-bundle".
   */
  skillName?: string;
  /**
   * Skill description — REQUIRED by the Claude Skills spec. Tells Claude
   * what the skill does and when to use it. Default derived from the
   * included primes, but callers should override with an intent-focused
   * sentence for real skills.
   */
  description?: string;
  /** Optional SPDX license identifier (e.g. "MIT", "Apache-2.0"). */
  license?: string;
  /** Max primes to include even after expansion. Default 20. */
  maxPrimes?: number;
  /**
   * Hops to follow along the `enhances` / `specializes` edges when expanding
   * the seed selection. Defaults to 0 (strict — only `requires`/`supplies_to`
   * are followed, like before). Set to 1 to grow bundles with related
   * context; set higher for wider sweeps.
   */
  enhanceHops?: number;
  /**
   * Hard token ceiling. If the rendered bundle exceeds this, primes are
   * dropped from the tail of the included list (topological order) until
   * the budget fits. 0 (default) means no trim.
   */
  maxTokens?: number;
}

export interface BundleResult {
  /** The rendered Markdown. */
  markdown: string;
  /** All prime names included in the bundle, in emission order. */
  included: string[];
  /** Any contradicts pairs detected inside the selection. */
  conflicts: Array<[string, string]>;
  /** Approximate token count (chars / 4). */
  approxTokens: number;
}

function fieldString(ast: AnyAST, key: string): string | undefined {
  const f = ast.body.find((x) => x.key === key);
  if (!f || f.value.type !== "String") return undefined;
  return (f.value as StringNode).value;
}

function arrayItems(ast: AnyAST, key: string): ValueNode[] {
  const f = ast.body.find((x) => x.key === key);
  if (!f || f.value.type !== "Array") return [];
  return (f.value as ArrayNode).items;
}

function bulletLinesForKnowledge(ast: AnyAST): string[] {
  const out: string[] = [];
  for (const f of arrayItems(ast, "facts")) {
    if (f.type !== "Object") continue;
    const stmt = (f as ObjectNode).fields.find((x) => x.key === "statement");
    if (stmt && stmt.value.type === "String") {
      out.push(`- ${(stmt.value as StringNode).value}`);
    }
  }
  for (const d of arrayItems(ast, "definitions")) {
    if (d.type !== "Object") continue;
    const term = (d as ObjectNode).fields.find((x) => x.key === "term");
    const meaning = (d as ObjectNode).fields.find((x) => x.key === "meaning");
    if (
      term && term.value.type === "String" &&
      meaning && meaning.value.type === "String"
    ) {
      out.push(`- **${(term.value as StringNode).value}** — ${(meaning.value as StringNode).value}`);
    }
  }
  return out;
}

function bulletLinesForRule(ast: AnyAST): string[] {
  const out: string[] = [];
  for (const c of arrayItems(ast, "checks")) {
    if (c.type !== "Object") continue;
    const desc = (c as ObjectNode).fields.find((x) => x.key === "description");
    const pass = (c as ObjectNode).fields.find((x) => x.key === "pass_condition");
    if (desc && desc.value.type === "String") {
      const d = (desc.value as StringNode).value;
      const p = pass && pass.value.type === "String" ? ` (${(pass.value as StringNode).value})` : "";
      out.push(`- [ ] ${d}${p}`);
    }
  }
  return out;
}

function tagList(ast: AnyAST): string {
  const out: string[] = [];
  for (const v of arrayItems(ast, "tags")) {
    if (v.type === "String") out.push((v as StringNode).value);
  }
  return out.join(", ");
}

function renderOne(ast: AnyAST, name: string): string {
  const description = fieldString(ast, "description") ?? "";
  const tags = tagList(ast);
  const kind = (isPrimeAST(ast) ? ast.extends : undefined) ?? "Unknown";
  const lines: string[] = [];
  lines.push(`## ${name} _(${kind})_`);
  if (description) lines.push(description);
  if (tags) lines.push(`tags: ${tags}`);
  const body = kind === "Rule" ? bulletLinesForRule(ast) : bulletLinesForKnowledge(ast);
  if (body.length > 0) {
    lines.push("");
    lines.push(...body);
  }
  return lines.join("\n");
}

export function bundleSkill(
  graph: CorpusGraph,
  seeds: string[],
  options: BundleOptions = {}
): BundleResult {
  const maxPrimes = options.maxPrimes ?? 20;
  const enhanceHops = Math.max(0, options.enhanceHops ?? 0);

  // Expand seeds:
  //   1. transitive requires + supplies_to closure (always — these are the
  //      atoms the seed needs in order to be correct)
  //   2. bounded-hop enhances + specializes expansion (opt-in via
  //      enhanceHops) — pulls in related context (sibling patterns,
  //      specialization chains) for richer bundles
  const included: Set<string> = new Set();
  for (const seed of seeds) {
    if (!graph.get(seed)) continue;
    included.add(seed);
    for (const dep of graph.closure(seed, ["requires", "supplies_to"])) {
      included.add(dep);
      if (included.size >= maxPrimes) break;
    }
    if (included.size >= maxPrimes) break;
  }

  if (enhanceHops > 0 && included.size < maxPrimes) {
    // BFS over enhances/specializes from every currently-included node.
    let frontier = [...included];
    for (let hop = 0; hop < enhanceHops && frontier.length > 0; hop++) {
      const next: string[] = [];
      for (const name of frontier) {
        for (const peer of graph.neighbors(name, ["enhances", "specializes"])) {
          if (!included.has(peer)) {
            included.add(peer);
            next.push(peer);
            if (included.size >= maxPrimes) break;
          }
        }
        if (included.size >= maxPrimes) break;
      }
      if (included.size >= maxPrimes) break;
      frontier = next;
    }
  }

  // Topological order over the requires sub-graph, but only for nodes we included.
  let order = graph.topologicalOrder().filter((n) => included.has(n));
  // Anything in `included` not in `order` (shouldn't happen, but guard) appended at end.
  for (const n of included) if (!order.includes(n)) order.push(n);

  // Token-budget trim — drop tail primes (least topologically-central) until
  // the rendered bundle fits. Guarded so we never drop the seed that the
  // caller explicitly asked for.
  const maxTokens = options.maxTokens ?? 0;
  if (maxTokens > 0) {
    const seedSet = new Set(seeds);
    while (order.length > 0) {
      const trialSections = order
        .map((n) => (graph.get(n) ? renderOne(graph.get(n)!.ast, n) : ""))
        .filter(Boolean);
      const trialMarkdown = trialSections.join("\n\n");
      const trialTokens = Math.ceil(trialMarkdown.length / 4);
      if (trialTokens <= maxTokens) break;
      // Drop the last non-seed prime.
      const dropIdx = [...order].reverse().findIndex((n) => !seedSet.has(n));
      if (dropIdx < 0) break; // only seeds left; stop even if over budget
      order.splice(order.length - 1 - dropIdx, 1);
    }
  }

  const conflicts = graph.violations(order);

  // Assemble Claude-Skills-compliant frontmatter.
  // Spec: `name` (kebab-case) and `description` are required; `license` optional.
  // Extra vendor fields live under `x-prime-*` so generic Skill loaders
  // ignore them without warning.
  const skillName = options.skillName ?? "prime-bundle";
  const description =
    options.description ??
    `Composite skill auto-generated from ${order.length} Prime atoms: ${order
      .slice(0, 5)
      .join(", ")}${order.length > 5 ? ", …" : ""}.`;

  const fmLines: string[] = [
    "---",
    `name: ${skillName}`,
    `description: ${JSON.stringify(description)}`,
  ];
  if (options.license) fmLines.push(`license: ${JSON.stringify(options.license)}`);
  fmLines.push(`x-prime-version: 0.1.0`);
  fmLines.push(`x-prime-atoms: [${order.map((n) => JSON.stringify(n)).join(", ")}]`);
  fmLines.push(`x-prime-count: ${order.length}`);
  if (conflicts.length > 0) fmLines.push(`x-prime-conflicts: ${conflicts.length}`);
  fmLines.push("---");

  const sections: string[] = [];
  for (const name of order) {
    const node = graph.get(name);
    if (!node) continue;
    sections.push(renderOne(node.ast, name));
  }

  if (conflicts.length > 0) {
    const lines = ["## Conflicts"];
    lines.push(
      "The selected primes contain `contradicts` edges. Resolve before using:"
    );
    for (const [a, b] of conflicts) lines.push(`- ${a} ↔ ${b}`);
    sections.push(lines.join("\n"));
  }

  const markdown = [fmLines.join("\n"), sections.join("\n\n")].join("\n\n");
  return {
    markdown,
    included: order,
    conflicts,
    approxTokens: Math.ceil(markdown.length / 4),
  };
}
