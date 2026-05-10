/**
 * Tests that L2 LLM prompts dispatch correctly on ast.extends and include
 * type-specific checks in their text.
 */

import { describe, test, expect } from "bun:test";
import { parse } from "../../parser/src/index";
import { buildL2Prompt } from "../src/checker-l2";

function promptFor(source: string): string {
  const { ast, errors } = parse(source);
  expect(errors).toHaveLength(0);
  return buildL2Prompt(ast);
}

describe("L2 prompt dispatch", () => {
  test("Knowledge prime gets Knowledge-specific prompt", () => {
    const p = promptFor(`
prime K extends Knowledge {
  name: "k"
  version: "1.0.0"
  facts: [{ statement: "A claim", confidence: "consensus" }]
}`);
    expect(p).toContain("Confidence calibration");
    expect(p).toContain("Definition sharpness");
    expect(p).not.toContain("Step logic consistency");
    expect(p).not.toContain("Branch coverage");
  });

  test("Rule prime gets Rule-specific prompt", () => {
    const p = promptFor(`
prime R extends Rule {
  name: "r"
  version: "1.0.0"
  checks: [{ description: "X", pass_condition: "Y" }]
}`);
    expect(p).toContain("Decidability");
    expect(p).toContain("Non-circularity");
    expect(p).toContain("Threshold sanity");
    expect(p).not.toContain("Step logic consistency");
  });

  test("Method prime gets Method-specific prompt (default)", () => {
    const p = promptFor(`
prime M extends Method {
  name: "m"
  version: "1.0.0"
  input: {}
  output: {}
  steps: []
}`);
    expect(p).toContain("Step logic consistency");
    expect(p).toContain("Branch coverage");
    expect(p).toContain("Unreachable outputs");
    expect(p).not.toContain("Confidence calibration");
    expect(p).not.toContain("Decidability");
  });

  test("all prompts include the strict JSON response spec", () => {
    for (const extendsCls of ["Knowledge", "Rule", "Method"]) {
      const body = extendsCls === "Knowledge"
        ? `facts: [{ statement: "x", confidence: "consensus" }]`
        : extendsCls === "Rule"
          ? `checks: [{ description: "x", pass_condition: "y" }]`
          : `input: {} output: {} steps: []`;
      const p = promptFor(`
prime P extends ${extendsCls} {
  name: "p"
  version: "1.0.0"
  ${body}
}`);
      expect(p).toContain("Respond with ONLY a JSON array");
      expect(p).toContain('{"level":"error"|"warn"|"suggestion"');
      expect(p).toContain("If no issues found, respond with exactly: []");
    }
  });
});
