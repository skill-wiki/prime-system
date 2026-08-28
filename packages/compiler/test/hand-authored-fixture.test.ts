/**
 * Sanity test against a hand-written .prime fixture.
 *
 * This guards against a subtle failure mode: human-authored .prime files that
 * exercise richer language features (nested source objects, thresholds,
 * exemptions, enhances/contradicts pairs) should still parse and pass L1
 * cleanly, and their link declarations should survive in every syntactic shape.
 *
 * The L2-heuristic assertion was removed with its subject (W7-A deleted
 * `checker-l2-heuristic.ts`, which had zero production consumers).
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { parseLegacy as parse } from "../../parser/src/index";
import { checkL1 } from "../src";

const FIXTURE = join(import.meta.dir, "../fixtures/hand-authored/focus-ring-mandate.prime");

describe("hand-authored .prime fixture", () => {
  const source = readFileSync(FIXTURE, "utf-8");
  const { ast, errors } = parse(source, "focus-ring-mandate.prime");

  test("parses without syntax errors", () => {
    expect(errors).toEqual([]);
  });

  test("passes L1 structural checks", () => {
    const l1Errors = checkL1(ast).filter((d) => d.level === "error");
    expect(l1Errors).toEqual([]);
  });

  test("preserves nested objects (source), arrays of objects (checks), thresholds, exemptions", () => {
    const keys = ast.body.map((f) => f.key);
    expect(keys).toContain("source");
    expect(keys).toContain("checks");
    expect(keys).toContain("thresholds");
    expect(keys).toContain("exemptions");
  });

  test("preserves link declarations in multiple syntactic shapes", () => {
    const keys = ast.body.map((f) => f.key);
    expect(keys).toContain("requires");      // scalar field
    expect(keys).toContain("enhances");      // array-of-strings
    expect(keys).toContain("contradicts");   // scalar field
  });
});
