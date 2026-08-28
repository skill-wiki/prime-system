/**
 * Tests for the L2 heuristic semantic checker.
 */

import { describe, test, expect } from "bun:test";
import { parseLegacy as parse } from "../../parser/src/index";
import { checkL2Heuristic } from "../src/checker-l2-heuristic";

function diag(source: string) {
  const { ast, errors } = parse(source);
  expect(errors).toHaveLength(0);
  return checkL2Heuristic(ast);
}

describe("L2 heuristic — Knowledge", () => {
  test("flags fact.statement duplicating description (K1)", () => {
    const d = diag(`
prime Foo extends Knowledge {
  name: "foo-bar"
  version: "1.0.0"
  description: "A meaningful description"
  tags: ["alpha", "beta"]
  facts: [
    { statement: "A meaningful description", confidence: "consensus" }
  ]
}`);
    expect(d.some((x) => x.source?.includes("K1"))).toBe(true);
  });

  test("flags too-short fact.statement (K2)", () => {
    const d = diag(`
prime Foo extends Knowledge {
  name: "foo-bar"
  version: "1.0.0"
  description: "Alpha beta gamma delta epsilon"
  tags: ["alpha", "beta"]
  facts: [
    { statement: "Too short", confidence: "consensus" }
  ]
}`);
    expect(d.some((x) => x.source?.includes("K2"))).toBe(true);
  });

  test("flags single-tag categorization (K3)", () => {
    const d = diag(`
prime Foo extends Knowledge {
  name: "foo-bar"
  version: "1.0.0"
  description: "A description long enough"
  tags: ["alpha"]
  facts: [
    { statement: "A sufficiently long, information-rich statement here", confidence: "consensus" }
  ]
}`);
    expect(d.some((x) => x.source?.includes("K3"))).toBe(true);
  });

  test("clean Knowledge produces no warnings", () => {
    const d = diag(`
prime Foo extends Knowledge {
  name: "foo-bar"
  version: "1.0.0"
  description: "A careful description of when this applies"
  tags: ["alpha", "beta", "gamma"]
  facts: [
    { statement: "A deep, specific, mechanism-level claim about the world", confidence: "consensus" }
  ]
}`);
    expect(d.filter((x) => x.level === "warn")).toHaveLength(0);
  });
});

describe("L2 heuristic — Rule", () => {
  test("flags circular check (R1)", () => {
    const d = diag(`
prime R extends Rule {
  name: "my-rule"
  version: "1.0.0"
  description: "A rule that checks something"
  tags: ["alpha", "beta"]
  checks: [
    { description: "Component must render", pass_condition: "Component must render" }
  ]
}`);
    expect(d.some((x) => x.source?.includes("R1"))).toBe(true);
  });

  test("flags vague-only pass_condition (R2)", () => {
    const d = diag(`
prime R extends Rule {
  name: "my-rule"
  version: "1.0.0"
  description: "A rule that checks something"
  tags: ["alpha", "beta"]
  checks: [
    { description: "Layout must align visually", pass_condition: "verify" }
  ]
}`);
    expect(d.some((x) => x.source?.includes("R2"))).toBe(true);
  });

  test("clean Rule produces no warnings", () => {
    const d = diag(`
prime R extends Rule {
  name: "my-rule"
  version: "1.0.0"
  description: "A rule that checks target size"
  tags: ["a11y", "touch"]
  checks: [
    { description: "Every tap target ≥ 44×44 CSS px", pass_condition: "automated bounding-box measurement, fails if any target < 44px" }
  ]
}`);
    expect(d.filter((x) => x.level === "warn")).toHaveLength(0);
  });
});

describe("L2 heuristic — Generic", () => {
  test("flags description === name (G1)", () => {
    const d = diag(`
prime Foo extends Knowledge {
  name: "foo-bar"
  version: "1.0.0"
  description: "foo-bar"
  tags: ["alpha", "beta"]
  facts: [
    { statement: "A sufficiently long, information-rich statement here", confidence: "consensus" }
  ]
}`);
    expect(d.some((x) => x.source?.includes("G1"))).toBe(true);
  });

  test("flags missing/0.0.0 version (G2)", () => {
    const d = diag(`
prime Foo extends Knowledge {
  name: "foo-bar"
  version: "0.0.0"
  description: "A description long enough"
  tags: ["alpha", "beta"]
  facts: [
    { statement: "A sufficiently long, information-rich statement here", confidence: "consensus" }
  ]
}`);
    expect(d.some((x) => x.source?.includes("G2"))).toBe(true);
  });
});
