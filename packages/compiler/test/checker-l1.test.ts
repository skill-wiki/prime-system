/**
 * Tests for Level 1 structural checker.
 */

import { describe, test, expect } from "bun:test";
import { checkL1 } from "../src/checker-l1";
import type { PrimeAST, StepNode, FieldNode, ArrayNode, StringNode, ThresholdNode } from "@skill-wiki/types";
import type { InstalledPrime } from "../src/types";

// ─── Test Helpers ──────────────────────────────────────────────────────────

const loc = (line: number) => ({ line, column: 1, offset: 0 });

function makeField(key: string, value: any): FieldNode {
  return { type: "Field", key, value, loc: value.loc || loc(1) };
}

function makeString(value: string, line = 1): StringNode {
  return { type: "String", value, loc: loc(line) };
}

function makeArray(items: any[], line = 1): ArrayNode {
  return { type: "Array", items, loc: loc(line) };
}

function makeStep(
  name: string,
  line: number,
  opts: { desc?: string; hasError?: boolean; errorValue?: string } = {}
): StepNode {
  const { desc = "do something", hasError = true, errorValue = "handle it" } = opts;
  const body: any[] = [makeString(desc, line)];
  if (hasError) {
    body.push(makeField("error", makeString(errorValue, line)));
  }
  return { type: "Step", name, body, loc: loc(line) };
}

function makeThreshold(
  metric: string,
  blockVal: number,
  warnVal: number,
  passVal: number,
  line = 1
): ThresholdNode {
  return {
    type: "Threshold",
    metric,
    levels: [
      { level: "block", operator: "<", value: blockVal, unit: "%" },
      { level: "warn", operator: "<", value: warnVal, unit: "%" },
      { level: "pass", operator: ">=", value: passVal, unit: "%" },
    ],
    loc: loc(line),
  };
}

function makeMethodAST(overrides: Partial<{
  name: string;
  version: string;
  steps: StepNode[];
  inputs: string[];
  outputs: string[];
  thresholds: ThresholdNode[];
  decorators: any[];
  extendsName: string;
  extraFields: FieldNode[];
}>): PrimeAST {
  const {
    name = "test-method",
    version = "1.0.0",
    steps = [makeStep("DO", 10)],
    inputs = ["task"],
    outputs = ["result"],
    thresholds = [],
    decorators = [],
    extendsName = "Method",
    extraFields = [],
  } = overrides;

  const body: FieldNode[] = [
    makeField("name", makeString(name, 2)),
    makeField("version", makeString(version, 3)),
    makeField(
      "input",
      makeArray(
        inputs.map((i, idx) => ({
          type: "ParameterShorthand" as const,
          name: i,
          paramType: "string",
          loc: loc(4 + idx),
        })),
        4
      )
    ),
    makeField(
      "output",
      makeArray(
        outputs.map((o, idx) => ({
          type: "ParameterShorthand" as const,
          name: o,
          paramType: "string",
          loc: loc(5 + idx),
        })),
        5
      )
    ),
    makeField("steps", makeArray(steps, 8)),
    ...extraFields,
  ];

  if (thresholds.length > 0) {
    body.push(makeField("thresholds", makeArray(thresholds, 20)));
  }

  return {
    type: "PrimeDeclaration",
    name: name.replace(/-./g, (m) => m[1].toUpperCase()).replace(/^./, (m) => m.toUpperCase()),
    extends: extendsName,
    decorators,
    body,
    loc: loc(1),
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("checker-l1", () => {
  describe("valid Method", () => {
    test("passes with no errors for a well-formed Method", () => {
      const ast = makeMethodAST({
        steps: [
          makeStep("RED", 10, { desc: "write test", hasError: true }),
          makeStep("GREEN", 12, { desc: "implement", hasError: true }),
          makeStep("REFACTOR", 14, { desc: "clean up", hasError: true }),
        ],
      });

      const diags = checkL1(ast);
      const errors = diags.filter((d) => d.level === "error");
      expect(errors).toHaveLength(0);
    });
  });

  describe("Method missing required fields", () => {
    test("reports error when steps field is missing", () => {
      const ast: PrimeAST = {
        type: "PrimeDeclaration",
        name: "BadMethod",
        extends: "Method",
        decorators: [],
        body: [
          makeField("name", makeString("bad-method", 2)),
          makeField("version", makeString("1.0.0", 3)),
          makeField("input", makeArray([{
            type: "ParameterShorthand" as const,
            name: "task",
            paramType: "string",
            loc: loc(4),
          }], 4)),
          makeField("output", makeArray([{
            type: "ParameterShorthand" as const,
            name: "result",
            paramType: "string",
            loc: loc(5),
          }], 5)),
          // No steps field!
        ],
        loc: loc(1),
      };

      const diags = checkL1(ast);
      const errors = diags.filter((d) => d.level === "error");
      expect(errors.length).toBeGreaterThanOrEqual(1);
      expect(errors.some((d) => d.message.includes("steps"))).toBe(true);
    });

    test("reports error when input is missing", () => {
      const ast: PrimeAST = {
        type: "PrimeDeclaration",
        name: "NoInput",
        extends: "Method",
        decorators: [],
        body: [
          makeField("name", makeString("no-input", 2)),
          makeField("version", makeString("1.0.0", 3)),
          makeField("output", makeArray([{
            type: "ParameterShorthand" as const,
            name: "result",
            paramType: "string",
            loc: loc(5),
          }], 5)),
          makeField("steps", makeArray([makeStep("DO", 10)], 8)),
        ],
        loc: loc(1),
      };

      const diags = checkL1(ast);
      const errors = diags.filter((d) => d.level === "error");
      expect(errors.some((d) => d.message.includes("input"))).toBe(true);
    });

    test("reports error when output is missing", () => {
      const ast: PrimeAST = {
        type: "PrimeDeclaration",
        name: "NoOutput",
        extends: "Method",
        decorators: [],
        body: [
          makeField("name", makeString("no-output", 2)),
          makeField("version", makeString("1.0.0", 3)),
          makeField("input", makeArray([{
            type: "ParameterShorthand" as const,
            name: "task",
            paramType: "string",
            loc: loc(4),
          }], 4)),
          makeField("steps", makeArray([makeStep("DO", 10)], 8)),
        ],
        loc: loc(1),
      };

      const diags = checkL1(ast);
      const errors = diags.filter((d) => d.level === "error");
      expect(errors.some((d) => d.message.includes("output"))).toBe(true);
    });
  });

  describe("Step missing error handler", () => {
    test("reports error when a step has no error handler or @safe", () => {
      const badStep = makeStep("RISKY", 10, { hasError: false });
      const ast = makeMethodAST({
        steps: [
          makeStep("SAFE", 8, { hasError: true }),
          badStep,
        ],
      });

      const diags = checkL1(ast);
      const errors = diags.filter((d) => d.level === "error");
      expect(errors.some((d) => d.message.includes("RISKY") && d.message.includes("error_handler"))).toBe(true);
    });

    test("does not report error when step has @safe", () => {
      const safeStep: StepNode = {
        type: "Step",
        name: "TRIVIAL",
        body: [
          makeString("something trivial", 10),
          makeString("@safe", 11),
        ],
        loc: loc(10),
      };
      const ast = makeMethodAST({ steps: [safeStep] });

      const diags = checkL1(ast);
      const errors = diags.filter(
        (d) => d.level === "error" && d.message.includes("TRIVIAL")
      );
      expect(errors).toHaveLength(0);
    });
  });

  describe("threshold ordering", () => {
    test("reports error when thresholds are not strictly increasing", () => {
      const ast = makeMethodAST({
        thresholds: [
          // block=80 > warn=70 → invalid (should be block < warn < pass)
          makeThreshold("coverage", 80, 70, 90, 20),
        ],
      });

      const diags = checkL1(ast);
      const errors = diags.filter(
        (d) => d.level === "error" && d.message.includes("strictly increasing")
      );
      expect(errors).toHaveLength(1);
    });

    test("passes when thresholds are strictly increasing", () => {
      const ast = makeMethodAST({
        thresholds: [
          makeThreshold("coverage", 60, 80, 90, 20),
        ],
      });

      const diags = checkL1(ast);
      const thresholdErrors = diags.filter(
        (d) => d.level === "error" && d.message.includes("strictly increasing")
      );
      expect(thresholdErrors).toHaveLength(0);
    });

    test("reports error when block equals warn", () => {
      const ast = makeMethodAST({
        thresholds: [
          makeThreshold("coverage", 80, 80, 90, 20),
        ],
      });

      const diags = checkL1(ast);
      const errors = diags.filter(
        (d) => d.level === "error" && d.message.includes("strictly increasing")
      );
      expect(errors).toHaveLength(1);
    });
  });

  describe("Knowledge required fields", () => {
    test("reports error when Knowledge has no definitions, categories, or facts", () => {
      const ast: PrimeAST = {
        type: "PrimeDeclaration",
        name: "EmptyKnowledge",
        extends: "Knowledge",
        decorators: [],
        body: [
          makeField("name", makeString("empty-knowledge", 2)),
          makeField("version", makeString("1.0.0", 3)),
        ],
        loc: loc(1),
      };

      const diags = checkL1(ast);
      const errors = diags.filter((d) => d.level === "error");
      expect(errors.some((d) => d.message.includes("Knowledge"))).toBe(true);
    });
  });

  describe("Rule required fields", () => {
    test("reports error when Rule has no checks", () => {
      const ast: PrimeAST = {
        type: "PrimeDeclaration",
        name: "EmptyRule",
        extends: "Rule",
        decorators: [],
        body: [
          makeField("name", makeString("empty-rule", 2)),
          makeField("version", makeString("1.0.0", 3)),
        ],
        loc: loc(1),
      };

      const diags = checkL1(ast);
      const errors = diags.filter((d) => d.level === "error");
      expect(errors.some((d) => d.message.includes("checks"))).toBe(true);
    });
  });

  describe("reference checking", () => {
    test("reports error when use[] references a non-existent Prime", () => {
      const ast = makeMethodAST({
        extraFields: [
          makeField("use", makeArray([
            { type: "Reference" as const, path: ["missing-prime"], loc: loc(15) },
          ], 14)),
        ],
      });

      const diags = checkL1(ast, new Map());
      const errors = diags.filter(
        (d) => d.level === "error" && d.message.includes("missing-prime")
      );
      expect(errors).toHaveLength(1);
    });

    test("passes when use[] references an installed Prime", () => {
      const installed = new Map<string, InstalledPrime>();
      installed.set("test-coverage", {
        name: "test-coverage",
        version: "1.0.0",
        type: "Rule",
      });

      const ast = makeMethodAST({
        extraFields: [
          makeField("use", makeArray([
            { type: "Reference" as const, path: ["test-coverage"], loc: loc(15) },
          ], 14)),
        ],
      });

      const diags = checkL1(ast, installed);
      const refErrors = diags.filter(
        (d) => d.level === "error" && d.message.includes("test-coverage")
      );
      expect(refErrors).toHaveLength(0);
    });
  });

  describe("@sealed not inherited", () => {
    test("reports error when extending a @sealed Prime", () => {
      const installed = new Map<string, InstalledPrime>();
      installed.set("SealedBase", {
        name: "sealed-base",
        version: "1.0.0",
        type: "Method",
        decorators: ["@sealed"],
      });

      const ast = makeMethodAST({ extendsName: "SealedBase" });
      // Override the extends to the sealed Prime
      ast.extends = "SealedBase";

      const diags = checkL1(ast, installed);
      const errors = diags.filter(
        (d) => d.level === "error" && d.message.includes("@sealed")
      );
      expect(errors).toHaveLength(1);
    });
  });

  describe("@abstract not instantiated", () => {
    test("reports error when using an @abstract Prime directly", () => {
      const installed = new Map<string, InstalledPrime>();
      installed.set("abstract-method", {
        name: "abstract-method",
        version: "1.0.0",
        type: "Method",
        decorators: ["@abstract"],
      });

      const ast = makeMethodAST({
        extraFields: [
          makeField("use", makeArray([
            { type: "Reference" as const, path: ["abstract-method"], loc: loc(15) },
          ], 14)),
        ],
      });

      const diags = checkL1(ast, installed);
      const errors = diags.filter(
        (d) => d.level === "error" && d.message.includes("@abstract")
      );
      expect(errors).toHaveLength(1);
    });
  });

  describe("inheritance depth", () => {
    test("reports error when inheritance depth exceeds 3", () => {
      const installed = new Map<string, InstalledPrime>();

      // Build a chain: Level3 -> Level2 -> Level1 -> Base (depth 4 from our AST)
      installed.set("Base", {
        name: "base",
        version: "1.0.0",
        type: "Method",
        ast: {
          type: "PrimeDeclaration",
          name: "Base",
          decorators: [],
          body: [],
          loc: loc(1),
        } as PrimeAST,
      });
      installed.set("Level1", {
        name: "level-1",
        version: "1.0.0",
        type: "Method",
        ast: {
          type: "PrimeDeclaration",
          name: "Level1",
          extends: "Base",
          decorators: [],
          body: [],
          loc: loc(1),
        } as PrimeAST,
      });
      installed.set("Level2", {
        name: "level-2",
        version: "1.0.0",
        type: "Method",
        ast: {
          type: "PrimeDeclaration",
          name: "Level2",
          extends: "Level1",
          decorators: [],
          body: [],
          loc: loc(1),
        } as PrimeAST,
      });
      installed.set("Level3", {
        name: "level-3",
        version: "1.0.0",
        type: "Method",
        ast: {
          type: "PrimeDeclaration",
          name: "Level3",
          extends: "Level2",
          decorators: [],
          body: [],
          loc: loc(1),
        } as PrimeAST,
      });

      const ast = makeMethodAST({ extendsName: "Level3" });
      ast.extends = "Level3";

      const diags = checkL1(ast, installed);
      const errors = diags.filter(
        (d) => d.level === "error" && d.message.includes("Inheritance depth")
      );
      expect(errors).toHaveLength(1);
    });
  });

  describe("name and version validation", () => {
    test("reports error for invalid identifier name", () => {
      const ast = makeMethodAST({ name: "Invalid Name!" });

      const diags = checkL1(ast);
      const errors = diags.filter(
        (d) => d.level === "error" && d.message.includes("Invalid identifier")
      );
      expect(errors).toHaveLength(1);
    });

    test("reports error for invalid semver version", () => {
      const ast = makeMethodAST({ version: "abc" });

      const diags = checkL1(ast);
      const errors = diags.filter(
        (d) => d.level === "error" && d.message.includes("semver")
      );
      expect(errors).toHaveLength(1);
    });
  });
});
