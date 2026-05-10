/**
 * Sanity test against a hand-written .prime fixture.
 *
 * The 2955-atom migrated corpus is produced by scripts/yaml-to-prime.ts
 * and therefore has a predictable shape (simple facts:[{...}] or
 * checks:[{...}]) that the L2 heuristic was calibrated against.
 *
 * This test guards against a subtle failure mode: human-authored .prime
 * files that exercise richer language features (nested source objects,
 * thresholds, exemptions, enhances/contradicts pairs) should still pass
 * L1 and L2 cleanly. If they don't, the heuristic's false-positive rate
 * on real-world authored content is higher than we think.
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { parse } from "../../parser/src/index";
import { checkL1, checkL2Heuristic } from "../src";

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

  test("does not trip any L2 heuristic warning", () => {
    const l2 = checkL2Heuristic(ast);
    const warns = l2.filter((d) => d.level === "warn");
    if (warns.length > 0) {
      console.warn("L2 heuristic warns (unexpected):", warns.map((w) => w.message));
    }
    expect(warns).toEqual([]);
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
