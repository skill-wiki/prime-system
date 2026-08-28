/**
 * Tests for bundleSkill — compose selected primes into a Skill Markdown.
 */

import { describe, test, expect } from "bun:test";
import { parseLegacy as parse } from "../../parser/src/index";
import { CorpusGraph } from "../src/corpus-graph";
import { bundleSkill } from "../src/skill-bundler";

function buildGraph(sources: string[]) {
  const asts = sources.map((s, i) => {
    const { ast, errors } = parse(s, `f${i}.prime`);
    expect(errors).toHaveLength(0);
    return ast;
  });
  return new CorpusGraph(asts);
}

describe("bundleSkill", () => {
  test("bundles a single seed atom", () => {
    const g = buildGraph([
      `prime A extends Knowledge {
  name: "atom-a"
  version: "1.0.0"
  description: "Example"
  tags: ["t1", "t2"]
  facts: [{ statement: "A long enough fact statement", confidence: "consensus" }]
}`,
    ]);
    const r = bundleSkill(g, ["atom-a"]);
    expect(r.included).toEqual(["atom-a"]);
    expect(r.markdown).toContain("name: prime-bundle");
    expect(r.markdown).toContain("description:");
    expect(r.markdown).toContain("## atom-a");
    expect(r.markdown).toContain("A long enough fact statement");
  });

  test("emits Claude-Skills-compliant frontmatter", () => {
    const g = buildGraph([
      `prime A extends Knowledge {
  name: "atom-a"
  version: "1.0.0"
  tags: ["t"]
  facts: [{ statement: "a fact", confidence: "consensus" }]
}`,
    ]);
    const r = bundleSkill(g, ["atom-a"], {
      skillName: "my-skill",
      description: "Handles X when Y.",
      license: "MIT",
    });
    expect(r.markdown).toMatch(/^---\nname: my-skill\n/);
    expect(r.markdown).toContain('description: "Handles X when Y."');
    expect(r.markdown).toContain('license: "MIT"');
    // Non-spec fields go under x-prime- prefix so Skill loaders ignore them.
    expect(r.markdown).toContain("x-prime-version: 0.1.0");
    expect(r.markdown).toContain('x-prime-atoms: ["atom-a"]');
    expect(r.markdown).toContain("x-prime-count: 1");
    // Spec-breaking vestigial fields are gone.
    expect(r.markdown).not.toContain("\nversion: ");
    expect(r.markdown).not.toContain("\nprimes: [");
    expect(r.markdown).not.toContain("\nprime_count:");
  });

  test("expands requires closure into the bundle", () => {
    const g = buildGraph([
      `prime A extends Knowledge { name: "a" version: "1.0.0" requires: "b" tags: ["t"] facts: [{ statement: "a fact", confidence: "consensus" }] }`,
      `prime B extends Knowledge { name: "b" version: "1.0.0" requires: "c" tags: ["t"] facts: [{ statement: "b fact", confidence: "consensus" }] }`,
      `prime C extends Knowledge { name: "c" version: "1.0.0" tags: ["t"] facts: [{ statement: "c fact", confidence: "consensus" }] }`,
    ]);
    const r = bundleSkill(g, ["a"]);
    expect([...r.included].sort()).toEqual(["a", "b", "c"]);
    // c should come before b which comes before a (topological order)
    expect(r.included.indexOf("c")).toBeLessThan(r.included.indexOf("b"));
    expect(r.included.indexOf("b")).toBeLessThan(r.included.indexOf("a"));
  });

  test("maxPrimes caps bundle size", () => {
    const g = buildGraph([
      `prime A extends Knowledge { name: "a" version: "1.0.0" requires: "b" tags: ["t"] facts: [{ statement: "a fact", confidence: "consensus" }] }`,
      `prime B extends Knowledge { name: "b" version: "1.0.0" requires: "c" tags: ["t"] facts: [{ statement: "b fact", confidence: "consensus" }] }`,
      `prime C extends Knowledge { name: "c" version: "1.0.0" tags: ["t"] facts: [{ statement: "c fact", confidence: "consensus" }] }`,
    ]);
    const r = bundleSkill(g, ["a"], { maxPrimes: 2 });
    expect(r.included.length).toBeLessThanOrEqual(2);
  });

  test("surfaces contradicts as a Conflicts section", () => {
    const g = buildGraph([
      `prime A extends Rule { name: "a" version: "1.0.0" contradicts: "b" tags: ["t"] checks: [{ description: "x", pass_condition: "y" }] }`,
      `prime B extends Rule { name: "b" version: "1.0.0" tags: ["t"] checks: [{ description: "x", pass_condition: "y" }] }`,
    ]);
    const r = bundleSkill(g, ["a", "b"]);
    expect(r.conflicts).toEqual([["a", "b"]]);
    expect(r.markdown).toContain("## Conflicts");
    expect(r.markdown).toContain("a ↔ b");
  });

  test("renders Rule bodies as checklist items", () => {
    const g = buildGraph([
      `prime R extends Rule {
  name: "r"
  version: "1.0.0"
  description: "example rule"
  tags: ["t"]
  checks: [
    { description: "check one", pass_condition: "how to measure" }
  ]
}`,
    ]);
    const r = bundleSkill(g, ["r"]);
    expect(r.markdown).toContain("- [ ] check one");
    expect(r.markdown).toContain("how to measure");
  });

  test("enhanceHops=1 pulls in one-hop enhances neighbors", () => {
    const g = buildGraph([
      `prime A extends Knowledge { name: "a" version: "1.0.0" enhances: "b" tags: ["t"] facts: [{ statement: "a fact", confidence: "consensus" }] }`,
      `prime B extends Knowledge { name: "b" version: "1.0.0" enhances: "c" tags: ["t"] facts: [{ statement: "b fact", confidence: "consensus" }] }`,
      `prime C extends Knowledge { name: "c" version: "1.0.0" tags: ["t"] facts: [{ statement: "c fact", confidence: "consensus" }] }`,
    ]);
    // Default (hops=0) — only seed
    const r0 = bundleSkill(g, ["a"], { enhanceHops: 0 });
    expect(r0.included).toEqual(["a"]);
    // hops=1 — pulls in b but not c
    const r1 = bundleSkill(g, ["a"], { enhanceHops: 1 });
    expect(r1.included.sort()).toEqual(["a", "b"]);
    // hops=2 — pulls in c too
    const r2 = bundleSkill(g, ["a"], { enhanceHops: 2 });
    expect(r2.included.sort()).toEqual(["a", "b", "c"]);
  });

  test("enhanceHops respects maxPrimes cap", () => {
    const g = buildGraph([
      `prime A extends Knowledge { name: "a" version: "1.0.0" enhances: ["b", "c", "d"] tags: ["t"] facts: [{ statement: "a", confidence: "consensus" }] }`,
      `prime B extends Knowledge { name: "b" version: "1.0.0" tags: ["t"] facts: [{ statement: "b", confidence: "consensus" }] }`,
      `prime C extends Knowledge { name: "c" version: "1.0.0" tags: ["t"] facts: [{ statement: "c", confidence: "consensus" }] }`,
      `prime D extends Knowledge { name: "d" version: "1.0.0" tags: ["t"] facts: [{ statement: "d", confidence: "consensus" }] }`,
    ]);
    const r = bundleSkill(g, ["a"], { enhanceHops: 2, maxPrimes: 2 });
    expect(r.included.length).toBeLessThanOrEqual(2);
  });

  test("maxTokens trims the tail until the bundle fits", () => {
    const g = buildGraph([
      `prime A extends Knowledge { name: "a" version: "1.0.0" requires: "b" tags: ["t"] facts: [{ statement: "${"x ".repeat(100)}", confidence: "consensus" }] }`,
      `prime B extends Knowledge { name: "b" version: "1.0.0" requires: "c" tags: ["t"] facts: [{ statement: "${"y ".repeat(100)}", confidence: "consensus" }] }`,
      `prime C extends Knowledge { name: "c" version: "1.0.0" tags: ["t"] facts: [{ statement: "${"z ".repeat(100)}", confidence: "consensus" }] }`,
    ]);
    const unbounded = bundleSkill(g, ["a"]);
    const bounded = bundleSkill(g, ["a"], { maxTokens: 80 });
    expect(bounded.approxTokens).toBeLessThanOrEqual(unbounded.approxTokens);
    // Seed must always survive the trim.
    expect(bounded.included).toContain("a");
    // Budget is hard-capped only when a non-seed can be dropped; assert we
    // actually dropped at least one.
    expect(bounded.included.length).toBeLessThan(unbounded.included.length);
  });

  test("maxTokens never drops a seed", () => {
    // Five seed primes each with a long body; even an impossibly tight budget
    // must leave all five in because they were explicitly requested.
    const g = buildGraph([0, 1, 2, 3, 4].map(
      (i) => `prime P${i} extends Knowledge {
  name: "seed-${i}"
  version: "1.0.0"
  tags: ["t"]
  facts: [{ statement: "${"body ".repeat(80)}", confidence: "consensus" }]
}`
    ));
    const r = bundleSkill(g, ["seed-0", "seed-1", "seed-2", "seed-3", "seed-4"], {
      maxTokens: 10,
    });
    expect(r.included.sort()).toEqual(["seed-0", "seed-1", "seed-2", "seed-3", "seed-4"]);
  });

  test("emits approximate token count", () => {
    const g = buildGraph([
      `prime A extends Knowledge { name: "a" version: "1.0.0" tags: ["t"] facts: [{ statement: "a fact", confidence: "consensus" }] }`,
    ]);
    const r = bundleSkill(g, ["a"]);
    expect(r.approxTokens).toBeGreaterThan(0);
    expect(r.approxTokens).toBeLessThan(500);
  });
});
