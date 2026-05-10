/**
 * @module loader
 * PrimeLoader — four-level progressive loading of compiled Primes.
 *
 * Loading levels:
 *   L0 — Index entry (~20 tokens, always in context)
 *   L1 — Method/core block (~30-50 tokens, execution)
 *   L2 — Full compiled .md (~60-100 tokens, error handling + self-check)
 *   L3 — .prime source (~150-300 tokens, debugging)
 *
 * Loading is relationship-driven:
 *   REQUIRES  → load target before current Prime
 *   SUPPLIES  → load knowledge before REQUIRES
 *   VALIDATES → load rule after current Prime executes
 *   ENHANCES  → suggest but don't auto-load
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import type { IndexEntry, LoadLevel, LoadStep, PrimeIndex } from "./types";

/**
 * Manages progressive loading of Prime content at four detail levels.
 *
 * The loader reads from the .primes/ directory structure:
 *   .primes/
 *     prime.index          — L0 index
 *     compiled/
 *       {name}.md          — L2 full compiled markdown
 *     source/
 *       {name}.prime       — L3 original source
 *
 * L1 content is extracted from the L2 compiled markdown by reading
 * only the specified block (e.g., steps, checks, definitions).
 */
export class PrimeLoader {
  /** Base directory containing .primes/ artifacts */
  private baseDir: string;
  /** Loaded index entries for relationship resolution */
  private index: Map<string, IndexEntry> = new Map();
  /**
   * Cache: Map<primeName, Map<level, content>>
   * Each level's content is cached after first load.
   */
  readonly cache: Map<string, Map<number, string>> = new Map();

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  /**
   * Set the index data for relationship resolution.
   */
  setIndex(primeIndex: PrimeIndex): void {
    this.index.clear();
    for (const entry of primeIndex.primes) {
      this.index.set(entry.name, entry);
    }
  }

  /**
   * Load a Prime at the specified level, optionally restricted to a block.
   *
   * @param name  - Prime identifier
   * @param level - Loading level (0-3)
   * @param block - Optional block name to extract from L1/L2
   *                (e.g. "steps", "checks", "definitions", "warnings")
   * @returns Content string at the requested level
   * @throws If the Prime or level content cannot be found
   */
  loadPrime(name: string, level: LoadLevel, block?: string): string {
    // Check cache (block-specific loads aren't cached separately)
    const cacheKey = block ? -1 : level; // don't use cache for block-level loads
    if (cacheKey >= 0) {
      const cached = this.cache.get(name)?.get(cacheKey);
      if (cached !== undefined) {
        return cached;
      }
    }

    let content: string;

    switch (level) {
      case 0:
        content = this.loadL0(name);
        break;
      case 1:
        content = this.loadL1(name, block);
        break;
      case 2:
        content = this.loadL2(name, block);
        break;
      case 3:
        content = this.loadL3(name);
        break;
      default:
        throw new Error(`Invalid load level: ${level}`);
    }

    // Cache the result (only for full loads, not block-specific)
    if (cacheKey >= 0) {
      if (!this.cache.has(name)) {
        this.cache.set(name, new Map());
      }
      this.cache.get(name)!.set(cacheKey, content);
    }

    return content;
  }

  /**
   * Resolve the complete load sequence for a Prime based on its relationships.
   *
   * Load order rules (from spec):
   *   1. SUPPLIES targets load first (Knowledge before everything)
   *   2. REQUIRES targets load before the primary Prime
   *   3. Primary Prime loads
   *   4. VALIDATES targets load after the primary Prime
   *   5. ENHANCES targets are noted but not auto-loaded
   *
   * @param name - The primary Prime to resolve
   * @returns Ordered load steps
   */
  resolveLoadOrder(name: string): LoadStep[] {
    const entry = this.index.get(name);
    if (!entry) {
      return [
        {
          name,
          level: 1,
          reason: "Primary Prime (not in index)",
          phase: "primary",
        },
      ];
    }

    const steps: LoadStep[] = [];
    const visited = new Set<string>();

    // Parse links from the index entry
    const links = this.parseLinks(entry.links ?? []);

    // Phase 1: SUPPLIES — load knowledge dependencies first
    for (const link of links) {
      if (link.verb === "supplies" || link.verb === "supplies_to") {
        // The supplies target provides knowledge to us
        // Actually, in the index, links are stored from the perspective of the entry
        // "supplies: X" means this Prime supplies to X
        // We need the reverse: who supplies to us
        // Let's check all entries for who supplies to this name
      }
    }

    // Check all index entries for SUPPLIES relationships pointing to this Prime
    for (const [otherName, otherEntry] of this.index) {
      if (otherName === name || visited.has(otherName)) continue;
      const otherLinks = this.parseLinks(otherEntry.links ?? []);
      for (const link of otherLinks) {
        if (
          (link.verb === "supplies" || link.verb === "supplies_to") &&
          link.target === name
        ) {
          visited.add(otherName);
          steps.push({
            name: otherName,
            level: 1,
            reason: `SUPPLIES knowledge to ${name}`,
            relationship: "supplies",
            phase: "before",
          });
        }
      }
    }

    // Phase 2: REQUIRES — load dependencies before
    for (const link of links) {
      if (link.verb === "requires" && !visited.has(link.target)) {
        visited.add(link.target);

        // Check if the required Prime itself has SUPPLIES dependencies
        const reqEntry = this.index.get(link.target);
        if (reqEntry) {
          for (const [supName, supEntry] of this.index) {
            if (supName === name || supName === link.target || visited.has(supName))
              continue;
            const supLinks = this.parseLinks(supEntry.links ?? []);
            for (const sl of supLinks) {
              if (
                (sl.verb === "supplies" || sl.verb === "supplies_to") &&
                sl.target === link.target
              ) {
                visited.add(supName);
                steps.push({
                  name: supName,
                  level: 1,
                  reason: `SUPPLIES knowledge to ${link.target} (required by ${name})`,
                  relationship: "supplies",
                  phase: "before",
                });
              }
            }
          }
        }

        steps.push({
          name: link.target,
          level: 1,
          reason: `REQUIRES dependency (load before ${name})`,
          relationship: "requires",
          phase: "before",
        });
      }
    }

    // Phase 3: Primary Prime
    steps.push({
      name,
      level: 1,
      reason: "Primary Prime",
      phase: "primary",
    });

    // Phase 4: VALIDATES — load validation rules after
    for (const link of links) {
      if (
        (link.verb === "validates" || link.verb === "validates_with") &&
        !visited.has(link.target)
      ) {
        visited.add(link.target);
        steps.push({
          name: link.target,
          level: 1,
          reason: `VALIDATES rule (load after ${name} executes)`,
          relationship: "validates",
          phase: "after",
        });
      }
    }

    return steps;
  }

  /**
   * Clear the cache for a specific Prime or all Primes.
   */
  clearCache(name?: string): void {
    if (name) {
      this.cache.delete(name);
    } else {
      this.cache.clear();
    }
  }

  // ─── Private Loading Methods ─────────────────────────────────────────────

  /**
   * L0: Return the index entry as formatted text.
   */
  private loadL0(name: string): string {
    const entry = this.index.get(name);
    if (!entry) {
      throw new Error(`Prime "${name}" not found in index`);
    }

    let line = `${entry.sig} | ${entry.desc}`;
    if (entry.links && entry.links.length > 0) {
      line += ` | ${entry.links.join(", ")}`;
    }
    return line;
  }

  /**
   * L1: Load the core method block from the compiled .md file.
   * If a block is specified, extract only that section.
   * Otherwise extract the primary content block (steps for Method,
   * checks for Rule, definitions/categories for Knowledge).
   */
  private loadL1(name: string, block?: string): string {
    const compiled = this.readCompiled(name);

    if (block) {
      return this.extractBlock(compiled, block);
    }

    // Extract primary block based on type
    const entry = this.index.get(name);
    if (entry) {
      switch (entry.type) {
        case "Method":
          return this.extractBlock(compiled, "steps");
        case "Rule":
          return this.extractBlock(compiled, "checks");
        case "Knowledge":
          // Try definitions first, then categories
          const defs = this.extractBlock(compiled, "definitions");
          if (defs) return defs;
          return this.extractBlock(compiled, "categories");
      }
    }

    // Fallback: return first major section
    return this.extractFirstSection(compiled);
  }

  /**
   * L2: Load the full compiled .md file.
   * If a block is specified, extract that section.
   */
  private loadL2(name: string, block?: string): string {
    const compiled = this.readCompiled(name);

    if (block) {
      return this.extractBlock(compiled, block);
    }

    return compiled;
  }

  /**
   * L3: Load the original .prime source file.
   */
  private loadL3(name: string): string {
    const sourcePath = join(this.baseDir, "source", `${name}.prime`);

    if (!existsSync(sourcePath)) {
      throw new Error(`Prime source not found: ${sourcePath}`);
    }

    return readFileSync(sourcePath, "utf-8");
  }

  // ─── Private Helpers ─────────────────────────────────────────────────────

  /**
   * Read the compiled .md file for a Prime.
   */
  private readCompiled(name: string): string {
    const compiledPath = join(this.baseDir, "compiled", `${name}.md`);

    if (!existsSync(compiledPath)) {
      throw new Error(`Compiled Prime not found: ${compiledPath}`);
    }

    return readFileSync(compiledPath, "utf-8");
  }

  /**
   * Extract a named block/section from compiled markdown.
   *
   * Blocks are identified by markdown headings containing the block name:
   *   ## Steps
   *   ## Checks
   *   ## Definitions
   *   ## Warnings
   *   etc.
   *
   * Returns content from the heading to the next heading of same or higher level.
   */
  private extractBlock(content: string, blockName: string): string {
    const lines = content.split("\n");
    const lowerBlock = blockName.toLowerCase();
    let capturing = false;
    let captureLevel = 0;
    const captured: string[] = [];

    for (const line of lines) {
      const headingMatch = line.match(/^(#{1,6})\s+(.+)/);

      if (headingMatch) {
        const level = headingMatch[1].length;
        const title = headingMatch[2].toLowerCase().trim();

        if (title.includes(lowerBlock)) {
          capturing = true;
          captureLevel = level;
          captured.push(line);
          continue;
        }

        if (capturing && level <= captureLevel) {
          // Reached next section of same or higher level
          break;
        }
      }

      if (capturing) {
        captured.push(line);
      }
    }

    return captured.join("\n").trim();
  }

  /**
   * Extract the first section of content (fallback for L1).
   */
  private extractFirstSection(content: string): string {
    const lines = content.split("\n");
    const result: string[] = [];
    let foundFirst = false;

    for (const line of lines) {
      const headingMatch = line.match(/^(#{1,6})\s+/);

      if (headingMatch) {
        if (foundFirst) {
          // Hit the second heading, stop
          break;
        }
        foundFirst = true;
      }

      if (foundFirst) {
        result.push(line);
      }
    }

    // If no headings, return first 20 lines
    if (result.length === 0) {
      return lines.slice(0, 20).join("\n").trim();
    }

    return result.join("\n").trim();
  }

  /**
   * Parse link strings from index entries.
   *
   * Links in the index are stored as:
   *   "validates: test-coverage-standard"
   *   "requires: owasp-top-10"
   *   "supplies: security-stride"
   */
  private parseLinks(links: string[]): Array<{ verb: string; target: string }> {
    return links.map((link) => {
      const match = link.match(/^(\w+):\s*(.+)$/);
      if (!match) {
        return { verb: "unknown", target: link };
      }
      return { verb: match[1].trim(), target: match[2].trim() };
    });
  }
}
