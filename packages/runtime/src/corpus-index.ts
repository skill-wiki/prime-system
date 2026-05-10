/**
 * @module corpus-index
 * Text + graph search over a loaded CorpusGraph.
 *
 * Ranking:
 *   1. Per-atom indexed haystack (name, description, tags, facts/defs/checks).
 *   2. Token IDF weighting — rare terms count more than common ones.
 *   3. Field boosts — tag hits score higher than body hits; name/description
 *      exact phrase matches get large bonuses.
 *   4. Metadata boosts — priority/severity/activation/subtype shift
 *      scored atoms toward the ones humans marked as important.
 *   5. Optional synonym expansion from a caller-supplied dictionary.
 *
 * After ranking, hits get graph-enriched with:
 *   - transitive `requires`/`supplies_to` closure (dependencies)
 *   - one-hop `specializes`/`enhances` neighbors (context)
 *   - `contradicts` warnings within the selection
 *
 * Zero LLM. Deterministic. Indexing is O(N) once; each query is O(N·Q)
 * where Q is the tokenized query length.
 */

import type {
  PrimeAST,
  AtomDeclaration,
  ArrayNode,
  ObjectNode,
  StringNode,
  NumberNode,
  IdentNode,
  ValueNode,
} from "@prime-lang/types";

type AnyAST = PrimeAST | AtomDeclaration;
import { CorpusGraph } from "./corpus-graph";

export interface SearchHit {
  name: string;
  score: number;
  reason: string;
  extends: string;
  tags: string[];
  description: string;
  /** The atoms that must load before this one (requires closure). */
  requires: string[];
  /** One-hop enhancement / specialization context. */
  relatedContext: string[];
  /** Names of atoms in the selection that contradict this one. */
  contradictsInSelection: string[];
}

export interface SearchOptions {
  /** Max primary hits before graph enrichment. Default 10. */
  topN?: number;
  /** Max atoms in the requires closure per hit. Default 20. */
  maxRequiresClosure?: number;
  /** Max related context neighbors per hit. Default 8. */
  maxRelatedContext?: number;
  /**
   * Optional query expansion. Key = query token, value = list of
   * equivalent tokens to also match (as lower-IDF additions).
   */
  synonyms?: Record<string, string[]>;
}

export interface IndexOptions {
  /** Disable metadata-driven scoring boosts (for A/B testing). Default false. */
  disableMetadataBoosts?: boolean;
}

const STOP = new Set([
  "the", "a", "an", "of", "in", "on", "to", "for", "and", "or", "is", "are",
  "be", "by", "with", "from", "at", "as", "it", "this", "that", "should",
  "when", "if", "how", "does",
  // intentionally NOT in STOP: "not", "but", "no", "what", "why", "do" —
  // distinguishing "do X" from "don't X" matters for pattern vs anti-pattern.
]);

/**
 * Escape a query token so it can be spliced into a RegExp source without
 * triggering regex syntax errors. Fixes crashes on tokens like "c++" or "x.y".
 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 2 && !STOP.has(w));
}

function fieldString(ast: AnyAST, key: string): string | undefined {
  const f = ast.body.find((x) => x.key === key);
  if (!f) return undefined;
  if (f.value.type === "String") return (f.value as StringNode).value;
  if (f.value.type === "Ident") return (f.value as IdentNode).value;
  return undefined;
}

function fieldNumber(ast: AnyAST, key: string): number | undefined {
  const f = ast.body.find((x) => x.key === key);
  if (!f || f.value.type !== "Number") return undefined;
  return (f.value as NumberNode).value;
}

function arrayItems(ast: AnyAST, key: string): ValueNode[] {
  const f = ast.body.find((x) => x.key === key);
  if (!f || f.value.type !== "Array") return [];
  return (f.value as ArrayNode).items;
}

/** Collect every string inside Knowledge.facts / Definition / Rule.checks for scoring. */
function extractBodyText(ast: AnyAST): string {
  const parts: string[] = [];
  for (const facts of arrayItems(ast, "facts")) {
    if (facts.type !== "Object") continue;
    for (const f of (facts as ObjectNode).fields) {
      if (f.value.type === "String") parts.push((f.value as StringNode).value);
    }
  }
  for (const def of arrayItems(ast, "definitions")) {
    if (def.type !== "Object") continue;
    for (const f of (def as ObjectNode).fields) {
      if (f.value.type === "String") parts.push((f.value as StringNode).value);
    }
  }
  for (const check of arrayItems(ast, "checks")) {
    if (check.type !== "Object") continue;
    for (const f of (check as ObjectNode).fields) {
      if (f.value.type === "String") parts.push((f.value as StringNode).value);
    }
  }
  return parts.join(" ");
}

/** Per-atom precomputed index record. */
interface IndexRecord {
  name: string;
  tagsText: string; // lowercase tags joined
  nameText: string;
  descText: string;
  bodyText: string;
  allText: string; // name + tags + desc + body, lowercase
  /** Tokens of each field, for IDF computation and per-field scoring. */
  nameTokens: Set<string>;
  descTokens: Set<string>;
  tagTokens: Set<string>;
  bodyTokens: Set<string>;
  /** Metadata used for boosts. */
  priority?: number;
  severity?: string;
  activation?: string;
  subtype?: string;
}

export class CorpusIndex {
  private readonly graph: CorpusGraph;
  private readonly records: Map<string, IndexRecord> = new Map();
  /** document-frequency: token → # of atoms containing it. */
  private readonly df: Map<string, number> = new Map();
  private readonly totalDocs: number;
  private readonly options: IndexOptions;

  constructor(graph: CorpusGraph, options: IndexOptions = {}) {
    this.graph = graph;
    this.options = options;

    for (const name of graph.atoms()) {
      const node = graph.get(name)!;
      const nameText = name;
      const descText = fieldString(node.ast, "description") ?? "";
      const bodyText = extractBodyText(node.ast);
      const tagsText = node.tags.join(" ");
      const allText = [nameText, descText, tagsText, bodyText].join(" ").toLowerCase();

      const nameTokens = new Set(tokenize(nameText));
      const descTokens = new Set(tokenize(descText));
      const tagTokens = new Set(node.tags.map((t) => t.toLowerCase()));
      const bodyTokens = new Set(tokenize(bodyText));

      // Document frequency — union of all token sources so we get one count per atom.
      const docTokens = new Set<string>([
        ...nameTokens,
        ...descTokens,
        ...tagTokens,
        ...bodyTokens,
      ]);
      for (const t of docTokens) this.df.set(t, (this.df.get(t) ?? 0) + 1);

      this.records.set(name, {
        name,
        tagsText,
        nameText,
        descText,
        bodyText,
        allText,
        nameTokens,
        descTokens,
        tagTokens,
        bodyTokens,
        priority: fieldNumber(node.ast, "priority"),
        severity: fieldString(node.ast, "severity"),
        activation: fieldString(node.ast, "activation"),
        subtype: fieldString(node.ast, "subtype"),
      });
    }
    this.totalDocs = this.records.size;
  }

  /** Underlying graph — callers that want raw traversal can use it directly. */
  get corpus(): CorpusGraph {
    return this.graph;
  }

  /** IDF weight of a token; rare tokens get higher weight. */
  private idf(token: string): number {
    const docs = this.df.get(token) ?? 0;
    if (docs === 0) return 0;
    // Classic smoothed IDF: log((N - n + 0.5)/(n + 0.5) + 1). Guarantees positive.
    return Math.log((this.totalDocs - docs + 0.5) / (docs + 0.5) + 1);
  }

  /**
   * Expand the tokenized query with synonyms. Each original token keeps full
   * IDF weight; synonym terms come in at 0.6× to mark them as secondary.
   */
  private expandTokens(
    tokens: string[],
    synonyms: Record<string, string[]>
  ): Array<{ token: string; weight: number }> {
    const out: Array<{ token: string; weight: number }> = [];
    const seen = new Set<string>();
    for (const t of tokens) {
      if (!seen.has(t)) {
        seen.add(t);
        out.push({ token: t, weight: 1 });
      }
      const syns = synonyms[t];
      if (syns) {
        for (const s of syns) {
          const slower = s.toLowerCase();
          if (seen.has(slower)) continue;
          seen.add(slower);
          out.push({ token: slower, weight: 0.6 });
        }
      }
    }
    return out;
  }

  /** Score a single atom. Field boosts: tag 3×, name 2.5×, desc 1.5×, body 1×. */
  private score(
    rec: IndexRecord,
    weighted: Array<{ token: string; weight: number }>,
    fullQuery: string
  ): { score: number; matched: string[] } {
    let score = 0;
    const matched: string[] = [];

    for (const { token, weight } of weighted) {
      const idf = this.idf(token);
      if (idf === 0) continue; // term not in corpus
      let fieldHit = 0;
      if (rec.tagTokens.has(token)) fieldHit += 3;
      else if (rec.nameTokens.has(token)) fieldHit += 2.5;
      else if (rec.descTokens.has(token)) fieldHit += 1.5;
      else if (rec.bodyTokens.has(token)) fieldHit += 1;
      if (fieldHit === 0) continue;

      // Occurrence bonus, sub-linear
      const occ = (rec.allText.match(
        new RegExp(`\\b${escapeRegex(token)}\\b`, "g")
      ) || []).length;
      const occFactor = 1 + Math.max(0, occ - 1) * 0.2;

      score += fieldHit * idf * occFactor * weight;
      matched.push(token);
    }
    if (matched.length === 0) return { score: 0, matched: [] };

    // Exact-phrase bonuses (absolute, not IDF-scaled)
    if (fullQuery.length > 0) {
      if (rec.nameText.toLowerCase().includes(fullQuery)) score += 4;
      if (rec.descText.toLowerCase().includes(fullQuery)) score += 2;
    }

    // Metadata boosts — reward atoms humans marked as important.
    if (!this.options.disableMetadataBoosts) {
      if (rec.priority === 1) score *= 1.6;
      else if (rec.priority === 2) score *= 1.2;
      if (rec.severity === "block") score *= 1.2;
      if (rec.activation === "behavioral") score *= 1.15;
      if (rec.activation === "mindset") score *= 1.3;
      if (rec.subtype === "mandate") score *= 1.3;
      else if (rec.subtype === "anti-pattern") score *= 1.15;
    }

    return { score, matched };
  }

  /** Full search: rank atoms by query match, return top N with graph enrichment. */
  search(query: string, options: SearchOptions = {}): SearchHit[] {
    const topN = options.topN ?? 10;
    const maxRequires = options.maxRequiresClosure ?? 20;
    const maxRelated = options.maxRelatedContext ?? 8;
    const synonyms = options.synonyms ?? {};
    const tokens = tokenize(query);
    if (tokens.length === 0) return [];
    const weighted = this.expandTokens(tokens, synonyms);
    const fullQuery = tokens.join(" ");

    const ranked: Array<{ name: string; score: number; matched: string[] }> = [];
    for (const [name, rec] of this.records) {
      const { score, matched } = this.score(rec, weighted, fullQuery);
      if (score > 0) ranked.push({ name, score, matched });
    }
    ranked.sort((a, b) => b.score - a.score);
    const top = ranked.slice(0, topN);
    const topNames = new Set(top.map((r) => r.name));

    const hits: SearchHit[] = [];
    for (const { name, score, matched } of top) {
      const node = this.graph.get(name)!;
      const requires = this.graph
        .closure(name, ["requires", "supplies_to"])
        .slice(0, maxRequires);
      const related = this.graph
        .neighbors(name, ["specializes", "enhances"])
        .slice(0, maxRelated);
      const contradictsInSelection = this.graph
        .outgoing(name, "contradicts")
        .map((e) => e.to)
        .filter((target) => topNames.has(target));

      hits.push({
        name,
        score,
        reason: `matched tokens: ${matched.slice(0, 6).join(", ")}`,
        extends: node.extends,
        tags: node.tags,
        description: fieldString(node.ast, "description") ?? "",
        requires,
        relatedContext: related,
        contradictsInSelection,
      });
    }

    return hits;
  }

  /** Diagnostic — total unique tokens in the index. Useful for health checks. */
  vocabularySize(): number {
    return this.df.size;
  }
}
