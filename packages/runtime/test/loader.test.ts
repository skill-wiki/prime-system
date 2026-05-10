/**
 * Tests for PrimeLoader — four-level loading, relationship-driven
 * load order, block extraction, and caching.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { PrimeLoader } from "../src/loader";
import type { PrimeIndex } from "../src/types";

// ─── Test Fixtures ─────────────────────────────────────────────────────────

const TEST_DIR = join(import.meta.dir, ".tmp-test-loader");

const SAMPLE_INDEX: PrimeIndex = {
  primes: [
    {
      name: "tdd-red-green-refactor",
      type: "Method",
      sig: 'tdd(task, lang) → tests, impl',
      desc: "TDD红绿重构",
      links: ["validates: test-coverage-standard"],
    },
    {
      name: "owasp-top-10",
      type: "Knowledge",
      sig: "owasp() → categories",
      desc: "OWASP十大安全风险",
    },
    {
      name: "test-coverage-standard",
      type: "Rule",
      sig: "coverage() → pass/warn/block",
      desc: "测试覆盖率标准",
    },
    {
      name: "security-stride",
      type: "Method",
      sig: "stride(code) → threats, fixes",
      desc: "STRIDE安全审计",
      links: [
        "requires: owasp-top-10",
        "validates: security-checklist",
      ],
    },
    {
      name: "security-checklist",
      type: "Rule",
      sig: "seccheck() → pass/fail",
      desc: "安全检查清单",
    },
  ],
};

// Sample compiled markdown content
const TDD_COMPILED = `# tdd-red-green-refactor

## Steps

### RED
Write a failing test that describes the desired behavior.

### GREEN
Write the minimal implementation to make the test pass.

### REFACTOR
Refactor the code while keeping tests green.

## Warnings

- "Don't write implementation before test" → "Always write the test first"
- "Don't refactor without green tests" → "Make sure all tests pass before refactoring"

## Checks

- All tests pass
- No unused exports
`;

const OWASP_COMPILED = `# owasp-top-10

## Definitions

### Injection
Untrusted data sent to an interpreter as part of a command or query.

### Broken Authentication
Application functions related to authentication and session management.

## Categories

- A01:2021 - Broken Access Control
- A02:2021 - Cryptographic Failures
- A03:2021 - Injection
`;

const COVERAGE_COMPILED = `# test-coverage-standard

## Checks

- Line coverage >= 80%
- Branch coverage >= 70%
- Function coverage >= 90%

## Thresholds

line_coverage: block < 60%, warn < 80%, pass >= 80%
`;

const TDD_SOURCE = `prime TDDRedGreenRefactor extends Method {
  version: "2.1.0"
  description: "TDD红绿重构"

  input: [
    task(string) "功能描述"
    language(string) "编程语言"
  ]

  steps: [
    RED { "编写一个会失败的测试" expect: fail }
    GREEN { "编写最小实现使测试通过" expect: pass }
    REFACTOR { "重构代码保持测试绿色" expect: pass }
  ]
}`;

// ─── Helpers ───────────────────────────────────────────────────────────────

function setupTestDir() {
  mkdirSync(join(TEST_DIR, "compiled"), { recursive: true });
  mkdirSync(join(TEST_DIR, "source"), { recursive: true });

  // Write compiled files
  writeFileSync(
    join(TEST_DIR, "compiled", "tdd-red-green-refactor.md"),
    TDD_COMPILED,
  );
  writeFileSync(
    join(TEST_DIR, "compiled", "owasp-top-10.md"),
    OWASP_COMPILED,
  );
  writeFileSync(
    join(TEST_DIR, "compiled", "test-coverage-standard.md"),
    COVERAGE_COMPILED,
  );

  // Write source file
  writeFileSync(
    join(TEST_DIR, "source", "tdd-red-green-refactor.prime"),
    TDD_SOURCE,
  );
}

function cleanupTestDir() {
  rmSync(TEST_DIR, { recursive: true, force: true });
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("PrimeLoader", () => {
  let loader: PrimeLoader;

  beforeEach(() => {
    setupTestDir();
    loader = new PrimeLoader(TEST_DIR);
    loader.setIndex(SAMPLE_INDEX);
  });

  afterEach(cleanupTestDir);

  // ─── L0: Index Entry ─────────────────────────────────────────────────

  describe("L0 — Index entry", () => {
    it("should return index entry as formatted text", () => {
      const content = loader.loadPrime("tdd-red-green-refactor", 0);

      expect(content).toContain("tdd(task, lang)");
      expect(content).toContain("TDD红绿重构");
      expect(content).toContain("validates: test-coverage-standard");
    });

    it("should return entry without links if none exist", () => {
      const content = loader.loadPrime("owasp-top-10", 0);

      expect(content).toContain("owasp()");
      expect(content).toContain("OWASP十大安全风险");
    });

    it("should throw for non-existent prime in index", () => {
      expect(() => loader.loadPrime("nonexistent", 0)).toThrow(
        'Prime "nonexistent" not found in index',
      );
    });
  });

  // ─── L1: Core Block ──────────────────────────────────────────────────

  describe("L1 — Core method block", () => {
    it("should extract steps block for Method type", () => {
      const content = loader.loadPrime("tdd-red-green-refactor", 1);

      expect(content).toContain("## Steps");
      expect(content).toContain("RED");
      expect(content).toContain("GREEN");
      expect(content).toContain("REFACTOR");
      // Should NOT include Warnings or Checks
      expect(content).not.toContain("## Warnings");
    });

    it("should extract checks block for Rule type", () => {
      const content = loader.loadPrime("test-coverage-standard", 1);

      expect(content).toContain("## Checks");
      expect(content).toContain("Line coverage >= 80%");
    });

    it("should extract definitions block for Knowledge type", () => {
      const content = loader.loadPrime("owasp-top-10", 1);

      expect(content).toContain("## Definitions");
      expect(content).toContain("Injection");
    });

    it("should support block-level loading with explicit block name", () => {
      const content = loader.loadPrime(
        "tdd-red-green-refactor",
        1,
        "warnings",
      );

      expect(content).toContain("## Warnings");
      expect(content).toContain("Don't write implementation before test");
      expect(content).not.toContain("## Steps");
    });
  });

  // ─── L2: Full Compiled ───────────────────────────────────────────────

  describe("L2 — Full compiled .md", () => {
    it("should return the entire compiled markdown", () => {
      const content = loader.loadPrime("tdd-red-green-refactor", 2);

      expect(content).toContain("## Steps");
      expect(content).toContain("## Warnings");
      expect(content).toContain("## Checks");
    });

    it("should support block extraction at L2", () => {
      const content = loader.loadPrime(
        "tdd-red-green-refactor",
        2,
        "warnings",
      );

      expect(content).toContain("## Warnings");
      expect(content).not.toContain("## Steps");
    });

    it("should throw for non-existent compiled file", () => {
      expect(() => loader.loadPrime("security-stride", 2)).toThrow(
        "Compiled Prime not found",
      );
    });
  });

  // ─── L3: Source ──────────────────────────────────────────────────────

  describe("L3 — Source .prime file", () => {
    it("should return the original .prime source", () => {
      const content = loader.loadPrime("tdd-red-green-refactor", 3);

      expect(content).toContain("prime TDDRedGreenRefactor extends Method");
      expect(content).toContain('version: "2.1.0"');
      expect(content).toContain("RED");
    });

    it("should throw for non-existent source file", () => {
      expect(() => loader.loadPrime("owasp-top-10", 3)).toThrow(
        "Prime source not found",
      );
    });
  });

  // ─── Relationship-driven Load Order ──────────────────────────────────

  describe("resolveLoadOrder", () => {
    it("should resolve simple Method with VALIDATES link", () => {
      const steps = loader.resolveLoadOrder("tdd-red-green-refactor");

      // Primary Prime
      const primary = steps.find((s) => s.phase === "primary");
      expect(primary).toBeDefined();
      expect(primary!.name).toBe("tdd-red-green-refactor");

      // VALIDATES: test-coverage-standard loads after
      const afterSteps = steps.filter((s) => s.phase === "after");
      expect(afterSteps.length).toBeGreaterThanOrEqual(1);
      expect(afterSteps.map((s) => s.name)).toContain(
        "test-coverage-standard",
      );
    });

    it("should resolve REQUIRES dependencies before the primary", () => {
      const steps = loader.resolveLoadOrder("security-stride");

      const beforeSteps = steps.filter((s) => s.phase === "before");
      const primaryIdx = steps.findIndex((s) => s.phase === "primary");
      const requireIdx = steps.findIndex(
        (s) => s.name === "owasp-top-10",
      );

      // owasp-top-10 should come before primary
      expect(requireIdx).toBeLessThan(primaryIdx);
      expect(beforeSteps.map((s) => s.name)).toContain("owasp-top-10");
    });

    it("should resolve VALIDATES after the primary", () => {
      const steps = loader.resolveLoadOrder("security-stride");

      const primaryIdx = steps.findIndex((s) => s.phase === "primary");
      const validateIdx = steps.findIndex(
        (s) => s.name === "security-checklist",
      );

      expect(validateIdx).toBeGreaterThan(primaryIdx);
    });

    it("should handle complete load sequence: REQUIRES -> PRIMARY -> VALIDATES", () => {
      const steps = loader.resolveLoadOrder("security-stride");

      const names = steps.map((s) => s.name);
      const owaspIdx = names.indexOf("owasp-top-10");
      const strideIdx = names.indexOf("security-stride");
      const checklistIdx = names.indexOf("security-checklist");

      expect(owaspIdx).toBeLessThan(strideIdx);
      expect(strideIdx).toBeLessThan(checklistIdx);
    });

    it("should include reason and relationship in load steps", () => {
      const steps = loader.resolveLoadOrder("security-stride");

      const owaspStep = steps.find((s) => s.name === "owasp-top-10")!;
      expect(owaspStep.reason).toContain("REQUIRES");
      expect(owaspStep.relationship).toBe("requires");

      const checklistStep = steps.find(
        (s) => s.name === "security-checklist",
      )!;
      expect(checklistStep.reason).toContain("VALIDATES");
      expect(checklistStep.relationship).toBe("validates");
    });

    it("should return single step for unknown Prime", () => {
      const steps = loader.resolveLoadOrder("unknown-prime");

      expect(steps).toHaveLength(1);
      expect(steps[0].phase).toBe("primary");
    });

    it("should set all load steps to L1", () => {
      const steps = loader.resolveLoadOrder("security-stride");

      for (const step of steps) {
        expect(step.level).toBe(1);
      }
    });
  });

  // ─── Caching ─────────────────────────────────────────────────────────

  describe("caching", () => {
    it("should cache loaded content", () => {
      // First load
      const content1 = loader.loadPrime("tdd-red-green-refactor", 2);
      // Second load (should come from cache)
      const content2 = loader.loadPrime("tdd-red-green-refactor", 2);

      expect(content1).toBe(content2);
      expect(loader.cache.has("tdd-red-green-refactor")).toBe(true);
      expect(loader.cache.get("tdd-red-green-refactor")!.has(2)).toBe(true);
    });

    it("should cache different levels independently", () => {
      loader.loadPrime("tdd-red-green-refactor", 0);
      loader.loadPrime("tdd-red-green-refactor", 2);

      const primeCache = loader.cache.get("tdd-red-green-refactor")!;
      expect(primeCache.has(0)).toBe(true);
      expect(primeCache.has(2)).toBe(true);
      expect(primeCache.get(0)).not.toBe(primeCache.get(2));
    });

    it("should clear cache for a specific Prime", () => {
      loader.loadPrime("tdd-red-green-refactor", 2);
      loader.loadPrime("owasp-top-10", 2);

      loader.clearCache("tdd-red-green-refactor");

      expect(loader.cache.has("tdd-red-green-refactor")).toBe(false);
      expect(loader.cache.has("owasp-top-10")).toBe(true);
    });

    it("should clear all cache", () => {
      loader.loadPrime("tdd-red-green-refactor", 2);
      loader.loadPrime("owasp-top-10", 2);

      loader.clearCache();

      expect(loader.cache.size).toBe(0);
    });
  });
});
