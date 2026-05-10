/**
 * @module index-manager
 * IndexManager — maintains the Prime index and provides matching/formatting.
 *
 * The Index is always in the AI context (~20 tokens per entry).
 * IndexManager loads the prime.index file, matches user queries,
 * and formats the index for system prompt injection or tool registration.
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import type { IndexEntry, PrimeIndex, ToolDefinition, ToolParameter } from "./types";

/**
 * Manages the Prime index for an installed set of Primes.
 *
 * Responsibilities:
 * - Load prime.index from .primes/ directory
 * - Match user queries against index entries (keyword matching)
 * - Format index as system prompt text
 * - Format index as tool definitions for function calling
 */
export class IndexManager {
  private entries: IndexEntry[] = [];

  /**
   * Load the prime.index file from a .primes/ directory.
   *
   * @param dir - Path to the directory containing prime.index
   *              (typically the .primes/ directory)
   * @returns The loaded PrimeIndex
   * @throws If the file doesn't exist or is malformed
   */
  loadIndex(dir: string): PrimeIndex {
    const indexPath = join(dir, "prime.index");

    if (!existsSync(indexPath)) {
      throw new Error(`prime.index not found at ${indexPath}`);
    }

    const raw = readFileSync(indexPath, "utf-8");
    const parsed = JSON.parse(raw) as PrimeIndex;

    if (!parsed.primes || !Array.isArray(parsed.primes)) {
      throw new Error("Invalid prime.index: missing or invalid 'primes' array");
    }

    // Validate each entry has required fields
    for (const entry of parsed.primes) {
      if (!entry.name || !entry.type || !entry.sig || !entry.desc) {
        throw new Error(
          `Invalid index entry: missing required fields (name, type, sig, desc) in entry: ${JSON.stringify(entry)}`
        );
      }
    }

    this.entries = parsed.primes;
    return parsed;
  }

  /**
   * Load index from an in-memory PrimeIndex object.
   * Useful for testing or when the index is already parsed.
   */
  loadFromData(index: PrimeIndex): void {
    this.entries = index.primes;
  }

  /**
   * Match a user query against index entries using keyword matching.
   *
   * Matching strategy:
   * 1. Tokenize the query into lowercase keywords
   * 2. Score each entry by how many keywords match its name, desc, sig, and links
   * 3. Return entries with at least one keyword match, sorted by score descending
   *
   * @param query - Natural language query string
   * @returns Matched entries sorted by relevance
   */
  match(query: string): IndexEntry[] {
    if (!query.trim()) return [];

    const keywords = query
      .toLowerCase()
      .split(/[\s,;:.\-_/]+/)
      .filter((k) => k.length > 1);

    if (keywords.length === 0) return [];

    const scored = this.entries.map((entry) => {
      const searchText = [
        entry.name,
        entry.desc,
        entry.sig,
        entry.type,
        ...(entry.links ?? []),
      ]
        .join(" ")
        .toLowerCase();

      let score = 0;
      for (const keyword of keywords) {
        if (searchText.includes(keyword)) {
          score++;
        }
        // Bonus for exact name match
        if (entry.name.toLowerCase() === keyword) {
          score += 3;
        }
        // Bonus for name contains keyword
        if (entry.name.toLowerCase().includes(keyword)) {
          score += 1;
        }
      }

      return { entry, score };
    });

    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((s) => s.entry);
  }

  /**
   * Get a specific entry by exact name.
   *
   * @param name - The Prime name to look up
   * @returns The entry, or null if not found
   */
  getEntry(name: string): IndexEntry | null {
    return this.entries.find((e) => e.name === name) ?? null;
  }

  /**
   * Get all loaded entries.
   */
  getEntries(): IndexEntry[] {
    return [...this.entries];
  }

  /**
   * Format the index as text suitable for injection into an AI system prompt.
   *
   * Output format (one line per Prime):
   *   sig | desc | links...
   *
   * This format is compact (~20 tokens per line) and designed for
   * AI comprehension.
   */
  toSystemPrompt(): string {
    if (this.entries.length === 0) {
      return "";
    }

    const header = [
      "You have access to the following Prime knowledge base:",
      "",
      'When you need this knowledge, call prime_load(name, level) to load detailed content.',
      "",
    ].join("\n");

    const lines = this.entries.map((entry) => {
      let line = `${entry.sig} | ${entry.desc}`;
      if (entry.links && entry.links.length > 0) {
        line += ` | ${entry.links.join(", ")}`;
      }
      return line;
    });

    return header + lines.join("\n");
  }

  /**
   * Format index entries as tool definitions for AI function calling.
   *
   * Each Prime becomes a tool with:
   * - name: "prime_{primeName}" (kebab to snake)
   * - description: from the index desc + sig
   * - parameters: extracted from the sig's input portion
   *
   * Also includes the standard prime_load and prime_evaluate tools.
   */
  toToolDefinitions(): ToolDefinition[] {
    const tools: ToolDefinition[] = [];

    // Standard prime_load tool
    tools.push({
      name: "prime_load",
      description:
        "Load a Prime's knowledge content. level: 1=core method, 2=full compiled, 3=source",
      parameters: {
        name: { type: "string", description: "Prime name" },
        level: { type: "integer", description: "Loading level (1, 2, or 3)", enum: [1, 2, 3] },
        block: { type: "string", description: "Optional: only load a specific block (steps/checks/...)" },
      },
    });

    // Standard prime_evaluate tool
    tools.push({
      name: "prime_evaluate",
      description: "Run evaluation criteria against execution results",
      parameters: {
        prime_name: { type: "string", description: "Prime name to evaluate" },
        context: { type: "string", description: "Execution result context" },
      },
    });

    // Per-Prime tools (only for Method type, which is executable)
    for (const entry of this.entries) {
      if (entry.type !== "Method") continue;

      const toolName = `prime_${entry.name.replace(/-/g, "_")}`;

      // Parse parameters from sig: "name(param1, param2) -> output"
      const params = this.parseSigParams(entry.sig);

      tools.push({
        name: toolName,
        description: `${entry.desc}. Signature: ${entry.sig}`,
        parameters: params,
      });
    }

    return tools;
  }

  /**
   * Parse parameter names from a signature string.
   * e.g. "tdd(task, lang) -> tests, impl" => { task: {...}, lang: {...} }
   */
  private parseSigParams(sig: string): Record<string, ToolParameter> {
    const params: Record<string, ToolParameter> = {};

    const match = sig.match(/\(([^)]*)\)/);
    if (!match) return params;

    const paramNames = match[1].split(",").map((p) => p.trim()).filter(Boolean);
    for (const name of paramNames) {
      params[name] = {
        type: "string",
        description: `Input: ${name}`,
      };
    }

    return params;
  }
}
