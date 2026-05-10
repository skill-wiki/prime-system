/**
 * Tests for EvaluationEngine — weighted scoring, failure criteria
 * short-circuit, confidence calculation, and policy thresholds.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { EvaluationEngine } from "../src/evaluator";
import type {
  PrimeEvaluationConfig,
  ExecutionContext,
  RuntimeCriterion,
  CriterionResult,
  ConfidencePolicy,
} from "../src/types";

// ─── Test Fixtures ─────────────────────────────────────────────────────────

/** Basic execution context for testing. */
const BASIC_CONTEXT: ExecutionContext = {
  outputs: { tests: "12 passed", implementation: "user-login.ts" },
  step_results: [
    { name: "RED", success: true, output: "Test written" },
    { name: "GREEN", success: true, output: "Implementation written" },
    { name: "REFACTOR", success: true, output: "Code refactored" },
  ],
};

/** TDD-style evaluation config matching the spec example. */
function tddEvalConfig(
  overrides?: Partial<PrimeEvaluationConfig>,
): PrimeEvaluationConfig {
  return {
    success_criteria: {
      mode: "weighted",
      min_score: 0.8,
      criteria: [
        {
          id: "tests_pass",
          description: "All tests pass",
          decidability: "decidable",
          weight: 0.3,
        },
        {
          id: "coverage_met",
          description: "Test coverage meets standard",
          decidability: "measurable",
          weight: 0.3,
        },
        {
          id: "minimal_impl",
          description: "No out-of-scope implementation",
          decidability: "decidable",
          weight: 0.2,
        },
        {
          id: "code_cleaner",
          description: "Code is cleaner than before",
          decidability: "subjective",
          weight: 0.2,
        },
      ],
    },
    failure_criteria: {
      mode: "any",
      criteria: [
        {
          id: "untested_code",
          description: "Untested functional code exists",
          decidability: "decidable",
          weight: 1.0,
        },
        {
          id: "scope_creep",
          description: "Implementation exceeds task scope",
          decidability: "subjective",
          weight: 1.0,
        },
      ],
    },
    ...overrides,
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("EvaluationEngine", () => {
  let engine: EvaluationEngine;

  // ─── Weighted Scoring ────────────────────────────────────────────────

  describe("weighted scoring", () => {
    beforeEach(() => {
      // Success criteria pass with known confidences.
      // Failure criteria do NOT trigger (passed=false for failure criteria).
      engine = new EvaluationEngine((criterion, _ctx) => {
        // Failure criteria: return passed=false meaning "bad condition not found"
        if (criterion.id === "untested_code" || criterion.id === "scope_creep") {
          return { passed: false, confidence: 1.0 };
        }
        // Success criteria: pass with decidability-based confidence
        switch (criterion.decidability) {
          case "decidable":
            return { passed: true, confidence: 1.0 };
          case "measurable":
            return { passed: true, confidence: 1.0, value: "87%" };
          case "subjective":
            return { passed: true, confidence: 0.85 };
          default:
            return { passed: true, confidence: 1.0 };
        }
      });
    });

    it("should calculate weighted score from all passing criteria", () => {
      const config = tddEvalConfig();
      const report = engine.evaluate(config, BASIC_CONTEXT);

      // tests_pass: 1.0 * 0.3 = 0.30
      // coverage_met: 1.0 * 0.3 = 0.30
      // minimal_impl: 1.0 * 0.2 = 0.20
      // code_cleaner: 0.85 * 0.2 = 0.17
      // total = 0.97
      expect(report.score).toBeCloseTo(0.97, 2);
    });

    it("should produce SUCCESS verdict when score >= min_score", () => {
      const config = tddEvalConfig();
      const report = engine.evaluate(config, BASIC_CONTEXT);

      expect(report.verdict).toBe("SUCCESS");
    });

    it("should include all criterion results in details", () => {
      const config = tddEvalConfig();
      const report = engine.evaluate(config, BASIC_CONTEXT);

      expect(report.details).toHaveLength(4);
      expect(report.details.map((d) => d.id)).toEqual([
        "tests_pass",
        "coverage_met",
        "minimal_impl",
        "code_cleaner",
      ]);
    });

    it("should handle all-fail scenario", () => {
      engine = new EvaluationEngine(() => ({
        passed: false,
        confidence: 0.0,
      }));

      const config = tddEvalConfig();
      const report = engine.evaluate(config, BASIC_CONTEXT);

      expect(report.score).toBe(0);
      expect(report.verdict).toBe("FAIL");
    });

    it("should handle mixed pass/fail scenario", () => {
      engine = new EvaluationEngine((criterion) => {
        // Only tests_pass and minimal_impl pass
        if (
          criterion.id === "tests_pass" ||
          criterion.id === "minimal_impl"
        ) {
          return { passed: true, confidence: 1.0 };
        }
        return { passed: false, confidence: 0.0 };
      });

      const config = tddEvalConfig();
      const report = engine.evaluate(config, BASIC_CONTEXT);

      // tests_pass: 1.0 * 0.3 = 0.30
      // coverage_met: 0 * 0.3 = 0
      // minimal_impl: 1.0 * 0.2 = 0.20
      // code_cleaner: 0 * 0.2 = 0
      // total = 0.50
      expect(report.score).toBeCloseTo(0.5, 2);
    });
  });

  describe("scoring modes", () => {
    beforeEach(() => {
      engine = new EvaluationEngine((criterion) => {
        if (criterion.id === "a") return { passed: true, confidence: 1.0 };
        return { passed: false, confidence: 0.0 };
      });
    });

    it("should handle 'all' mode — all must pass", () => {
      const results: CriterionResult[] = [
        {
          id: "a",
          result: "pass",
          confidence: 1.0,
          decidability: "decidable",
          weight: 0.5,
        },
        {
          id: "b",
          result: "fail",
          confidence: 0.0,
          decidability: "decidable",
          weight: 0.5,
        },
      ];

      const score = engine.calculateWeightedScore(results, "all");
      expect(score).toBe(0.0);
    });

    it("should handle 'all' mode — all pass returns 1.0", () => {
      const results: CriterionResult[] = [
        {
          id: "a",
          result: "pass",
          confidence: 1.0,
          decidability: "decidable",
          weight: 0.5,
        },
        {
          id: "b",
          result: "pass",
          confidence: 1.0,
          decidability: "decidable",
          weight: 0.5,
        },
      ];

      const score = engine.calculateWeightedScore(results, "all");
      expect(score).toBe(1.0);
    });

    it("should handle 'any' mode — one pass is enough", () => {
      const results: CriterionResult[] = [
        {
          id: "a",
          result: "pass",
          confidence: 1.0,
          decidability: "decidable",
          weight: 0.5,
        },
        {
          id: "b",
          result: "fail",
          confidence: 0.0,
          decidability: "decidable",
          weight: 0.5,
        },
      ];

      const score = engine.calculateWeightedScore(results, "any");
      expect(score).toBe(1.0);
    });

    it("should handle 'any' mode — none pass returns 0.0", () => {
      const results: CriterionResult[] = [
        {
          id: "a",
          result: "fail",
          confidence: 0.0,
          decidability: "decidable",
          weight: 0.5,
        },
        {
          id: "b",
          result: "fail",
          confidence: 0.0,
          decidability: "decidable",
          weight: 0.5,
        },
      ];

      const score = engine.calculateWeightedScore(results, "any");
      expect(score).toBe(0.0);
    });

    it("should return 0 for empty results", () => {
      expect(engine.calculateWeightedScore([], "weighted")).toBe(0);
      expect(engine.calculateWeightedScore([], "all")).toBe(0);
      expect(engine.calculateWeightedScore([], "any")).toBe(0);
    });
  });

  // ─── Failure Criteria Short-Circuit ──────────────────────────────────

  describe("failure criteria short-circuit", () => {
    it("should return FAIL verdict when any failure criterion triggers", () => {
      // untested_code triggers (passed=true means the bad condition is found)
      engine = new EvaluationEngine((criterion) => {
        if (criterion.id === "untested_code") {
          return { passed: true, confidence: 1.0 };
        }
        return { passed: false, confidence: 1.0 };
      });

      const config = tddEvalConfig();
      const report = engine.evaluate(config, BASIC_CONTEXT);

      expect(report.verdict).toBe("FAIL");
      expect(report.score).toBe(0);
    });

    it("should not run success criteria when failure triggers", () => {
      engine = new EvaluationEngine((criterion) => {
        if (criterion.id === "scope_creep") {
          return { passed: true, confidence: 0.88 };
        }
        return { passed: false, confidence: 1.0 };
      });

      const config = tddEvalConfig();
      const report = engine.evaluate(config, BASIC_CONTEXT);

      expect(report.verdict).toBe("FAIL");
      // Success criteria details should be empty (not evaluated)
      expect(report.details).toHaveLength(0);
    });

    it("should include failure check results in the report", () => {
      engine = new EvaluationEngine((criterion) => {
        if (criterion.id === "untested_code") {
          return { passed: true, confidence: 1.0 };
        }
        return { passed: false, confidence: 0.88 };
      });

      const config = tddEvalConfig();
      const report = engine.evaluate(config, BASIC_CONTEXT);

      expect(report.failure_checks).toBeDefined();
      expect(report.failure_checks!.length).toBe(2);

      const untestedCheck = report.failure_checks!.find(
        (c) => c.id === "untested_code",
      )!;
      expect(untestedCheck.result).toBe("fail"); // "fail" in the report means triggered
    });

    it("should not short-circuit when no failure criteria trigger", () => {
      engine = new EvaluationEngine((criterion) => {
        // No failure criteria trigger (passed=false for failure criteria)
        if (
          criterion.id === "untested_code" ||
          criterion.id === "scope_creep"
        ) {
          return { passed: false, confidence: 1.0 };
        }
        return { passed: true, confidence: 1.0 };
      });

      const config = tddEvalConfig();
      const report = engine.evaluate(config, BASIC_CONTEXT);

      expect(report.verdict).not.toBe("FAIL");
      expect(report.details.length).toBeGreaterThan(0);
    });

    it("should handle config without failure criteria", () => {
      engine = new EvaluationEngine(() => ({
        passed: true,
        confidence: 1.0,
      }));

      const config = tddEvalConfig({ failure_criteria: undefined });
      const report = engine.evaluate(config, BASIC_CONTEXT);

      expect(report.verdict).toBe("SUCCESS");
      expect(report.failure_checks).toBeUndefined();
    });
  });

  // ─── Confidence Calculation ──────────────────────────────────────────

  describe("confidence calculation", () => {
    it("should calculate weighted confidence from criterion confidences", () => {
      engine = new EvaluationEngine((criterion) => {
        switch (criterion.id) {
          case "tests_pass":
            return { passed: true, confidence: 1.0 };
          case "coverage_met":
            return { passed: true, confidence: 1.0, value: "87%" };
          case "minimal_impl":
            return { passed: true, confidence: 1.0 };
          case "code_cleaner":
            return { passed: true, confidence: 0.85 };
          default:
            return { passed: false, confidence: 1.0 };
        }
      });

      const config = tddEvalConfig();
      const report = engine.evaluate(config, BASIC_CONTEXT);

      // Confidence:
      // tests_pass: 1.0 * 0.3 = 0.30
      // coverage_met: 1.0 * 0.3 = 0.30
      // minimal_impl: 1.0 * 0.2 = 0.20
      // code_cleaner: 0.85 * 0.2 = 0.17
      // total = 0.97
      expect(report.confidence).toBeCloseTo(0.97, 2);
    });

    it("should return 1.0 confidence when all criteria are decidable and pass", () => {
      engine = new EvaluationEngine(() => ({
        passed: true,
        confidence: 1.0,
      }));

      const config: PrimeEvaluationConfig = {
        success_criteria: {
          mode: "weighted",
          min_score: 0.8,
          criteria: [
            {
              id: "a",
              description: "A",
              decidability: "decidable",
              weight: 0.5,
            },
            {
              id: "b",
              description: "B",
              decidability: "decidable",
              weight: 0.5,
            },
          ],
        },
      };

      const report = engine.evaluate(config, BASIC_CONTEXT);
      expect(report.confidence).toBe(1.0);
    });

    it("should lower confidence when subjective criteria are present", () => {
      engine = new EvaluationEngine((criterion) => {
        if (criterion.decidability === "subjective") {
          return { passed: true, confidence: 0.75 };
        }
        return { passed: true, confidence: 1.0 };
      });

      const config: PrimeEvaluationConfig = {
        success_criteria: {
          mode: "weighted",
          min_score: 0.8,
          criteria: [
            {
              id: "a",
              description: "A",
              decidability: "decidable",
              weight: 0.5,
            },
            {
              id: "b",
              description: "B",
              decidability: "subjective",
              weight: 0.5,
            },
          ],
        },
      };

      const report = engine.evaluate(config, BASIC_CONTEXT);

      // (1.0 * 0.5 + 0.75 * 0.5) / 1.0 = 0.875
      expect(report.confidence).toBeCloseTo(0.875, 3);
      expect(report.confidence).toBeLessThan(1.0);
    });

    it("should return 0 confidence for empty results", () => {
      const confidence = engine.calculateConfidence([]);
      expect(confidence).toBe(0);
    });

    it("should compute directly with calculateConfidence", () => {
      engine = new EvaluationEngine();
      const results: CriterionResult[] = [
        {
          id: "x",
          result: "pass",
          confidence: 0.9,
          decidability: "measurable",
          weight: 0.6,
        },
        {
          id: "y",
          result: "pass",
          confidence: 0.8,
          decidability: "subjective",
          weight: 0.4,
        },
      ];

      const confidence = engine.calculateConfidence(results);
      // (0.9 * 0.6 + 0.8 * 0.4) / (0.6 + 0.4) = (0.54 + 0.32) / 1.0 = 0.86
      expect(confidence).toBeCloseTo(0.86, 3);
    });
  });

  // ─── Confidence Policy ───────────────────────────────────────────────

  describe("confidence policy thresholds", () => {
    beforeEach(() => {
      engine = new EvaluationEngine();
    });

    it("should auto_approve when confidence >= 0.95", () => {
      const action = engine.applyPolicy(0.95);
      expect(action).toBe("auto_approve");

      const action2 = engine.applyPolicy(1.0);
      expect(action2).toBe("auto_approve");
    });

    it("should require human_review when 0.80 <= confidence < 0.95", () => {
      const action = engine.applyPolicy(0.80);
      expect(action).toBe("human_review");

      const action2 = engine.applyPolicy(0.94);
      expect(action2).toBe("human_review");
    });

    it("should require human_review when 0.50 <= confidence < 0.80", () => {
      const action = engine.applyPolicy(0.50);
      expect(action).toBe("human_review");

      const action2 = engine.applyPolicy(0.79);
      expect(action2).toBe("human_review");
    });

    it("should auto_reject when confidence < 0.50", () => {
      const action = engine.applyPolicy(0.49);
      expect(action).toBe("auto_reject");

      const action2 = engine.applyPolicy(0.0);
      expect(action2).toBe("auto_reject");
    });

    it("should respect custom policy thresholds", () => {
      const customPolicy: ConfidencePolicy = {
        auto_approve: 0.99,
        human_review: 0.90,
        auto_reject: 0.60,
      };

      expect(engine.applyPolicy(0.99, customPolicy)).toBe("auto_approve");
      expect(engine.applyPolicy(0.95, customPolicy)).toBe("human_review");
      expect(engine.applyPolicy(0.85, customPolicy)).toBe("human_review");
      expect(engine.applyPolicy(0.50, customPolicy)).toBe("auto_reject");
    });

    it("should mark subjective criteria for human review in report", () => {
      engine = new EvaluationEngine((criterion) => {
        // Failure criteria: not triggered
        if (criterion.id === "untested_code" || criterion.id === "scope_creep") {
          return { passed: false, confidence: 1.0 };
        }
        if (criterion.decidability === "subjective") {
          return { passed: true, confidence: 0.85 };
        }
        return { passed: true, confidence: 1.0 };
      });

      const config = tddEvalConfig();
      const report = engine.evaluate(config, BASIC_CONTEXT);

      expect(report.human_review_needed).toContain("code_cleaner");
    });

    it("should not flag decidable criteria for human review", () => {
      engine = new EvaluationEngine(() => ({
        passed: true,
        confidence: 1.0,
      }));

      const config: PrimeEvaluationConfig = {
        success_criteria: {
          mode: "weighted",
          criteria: [
            {
              id: "a",
              description: "A",
              decidability: "decidable",
              weight: 1.0,
            },
          ],
        },
      };

      const report = engine.evaluate(config, BASIC_CONTEXT);
      expect(report.human_review_needed).toHaveLength(0);
    });
  });

  // ─── Verdict Determination ───────────────────────────────────────────

  describe("verdict determination", () => {
    beforeEach(() => {
      engine = new EvaluationEngine();
    });

    it("should return SUCCESS when score >= min_score and confidence >= auto_approve", () => {
      const verdict = engine.determineVerdict(0.95, 0.97, 0.8, {
        auto_approve: 0.95,
        human_review: 0.80,
        auto_reject: 0.50,
      });

      expect(verdict).toBe("SUCCESS");
    });

    it("should return FAIL when score < min_score", () => {
      const verdict = engine.determineVerdict(0.5, 1.0, 0.8, {
        auto_approve: 0.95,
        human_review: 0.80,
        auto_reject: 0.50,
      });

      expect(verdict).toBe("FAIL");
    });

    it("should return SUCCESS when score meets min but confidence in review range", () => {
      const verdict = engine.determineVerdict(0.9, 0.85, 0.8, {
        auto_approve: 0.95,
        human_review: 0.80,
        auto_reject: 0.50,
      });

      expect(verdict).toBe("SUCCESS");
    });

    it("should return PARTIAL when confidence below human_review threshold", () => {
      const verdict = engine.determineVerdict(0.9, 0.6, 0.8, {
        auto_approve: 0.95,
        human_review: 0.80,
        auto_reject: 0.50,
      });

      expect(verdict).toBe("PARTIAL");
    });

    it("should return FAIL when confidence below auto_reject", () => {
      const verdict = engine.determineVerdict(0.9, 0.3, 0.8, {
        auto_approve: 0.95,
        human_review: 0.80,
        auto_reject: 0.50,
      });

      expect(verdict).toBe("FAIL");
    });
  });

  // ─── Report Structure ───────────────────────────────────────────────

  describe("report structure", () => {
    it("should produce a complete report matching spec format", () => {
      engine = new EvaluationEngine((criterion) => {
        // Failure criteria: not triggered
        if (criterion.id === "untested_code" || criterion.id === "scope_creep") {
          return { passed: false, confidence: 1.0 };
        }
        if (criterion.decidability === "subjective") {
          return { passed: true, confidence: 0.85 };
        }
        if (criterion.decidability === "measurable") {
          return { passed: true, confidence: 1.0, value: "87%" };
        }
        return { passed: true, confidence: 1.0 };
      });

      const config = tddEvalConfig();
      const report = engine.evaluate(config, BASIC_CONTEXT);

      // Verify structure
      expect(report).toHaveProperty("verdict");
      expect(report).toHaveProperty("score");
      expect(report).toHaveProperty("confidence");
      expect(report).toHaveProperty("details");
      expect(report).toHaveProperty("human_review_needed");

      // Verify types
      expect(typeof report.verdict).toBe("string");
      expect(typeof report.score).toBe("number");
      expect(typeof report.confidence).toBe("number");
      expect(Array.isArray(report.details)).toBe(true);
      expect(Array.isArray(report.human_review_needed)).toBe(true);

      // Verify score is between 0 and 1
      expect(report.score).toBeGreaterThanOrEqual(0);
      expect(report.score).toBeLessThanOrEqual(1);
      expect(report.confidence).toBeGreaterThanOrEqual(0);
      expect(report.confidence).toBeLessThanOrEqual(1);

      // Verify each detail has required fields
      for (const detail of report.details) {
        expect(detail).toHaveProperty("id");
        expect(detail).toHaveProperty("result");
        expect(detail).toHaveProperty("confidence");
        expect(detail).toHaveProperty("decidability");
        expect(detail).toHaveProperty("weight");
      }

      // Verify measurable criterion has value
      const coverageDetail = report.details.find(
        (d) => d.id === "coverage_met",
      )!;
      expect(coverageDetail.value).toBe("87%");

      // Verify subjective criterion has note
      const subjectiveDetail = report.details.find(
        (d) => d.id === "code_cleaner",
      )!;
      expect(subjectiveDetail.note).toBeDefined();
    });
  });
});
