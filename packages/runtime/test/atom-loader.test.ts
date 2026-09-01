/**
 * Tests for atom-loader — projection-based runtime (AOE v3 model).
 *
 * Uses the handcrafted fixture directory at:
 *   packages/runtime/test/fixtures/atom-dir/
 *
 * The fixture contains 3 atoms:
 *   @community/method-modal-focus      (method, 142 core tok)
 *   @community/rule-focus-ring-required (rule,   68 core tok)
 *   @community/fact-wcag-focus-contrast (fact,   42 core tok)
 */

import { describe, it, expect } from "bun:test";
import { join } from "path";
import {
  loadIndex,
  loadAtomMeta,
  resolveProjection,
  resolveCollection,
  type GlobalIndex,
  type AtomMeta,
} from "../src/atom-loader";

const FIXTURE_DIR = join(import.meta.dir, "fixtures", "atom-dir");

// ---------------------------------------------------------------------------
// loadIndex
// ---------------------------------------------------------------------------

describe("loadIndex", () => {
  it("parses _index.xml into a GlobalIndex", () => {
    const index: GlobalIndex = loadIndex(FIXTURE_DIR);
    expect(index.version).toBe("1.0");
    expect(index.total).toBe(3);
    expect(index.totalTokens).toBe(212);
  });

  it("returns all atoms in the flat list", () => {
    const index = loadIndex(FIXTURE_DIR);
    expect(index.atoms).toHaveLength(3);
    const ids = index.atoms.map((a) => a.id);
    expect(ids).toContain("@community/method-modal-focus");
    expect(ids).toContain("@community/rule-focus-ring-required");
    expect(ids).toContain("@community/fact-wcag-focus-contrast");
  });

  it("populates atom kind, tokens, and quality", () => {
    const index = loadIndex(FIXTURE_DIR);
    const method = index.atoms.find((a) => a.id === "@community/method-modal-focus")!;
    expect(method.kind).toBe("method");
    expect(method.tokens).toBe(142);
    expect(method.quality).toBe(4.7);
  });

  it("includes description text from element body", () => {
    const index = loadIndex(FIXTURE_DIR);
    const fact = index.atoms.find((a) => a.id === "@community/fact-wcag-focus-contrast")!;
    expect(fact.description).toMatch(/3:1/);
  });

  it("groups atoms into clusters", () => {
    const index = loadIndex(FIXTURE_DIR);
    expect(index.clusters).toHaveLength(1);
    expect(index.clusters[0].name).toBe("accessibility");
    expect(index.clusters[0].density).toBe(0.85);
    expect(index.clusters[0].atoms).toHaveLength(3);
  });

  it("throws when _index.xml is missing", () => {
    expect(() => loadIndex("/tmp/nonexistent-prime-dir")).toThrow("_index.xml not found");
  });
});

// ---------------------------------------------------------------------------
// loadAtomMeta
// ---------------------------------------------------------------------------

describe("loadAtomMeta", () => {
  it("loads atom.yaml for a method atom", () => {
    const meta: AtomMeta = loadAtomMeta(FIXTURE_DIR, "@community/method-modal-focus");
    expect(meta.id).toBe("@community/method-modal-focus");
    expect(meta.kind).toBe("method");
    expect(meta.version).toBe("1.0.0");
  });

  it("populates token sizes", () => {
    const meta = loadAtomMeta(FIXTURE_DIR, "@community/method-modal-focus");
    expect(meta.tokens.summary).toBe(28);
    expect(meta.tokens.core).toBe(142);
    expect(meta.tokens.full).toBe(320);
  });

  it("populates projection paths", () => {
    const meta = loadAtomMeta(FIXTURE_DIR, "@community/method-modal-focus");
    expect(meta.projection.summary).toBe("chunks/summary.md");
    expect(meta.projection.core).toBe("chunks/core.md");
    expect(meta.projection.full).toBe("chunks/full.md");
  });

  it("loads relations array", () => {
    const meta = loadAtomMeta(FIXTURE_DIR, "@community/method-modal-focus");
    expect(meta.relations).toHaveLength(2);
    expect(meta.relations[0]).toEqual({
      type: "requires",
      target: "@community/fact-wcag-focus-contrast",
    });
    expect(meta.relations[1]).toEqual({
      type: "validates",
      target: "@community/rule-focus-ring-required",
    });
  });

  it("loads empty relations for a fact atom", () => {
    const meta = loadAtomMeta(FIXTURE_DIR, "@community/fact-wcag-focus-contrast");
    expect(meta.relations).toHaveLength(0);
  });

  it("loads tags", () => {
    const meta = loadAtomMeta(FIXTURE_DIR, "@community/rule-focus-ring-required");
    expect(meta.tags).toContain("a11y");
    expect(meta.tags).toContain("focus");
    expect(meta.tags).toContain("wcag");
  });

  it("loads quality scores", () => {
    const meta = loadAtomMeta(FIXTURE_DIR, "@community/rule-focus-ring-required");
    expect(meta.quality.overall).toBe(4.9);
  });

  it("throws when atom directory is missing", () => {
    expect(() =>
      loadAtomMeta(FIXTURE_DIR, "@community/nonexistent-atom"),
    ).toThrow("atom.yaml not found");
  });
});

// ---------------------------------------------------------------------------
// resolveProjection
// ---------------------------------------------------------------------------

describe("resolveProjection", () => {
  it("returns an absolute path for core level", () => {
    const path = resolveProjection(FIXTURE_DIR, "@community/method-modal-focus", "core");
    expect(path).toMatch(/chunks\/core\.md$/);
    // Must be absolute
    expect(path.startsWith("/")).toBe(true);
  });

  it("returns an absolute path for summary level", () => {
    const path = resolveProjection(FIXTURE_DIR, "@community/method-modal-focus", "summary");
    expect(path).toMatch(/chunks\/summary\.md$/);
  });

  it("returns an absolute path for full level", () => {
    const path = resolveProjection(FIXTURE_DIR, "@community/method-modal-focus", "full");
    expect(path).toMatch(/chunks\/full\.md$/);
  });

  it("path includes the atom id directory segment", () => {
    const path = resolveProjection(FIXTURE_DIR, "@community/rule-focus-ring-required", "core");
    expect(path).toContain("@community");
    expect(path).toContain("rule-focus-ring-required");
  });

  it("returned path exists on disk for all 3 atoms + all 3 levels", () => {
    const { existsSync } = require("fs");
    const atoms = [
      "@community/method-modal-focus",
      "@community/rule-focus-ring-required",
      "@community/fact-wcag-focus-contrast",
    ];
    const levels = ["summary", "core", "full"] as const;
    for (const atomId of atoms) {
      for (const level of levels) {
        const path = resolveProjection(FIXTURE_DIR, atomId, level);
        expect(existsSync(path)).toBe(true);
      }
    }
  });

  it("does NOT read file content — returns a path string only", () => {
    const result = resolveProjection(FIXTURE_DIR, "@community/method-modal-focus", "core");
    // The returned value is a string path, not file content
    expect(typeof result).toBe("string");
    expect(result).not.toContain("## Steps");
  });
});

// ---------------------------------------------------------------------------
// resolveCollection
// ---------------------------------------------------------------------------

describe("resolveCollection", () => {
  it("resolves a collection by slug from collections/ directory", () => {
    const result = resolveCollection(FIXTURE_DIR, "@community/collection-accessible-modal");
    expect(result.atomIds).toHaveLength(3);
    expect(result.atomIds).toContain("@community/method-modal-focus");
    expect(result.atomIds).toContain("@community/rule-focus-ring-required");
    expect(result.atomIds).toContain("@community/fact-wcag-focus-contrast");
  });

  it("returns the orchestration entry point", () => {
    const result = resolveCollection(FIXTURE_DIR, "@community/collection-accessible-modal");
    expect(result.orchestration).toBe("@community/method-modal-focus");
  });

  it("throws when collection is not found", () => {
    expect(() =>
      resolveCollection(FIXTURE_DIR, "@community/nonexistent-collection"),
    ).toThrow("Collection");
  });
});

// ---------------------------------------------------------------------------
// Lazy-load invariant: atom-loader never reads chunk content
// ---------------------------------------------------------------------------

describe("lazy-load invariant", () => {
  it("loadIndex never returns chunk file content", () => {
    const index = loadIndex(FIXTURE_DIR);
    // Index atom descriptions are short summaries, not full chunk content
    for (const atom of index.atoms) {
      expect(atom.description.length).toBeLessThan(200);
      expect(atom.description).not.toContain("## Steps");
      expect(atom.description).not.toContain("## Checks");
    }
  });

  it("loadAtomMeta returns metadata only, no chunk content", () => {
    const meta = loadAtomMeta(FIXTURE_DIR, "@community/method-modal-focus");
    // meta.description is the atom description, not chunk content
    expect(meta.description).not.toContain("## Steps");
    expect(meta.description).not.toContain("querySelectorAll");
    // projection fields are paths, not content
    expect(meta.projection.core).toBe("chunks/core.md");
  });

  it("resolveProjection result is a path string, not content", () => {
    const path = resolveProjection(FIXTURE_DIR, "@community/method-modal-focus", "full");
    // Content of full.md starts with "# method-modal-focus (full)"
    // The path string must NOT equal or contain that
    expect(path).not.toContain("# method-modal-focus");
    expect(path).not.toContain("Sources");
  });
});
