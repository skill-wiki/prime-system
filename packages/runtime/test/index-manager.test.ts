/**
 * Tests for IndexManager — index loading, query matching,
 * system prompt formatting, and tool definition generation.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { IndexManager } from "../src/index-manager";
import type { PrimeIndex, IndexEntry } from "../src/types";

// ─── Test Fixtures ─────────────────────────────────────────────────────────

const TEST_DIR = join(import.meta.dir, ".tmp-test-index");

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
  ],
};

// ─── Helpers ───────────────────────────────────────────────────────────────

function setupTestDir() {
  mkdirSync(TEST_DIR, { recursive: true });
  writeFileSync(
    join(TEST_DIR, "prime.index"),
    JSON.stringify(SAMPLE_INDEX, null, 2),
  );
}

function cleanupTestDir() {
  rmSync(TEST_DIR, { recursive: true, force: true });
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("IndexManager", () => {
  let manager: IndexManager;

  beforeEach(() => {
    manager = new IndexManager();
  });

  // ─── Loading ───────────────────────────────────────────────────────────

  describe("loadIndex", () => {
    beforeEach(setupTestDir);
    afterEach(cleanupTestDir);

    it("should load index from a directory with prime.index file", () => {
      const index = manager.loadIndex(TEST_DIR);

      expect(index.primes).toHaveLength(4);
      expect(index.primes[0].name).toBe("tdd-red-green-refactor");
    });

    it("should throw if prime.index does not exist", () => {
      expect(() => manager.loadIndex("/nonexistent/path")).toThrow(
        "prime.index not found",
      );
    });

    it("should throw if prime.index has invalid format", () => {
      writeFileSync(join(TEST_DIR, "prime.index"), '{"invalid": true}');

      expect(() => manager.loadIndex(TEST_DIR)).toThrow(
        "Invalid prime.index",
      );
    });

    it("should throw if an entry is missing required fields", () => {
      const invalid: PrimeIndex = {
        primes: [{ name: "test", type: "Method", sig: "", desc: "" } as any],
      };
      writeFileSync(
        join(TEST_DIR, "prime.index"),
        JSON.stringify(invalid),
      );

      // sig and desc are empty strings which are falsy
      expect(() => manager.loadIndex(TEST_DIR)).toThrow(
        "Invalid index entry",
      );
    });
  });

  describe("loadFromData", () => {
    it("should load index from in-memory data", () => {
      manager.loadFromData(SAMPLE_INDEX);

      expect(manager.getEntries()).toHaveLength(4);
      expect(manager.getEntry("owasp-top-10")).not.toBeNull();
    });
  });

  // ─── Matching ──────────────────────────────────────────────────────────

  describe("match", () => {
    beforeEach(() => {
      manager.loadFromData(SAMPLE_INDEX);
    });

    it("should match queries by keyword in name", () => {
      const results = manager.match("tdd");

      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].name).toBe("tdd-red-green-refactor");
    });

    it("should match queries by keyword in description", () => {
      const results = manager.match("安全");

      expect(results.length).toBeGreaterThanOrEqual(1);
      const names = results.map((r) => r.name);
      expect(names).toContain("owasp-top-10");
      expect(names).toContain("security-stride");
    });

    it("should match queries by keyword in sig", () => {
      const results = manager.match("coverage");

      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].name).toBe("test-coverage-standard");
    });

    it("should return empty array for empty query", () => {
      expect(manager.match("")).toEqual([]);
      expect(manager.match("   ")).toEqual([]);
    });

    it("should return empty array for non-matching query", () => {
      expect(manager.match("quantum-physics")).toEqual([]);
    });

    it("should rank results by relevance (exact name match first)", () => {
      const results = manager.match("owasp-top-10");

      expect(results[0].name).toBe("owasp-top-10");
    });

    it("should match multiple keywords across fields", () => {
      const results = manager.match("stride security");

      expect(results[0].name).toBe("security-stride");
    });
  });

  // ─── Lookup ────────────────────────────────────────────────────────────

  describe("getEntry", () => {
    beforeEach(() => {
      manager.loadFromData(SAMPLE_INDEX);
    });

    it("should return an entry by exact name", () => {
      const entry = manager.getEntry("tdd-red-green-refactor");

      expect(entry).not.toBeNull();
      expect(entry!.type).toBe("Method");
      expect(entry!.desc).toBe("TDD红绿重构");
    });

    it("should return null for non-existent name", () => {
      expect(manager.getEntry("nonexistent")).toBeNull();
    });
  });

  // ─── System Prompt Formatting ──────────────────────────────────────────

  describe("toSystemPrompt", () => {
    it("should format index as system prompt text", () => {
      manager.loadFromData(SAMPLE_INDEX);

      const prompt = manager.toSystemPrompt();

      expect(prompt).toContain("Prime knowledge base");
      expect(prompt).toContain("prime_load");
      // Each entry should appear as "sig | desc"
      expect(prompt).toContain("tdd(task, lang)");
      expect(prompt).toContain("TDD红绿重构");
      expect(prompt).toContain("owasp()");
      expect(prompt).toContain("OWASP十大安全风险");
      // Links should appear after desc
      expect(prompt).toContain("validates: test-coverage-standard");
    });

    it("should return empty string for empty index", () => {
      expect(manager.toSystemPrompt()).toBe("");
    });

    it("should handle entries without links", () => {
      manager.loadFromData({
        primes: [
          {
            name: "test",
            type: "Knowledge",
            sig: "test() → data",
            desc: "Test prime",
          },
        ],
      });

      const prompt = manager.toSystemPrompt();
      expect(prompt).toContain("test() → data | Test prime");
      // No trailing pipe for links
      expect(prompt).not.toContain("| |");
    });
  });

  // ─── Tool Definition Generation ────────────────────────────────────────

  describe("toToolDefinitions", () => {
    beforeEach(() => {
      manager.loadFromData(SAMPLE_INDEX);
    });

    it("should include prime_load and prime_evaluate tools", () => {
      const tools = manager.toToolDefinitions();
      const names = tools.map((t) => t.name);

      expect(names).toContain("prime_load");
      expect(names).toContain("prime_evaluate");
    });

    it("should generate tools only for Method-type primes", () => {
      const tools = manager.toToolDefinitions();
      const names = tools.map((t) => t.name);

      // Method primes get tools
      expect(names).toContain("prime_tdd_red_green_refactor");
      expect(names).toContain("prime_security_stride");

      // Knowledge and Rule primes don't get tools
      expect(names).not.toContain("prime_owasp_top_10");
      expect(names).not.toContain("prime_test_coverage_standard");
    });

    it("should parse parameters from sig", () => {
      const tools = manager.toToolDefinitions();
      const tddTool = tools.find(
        (t) => t.name === "prime_tdd_red_green_refactor",
      )!;

      expect(tddTool.parameters).toHaveProperty("task");
      expect(tddTool.parameters).toHaveProperty("lang");
      expect(tddTool.parameters.task.type).toBe("string");
    });

    it("should include description with sig", () => {
      const tools = manager.toToolDefinitions();
      const strideTool = tools.find(
        (t) => t.name === "prime_security_stride",
      )!;

      expect(strideTool.description).toContain("STRIDE安全审计");
      expect(strideTool.description).toContain("stride(code)");
    });

    it("should have correct prime_load parameters", () => {
      const tools = manager.toToolDefinitions();
      const loadTool = tools.find((t) => t.name === "prime_load")!;

      expect(loadTool.parameters.name.type).toBe("string");
      expect(loadTool.parameters.level.type).toBe("integer");
      expect(loadTool.parameters.level.enum).toEqual([1, 2, 3]);
      expect(loadTool.parameters.block.type).toBe("string");
    });
  });
});
