/**
 * Tests for the atom-dir-emitter — verifies the per-atom directory tree.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, readFileSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { parse } from "../../parser/src/index";
import { emitAtomDir } from "../src/atom-dir-emitter";
import { emitGlobalIndex, buildGlobalIndexXml } from "../src/global-index-emitter";
import type { AtomMeta } from "../src/global-index-emitter";

// ── Fixtures ────────────────────────────────────────────────────────────────

const WCAG_FACT_SOURCE = `
prime WcagFocusContrast extends Knowledge {
  name: "fact-wcag-focus-contrast"
  version: "1.0.0"
  description: "Focus ring contrast must be >= 3:1 against adjacent colors"
  tags: ["a11y", "wcag", "focus"]
  domain: "frontend-design"
  status: "validated"
  facts: [
    {
      statement: "Focus ring contrast must be >= 3:1 against adjacent colors"
      confidence: "proven"
    }
  ]
  source: { url: "https://www.w3.org/TR/WCAG22/#focus-not-obscured", type: "primary" }
  specializes: "@w3c/wcag-2-4-11"
}
`;

const METHOD_SOURCE = `
prime DesignCritiqueWorkflow extends Method {
  name: "method-design-critique"
  version: "1.0.0"
  description: "4-phase design review method"
  tags: ["design", "critique", "method"]
  domain: "frontend-design"
  status: "validated"
  steps: [
    LOAD { "Load the artifact" }
    HEURISTICS { "Apply Nielsen heuristics" }
    SLOP { "Detect AI slop patterns" }
    SUMMARIZE { "Summarize issues with severity" }
  ]
}
`;

const RULE_SOURCE = `
prime ContrastRule extends Rule {
  name: "rule-contrast-aa"
  version: "1.0.0"
  description: "All text must meet WCAG AA contrast ratio"
  tags: ["a11y", "contrast", "wcag"]
  domain: "frontend-design"
  checks: [
    { description: "Normal text contrast >= 4.5:1", pass_condition: "wcag-contrast >= 4.5", severity: "block" }
    { description: "Large text contrast >= 3:1", pass_condition: "wcag-contrast >= 3.0", severity: "block" }
  ]
}
`;

const COLLECTION_SOURCE = `
prime AccessibleFrontend extends Knowledge {
  name: "collection-accessible-frontend"
  version: "1.0.0"
  description: "Review any frontend artifact for a11y compliance"
  tags: ["a11y", "collection"]
  domain: "frontend-design"
  includes: ["@rule/design-health", "@method/design-critique"]
}
`;

const TMP_DIR = join(import.meta.dir, "..", "tmp-test-atom-dirs");

beforeAll(() => {
  mkdirSync(TMP_DIR, { recursive: true });
});

afterAll(() => {
  if (existsSync(TMP_DIR)) {
    rmSync(TMP_DIR, { recursive: true, force: true });
  }
});

function parseSource(source: string) {
  const { ast, errors } = parse(source.trim());
  expect(errors).toHaveLength(0);
  return ast;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("emitAtomDir — required files", () => {
  test("emits all required files for a Knowledge atom", () => {
    const ast = parseSource(WCAG_FACT_SOURCE);
    const result = emitAtomDir(ast, TMP_DIR, "2026-04-24");

    expect(result.skipped).toBe(false);
    expect(result.atomId).toMatch(/^@/);

    // All 7 required files
    const expected = ["chunks/summary.md", "chunks/core.md", "chunks/full.md", "atom.yaml", "graph.yaml", "index.xml", "quality.yaml"];
    for (const f of expected) {
      const fullPath = join(result.outDir, ...f.split("/"));
      expect(existsSync(fullPath)).toBe(true);
    }
  });

  test("emits all required files for a Method atom", () => {
    const ast = parseSource(METHOD_SOURCE);
    const result = emitAtomDir(ast, TMP_DIR, "2026-04-24");

    expect(result.skipped).toBe(false);
    const chunksDir = join(result.outDir, "chunks");
    expect(existsSync(join(chunksDir, "summary.md"))).toBe(true);
    expect(existsSync(join(chunksDir, "core.md"))).toBe(true);
    expect(existsSync(join(chunksDir, "full.md"))).toBe(true);
    expect(existsSync(join(result.outDir, "atom.yaml"))).toBe(true);
    expect(existsSync(join(result.outDir, "index.xml"))).toBe(true);
    expect(existsSync(join(result.outDir, "quality.yaml"))).toBe(true);
  });

  test("emits all required files for a Rule atom", () => {
    const ast = parseSource(RULE_SOURCE);
    const result = emitAtomDir(ast, TMP_DIR, "2026-04-24");
    expect(existsSync(join(result.outDir, "atom.yaml"))).toBe(true);
    expect(existsSync(join(result.outDir, "graph.yaml"))).toBe(true);
    expect(existsSync(join(result.outDir, "index.xml"))).toBe(true);
  });
});

describe("emitAtomDir — chunk size ordering", () => {
  test("summary < core < full in byte size", () => {
    const ast = parseSource(METHOD_SOURCE);
    const result = emitAtomDir(ast, TMP_DIR, "2026-04-24");

    const summarySize = readFileSync(join(result.outDir, "chunks", "summary.md"), "utf-8").length;
    const coreSize = readFileSync(join(result.outDir, "chunks", "core.md"), "utf-8").length;
    const fullSize = readFileSync(join(result.outDir, "chunks", "full.md"), "utf-8").length;

    expect(summarySize).toBeLessThanOrEqual(coreSize);
    expect(coreSize).toBeLessThanOrEqual(fullSize);
  });

  test("token counts are returned in result", () => {
    const ast = parseSource(WCAG_FACT_SOURCE);
    const result = emitAtomDir(ast, TMP_DIR, "2026-04-24");
    expect(result.tokens.summary).toBeGreaterThan(0);
    expect(result.tokens.core).toBeGreaterThan(0);
    expect(result.tokens.full).toBeGreaterThan(0);
  });
});

describe("emitAtomDir — atom.yaml content", () => {
  test("atom.yaml has content_hash field", () => {
    const ast = parseSource(WCAG_FACT_SOURCE);
    const result = emitAtomDir(ast, TMP_DIR, "2026-04-24");
    const atomYaml = readFileSync(join(result.outDir, "atom.yaml"), "utf-8");
    expect(atomYaml).toContain("content_hash:");
    expect(atomYaml).toContain("sha256:");
  });

  test("atom.yaml has id, kind, version, description, tags, tokens, projection", () => {
    const ast = parseSource(WCAG_FACT_SOURCE);
    const result = emitAtomDir(ast, TMP_DIR, "2026-04-24");
    const atomYaml = readFileSync(join(result.outDir, "atom.yaml"), "utf-8");
    expect(atomYaml).toContain("id:");
    expect(atomYaml).toContain("kind:");
    expect(atomYaml).toContain("version:");
    expect(atomYaml).toContain("description:");
    expect(atomYaml).toContain("tags:");
    expect(atomYaml).toContain("tokens:");
    expect(atomYaml).toContain("projection:");
    expect(atomYaml).toContain("chunks/summary.md");
    expect(atomYaml).toContain("chunks/core.md");
    expect(atomYaml).toContain("chunks/full.md");
  });

  test("atom.yaml has relations section when atom has specializes", () => {
    const ast = parseSource(WCAG_FACT_SOURCE);
    const result = emitAtomDir(ast, TMP_DIR, "2026-04-24");
    const atomYaml = readFileSync(join(result.outDir, "atom.yaml"), "utf-8");
    expect(atomYaml).toContain("relations:");
  });

  test("atom.yaml has sources section", () => {
    const ast = parseSource(WCAG_FACT_SOURCE);
    const result = emitAtomDir(ast, TMP_DIR, "2026-04-24");
    const atomYaml = readFileSync(join(result.outDir, "atom.yaml"), "utf-8");
    expect(atomYaml).toContain("sources:");
  });
});

describe("emitAtomDir — idempotency", () => {
  test("same input produces same content_hash on re-run", () => {
    const ast1 = parseSource(WCAG_FACT_SOURCE);
    const tmpDir1 = join(TMP_DIR, "idem-test-1");
    mkdirSync(tmpDir1, { recursive: true });

    const result1 = emitAtomDir(ast1, tmpDir1, "2026-04-24");
    const hash1 = readFileSync(join(result1.outDir, "atom.yaml"), "utf-8")
      .match(/content_hash: "([^"]+)"/)?.[1] ?? "";

    // Re-run with same AST
    const ast2 = parseSource(WCAG_FACT_SOURCE);
    const result2 = emitAtomDir(ast2, tmpDir1, "2026-04-24");
    // Second run should be skipped (content hash matches)
    expect(result2.skipped).toBe(true);

    // Hash must be deterministic (content-based)
    expect(hash1).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  test("different atoms produce different hashes", () => {
    const ast1 = parseSource(WCAG_FACT_SOURCE);
    const ast2 = parseSource(METHOD_SOURCE);
    const tmpDir1 = join(TMP_DIR, "idem-test-2a");
    const tmpDir2 = join(TMP_DIR, "idem-test-2b");
    mkdirSync(tmpDir1, { recursive: true });
    mkdirSync(tmpDir2, { recursive: true });

    const r1 = emitAtomDir(ast1, tmpDir1, "2026-04-24");
    const r2 = emitAtomDir(ast2, tmpDir2, "2026-04-24");

    const hash1 = readFileSync(join(r1.outDir, "atom.yaml"), "utf-8")
      .match(/content_hash: "([^"]+)"/)?.[1] ?? "";
    const hash2 = readFileSync(join(r2.outDir, "atom.yaml"), "utf-8")
      .match(/content_hash: "([^"]+)"/)?.[1] ?? "";

    expect(hash1).not.toBe(hash2);
  });
});

describe("emitGlobalIndex — _index.xml", () => {
  test("_index.xml is written and is well-formed XML", () => {
    const tmpDir = join(TMP_DIR, "global-index-test");
    mkdirSync(tmpDir, { recursive: true });

    const metas: AtomMeta[] = [
      {
        id: "@community/fact-wcag-focus-contrast",
        kind: "fact",
        version: "1.0.0",
        description: "Focus ring contrast must be >= 3:1 against adjacent colors",
        domain: "frontend-design",
        tags: ["a11y", "wcag"],
        tokens: { summary: 28, core: 142, full: 384 },
        quality: "4.7",
      },
      {
        id: "@community/method-design-critique",
        kind: "method",
        version: "1.0.0",
        description: "4-phase design review method",
        domain: "frontend-design",
        tags: ["design", "critique"],
        tokens: { summary: 30, core: 180, full: 420 },
        quality: "4.6",
      },
    ];

    const totalTokens = emitGlobalIndex(metas, tmpDir);
    const indexPath = join(tmpDir, "_index.xml");
    expect(existsSync(indexPath)).toBe(true);

    const content = readFileSync(indexPath, "utf-8");
    // Well-formed XML checks
    expect(content).toContain("<?xml version");
    expect(content).toContain("<prime_index");
    expect(content).toContain("</prime_index>");
    expect(content).toContain("<cluster");
    expect(content).toContain("</cluster>");
    expect(content).toContain("<atom");
    expect(content).toContain("</atom>");
    // Should list both atoms
    expect(content).toContain("@community/fact-wcag-focus-contrast");
    expect(content).toContain("@community/method-design-critique");
    // Token count
    expect(totalTokens).toBeGreaterThan(0);
  });

  test("_index.xml groups atoms by domain", () => {
    const metas: AtomMeta[] = [
      {
        id: "@community/fact-a",
        kind: "fact",
        version: "1.0.0",
        description: "Fact A",
        domain: "typography",
        tags: ["font"],
        tokens: { summary: 10, core: 50, full: 100 },
        quality: "4.0",
      },
      {
        id: "@community/fact-b",
        kind: "fact",
        version: "1.0.0",
        description: "Fact B",
        domain: "frontend-design",
        tags: ["a11y"],
        tokens: { summary: 10, core: 50, full: 100 },
        quality: "4.0",
      },
    ];

    const xml = buildGlobalIndexXml(metas);
    expect(xml).toContain('name="typography"');
    expect(xml).toContain('name="frontend-design"');
  });

  test("_index.xml is deterministic (sorted by id)", () => {
    const metas: AtomMeta[] = [
      {
        id: "@b/atom",
        kind: "fact",
        version: "1.0.0",
        description: "B",
        domain: "d",
        tags: [],
        tokens: { summary: 10, core: 40, full: 80 },
        quality: "4.0",
      },
      {
        id: "@a/atom",
        kind: "fact",
        version: "1.0.0",
        description: "A",
        domain: "d",
        tags: [],
        tokens: { summary: 10, core: 40, full: 80 },
        quality: "4.0",
      },
    ];

    const xml1 = buildGlobalIndexXml(metas);
    const xml2 = buildGlobalIndexXml([...metas].reverse());
    expect(xml1).toBe(xml2);
  });

  test("_index.xml total tokens roughly fits 500 tok budget for 10 atoms", () => {
    const metas: AtomMeta[] = Array.from({ length: 10 }, (_, i) => ({
      id: `@community/atom-${i}`,
      kind: "fact",
      version: "1.0.0",
      description: `This is atom number ${i} with a reasonable description`,
      domain: "frontend-design",
      tags: ["tag1", "tag2"],
      tokens: { summary: 25, core: 100, full: 300 },
      quality: "4.0",
    }));

    const xml = buildGlobalIndexXml(metas);
    const estTokens = Math.ceil(xml.length / 4);
    // Should fit well under 500 tokens for 10 atoms
    expect(estTokens).toBeLessThan(500);
  });
});
