/**
 * @module method-loader
 *
 * Loads structured Method objects from a compiled atom pool.
 *
 * The atom pipeline (scripts/compile-all.ts) writes
 * `primes/compiled/methods.json` — a map of atom id → Method — produced
 * from every atom with `type: method`. This loader reads that file and
 * answers `getMethod(id)` queries.
 *
 * Used by PrimeExecutor.loadMethodDefinition to replace the pre-2026-04-17
 * stub that always returned null.
 */

import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import type { Method } from "@skill-wiki/types";

export class MethodLoader {
  private methods: Map<string, Method> = new Map();

  constructor(private readonly sourcePath: string) {
    this.reload();
  }

  /** Reload from disk. Silently becomes a no-op if the file is absent. */
  reload(): void {
    this.methods.clear();
    const path = resolve(this.sourcePath);
    if (!existsSync(path)) return;
    try {
      const raw = readFileSync(path, "utf8");
      const parsed = JSON.parse(raw) as Record<string, Method>;
      for (const [id, method] of Object.entries(parsed)) {
        this.methods.set(id, method);
      }
    } catch {
      // Leave the map empty; getMethod calls will return null
    }
  }

  /** Look up a Method by its atom id (e.g. "@community/design-qa-pre-ship-checklist"). */
  getMethod(id: string): Method | null {
    return this.methods.get(id) ?? null;
  }

  /** Returns how many Methods are loaded — useful for startup diagnostics. */
  size(): number {
    return this.methods.size;
  }

  /** All known Method ids. */
  ids(): string[] {
    return Array.from(this.methods.keys());
  }
}
