/**
 * @module generators/lexical
 *
 * BM25 over unit text. Two choices are worth stating.
 *
 * First, which text: when the host names no field paths the generator harvests
 * every string reachable from `UnitIR.fields`. That is the only field selection
 * an engine with no schema knowledge can make; naming `description` here would
 * be a domain constant wearing a plausible hat.
 *
 * Second, normalisation: raw BM25 is unbounded, and `RetrievalProfile.features`
 * weights axes against each other. An unbounded axis would silently dominate a
 * bounded one no matter what weight the model declared, so scores are divided by
 * the best score in this query and land in [0, 1] like every other axis.
 */

import type { GraphIR, SelectionCandidateIR, UnitIR } from "@skill-wiki/ir";
import { compareStrings, orderedRecord, quantize } from "../deterministic.ts";
import { collectStrings, resolvePath } from "../values.ts";
import type { CandidateGenerator, GeneratorContext, QueryRequest } from "../types.ts";

export interface LexicalGeneratorConfig {
  readonly name: string;
  /** Axis this generator writes. Must appear in `RetrievalProfile.features` to count. */
  readonly featureAxis: string;
  /** Field paths to index. Omit to index every reachable string. */
  readonly fields?: readonly (readonly string[])[];
  /** Index the unit id as text. Off by default: ids are often opaque digests. */
  readonly includeUnitId?: boolean;
  /** Tokens dropped from both document and query. Empty by default — a builtin
   *  stop list is a natural-language assumption the engine has no right to make. */
  readonly stopWords?: readonly string[];
  /** Shortest token kept. */
  readonly minTokenLength?: number;
  /** BM25 term-frequency saturation. */
  readonly k1?: number;
  /** BM25 length normalisation. */
  readonly b?: number;
}

interface Document {
  readonly unitId: string;
  readonly frequencies: ReadonlyMap<string, number>;
  readonly length: number;
}

function tokenize(text: string, minTokenLength: number, stopWords: ReadonlySet<string>): readonly string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(token => token.length >= minTokenLength && !stopWords.has(token));
}

function unitText(unit: UnitIR, config: LexicalGeneratorConfig): readonly string[] {
  const parts: string[] = [];
  if (config.includeUnitId === true) parts.push(unit.identity.id);
  if (config.fields === undefined) {
    for (const key of Object.keys(unit.fields).sort(compareStrings)) collectStrings(unit.fields[key]!, parts);
  } else {
    for (const path of config.fields) {
      for (const value of resolvePath(unit.fields, path)) collectStrings(value, parts);
    }
  }
  return parts;
}

function frequencies(tokens: readonly string[]): ReadonlyMap<string, number> {
  const out = new Map<string, number>();
  for (const token of tokens) out.set(token, (out.get(token) ?? 0) + 1);
  return out;
}

export function createLexicalGenerator(config: LexicalGeneratorConfig): CandidateGenerator {
  const stopWords = new Set(config.stopWords ?? []);
  const minTokenLength = config.minTokenLength ?? 2;
  const k1 = config.k1 ?? 1.2;
  const b = config.b ?? 0.75;

  return {
    name: config.name,
    featureAxes: [config.featureAxis],
    generate(request: QueryRequest, graph: GraphIR, ctx: GeneratorContext): readonly SelectionCandidateIR[] {
      const query = tokenize(request.text ?? "", minTokenLength, stopWords);
      if (query.length === 0) return [];

      const documents: Document[] = [];
      const documentFrequency = new Map<string, number>();
      for (const unit of graph.units) {
        const tokens = tokenize(unitText(unit, config).join(" "), minTokenLength, stopWords);
        const freq = frequencies(tokens);
        documents.push({ unitId: unit.identity.id, frequencies: freq, length: tokens.length });
        for (const token of freq.keys()) documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
      }
      if (documents.length === 0) return [];

      const totalLength = documents.reduce((sum, doc) => sum + doc.length, 0);
      const averageLength = totalLength / documents.length;
      const uniqueQueryTokens = [...new Set(query)].sort(compareStrings);

      const scored = documents.map(doc => {
        let score = 0;
        const matched: string[] = [];
        for (const token of uniqueQueryTokens) {
          const frequency = doc.frequencies.get(token);
          if (frequency === undefined) continue;
          const df = documentFrequency.get(token) ?? 0;
          const idf = Math.log(1 + (documents.length - df + 0.5) / (df + 0.5));
          const norm = averageLength === 0 ? 1 : 1 - b + (b * doc.length) / averageLength;
          score += (idf * (frequency * (k1 + 1))) / (frequency + k1 * norm);
          matched.push(token);
        }
        return { unitId: doc.unitId, score, matched };
      });

      const best = scored.reduce((max, entry) => (entry.score > max ? entry.score : max), 0);
      if (best === 0) {
        ctx.report({
          code: "LEXICAL_NO_MATCH",
          message: `No unit matched any query term: [${uniqueQueryTokens.join(", ")}]`,
          severity: "info",
        });
        return [];
      }

      return scored
        .filter(entry => entry.score > 0)
        .map(entry => ({
          unitId: entry.unitId,
          score: 0, // The scorer owns the total; a generator only reports its axis.
          featureValues: orderedRecord([[config.featureAxis, quantize(entry.score / best)]]),
          reasons: [`${config.name}: matched terms [${entry.matched.sort(compareStrings).join(", ")}]`],
        }))
        .sort((a, b2) => compareStrings(a.unitId, b2.unitId));
    },
  };
}
