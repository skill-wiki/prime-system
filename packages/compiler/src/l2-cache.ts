/**
 * @module l2-cache
 * Content-hash cache for LLM L2 results.
 *
 * Key = sha256(ast_json + model_id + prompt_version). Stored as JSON under
 * .prime-cache/l2/<prefix>/<hash>.json. Any structural change to the atom
 * (tags, fields, facts, checks) invalidates the entry; metadata-only changes
 * (like a formatting tweak) also invalidate it because the hash is over the
 * full AST JSON. That's intentional — we prefer conservative re-validation
 * over subtle cache poisoning.
 *
 * The cache is optional — `get` returns null on miss, `put` is fire-and-forget.
 * Failures (permission, disk full) do not propagate. LLM correctness takes
 * precedence over caching.
 */

import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import type { Diagnostic } from "./types";

/** Increment when the prompt format or response schema changes. */
export const L2_PROMPT_VERSION = "2026-04-20-v1";

const DEFAULT_CACHE_DIR = ".prime-cache/l2";

function keyFor(astJson: string, model: string, promptVersion: string): string {
  return createHash("sha256")
    .update(astJson)
    .update("\0")
    .update(model)
    .update("\0")
    .update(promptVersion)
    .digest("hex");
}

function pathFor(cacheDir: string, key: string): string {
  return join(cacheDir, key.slice(0, 2), `${key}.json`);
}

export interface L2CacheEntry {
  key: string;
  model: string;
  promptVersion: string;
  createdAt: string; // ISO-8601
  diagnostics: Diagnostic[];
}

export interface L2CacheOptions {
  /** Cache directory, default ".prime-cache/l2" relative to cwd. */
  cacheDir?: string;
  /** Disable cache entirely (for testing). */
  disabled?: boolean;
}

export class L2Cache {
  private readonly dir: string;
  private readonly disabled: boolean;
  hits = 0;
  misses = 0;
  writes = 0;

  constructor(options: L2CacheOptions = {}) {
    this.dir = options.cacheDir ?? DEFAULT_CACHE_DIR;
    this.disabled = options.disabled === true;
  }

  /**
   * Look up cached diagnostics for this AST + model.
   * Returns null on miss or if cache is disabled.
   */
  get(astJson: string, model: string): Diagnostic[] | null {
    if (this.disabled) return null;
    const key = keyFor(astJson, model, L2_PROMPT_VERSION);
    const file = pathFor(this.dir, key);
    if (!existsSync(file)) {
      this.misses++;
      return null;
    }
    try {
      const raw = readFileSync(file, "utf-8");
      const entry = JSON.parse(raw) as L2CacheEntry;
      if (entry.promptVersion !== L2_PROMPT_VERSION) {
        this.misses++;
        return null;
      }
      this.hits++;
      return entry.diagnostics;
    } catch {
      this.misses++;
      return null;
    }
  }

  /**
   * Persist diagnostics for this AST + model.
   * Failures are silent — the calling compiler continues with the fresh LLM result.
   */
  put(astJson: string, model: string, diagnostics: Diagnostic[]): void {
    if (this.disabled) return;
    const key = keyFor(astJson, model, L2_PROMPT_VERSION);
    const file = pathFor(this.dir, key);
    try {
      if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true });
      const entry: L2CacheEntry = {
        key,
        model,
        promptVersion: L2_PROMPT_VERSION,
        createdAt: new Date().toISOString(),
        diagnostics,
      };
      writeFileSync(file, JSON.stringify(entry), "utf-8");
      this.writes++;
    } catch {
      // Fail-silent — caching is best-effort.
    }
  }

  stats(): { hits: number; misses: number; writes: number } {
    return { hits: this.hits, misses: this.misses, writes: this.writes };
  }
}

/** Module-level default instance — callers can ignore construction. */
export const defaultL2Cache = new L2Cache();
