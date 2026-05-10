/**
 * Tests for the corpus-wide graph API.
 */

import { describe, test, expect } from "bun:test";
import { parse } from "../../parser/src/index";
import { CorpusGraph } from "../src/corpus-graph";

function buildGraph(sources: string[]) {
  const asts = sources.map((s, i) => {
    const { ast, errors } = parse(s, `f${i}.prime`);
    expect(errors).toHaveLength(0);
    return ast;
  });
  return new CorpusGraph(asts);
}

describe("CorpusGraph — construction", () => {
  test("indexes atoms by name", () => {
    const g = buildGraph([
      `prime A extends Knowledge {
  name: "alpha"
  version: "1.0.0"
  tags: ["a"]
  facts: [{ statement: "long enough statement", confidence: "consensus" }]
}`,
      `prime B extends Knowledge {
  name: "beta"
  version: "1.0.0"
  tags: ["b"]
  facts: [{ statement: "long enough statement", confidence: "consensus" }]
}`,
    ]);
    expect(g.atoms().sort()).toEqual(["alpha", "beta"]);
    expect(g.get("alpha")?.extends).toBe("Knowledge");
  });

  test("handles empty corpus", () => {
    const g = new CorpusGraph([]);
    expect(g.atoms()).toHaveLength(0);
    expect(g.stats().edges).toBe(0);
  });
});

describe("CorpusGraph — edges", () => {
  test("extracts field-style requires edges", () => {
    const g = buildGraph([
      `prime A extends Knowledge {
  name: "alpha"
  version: "1.0.0"
  requires: "beta"
  tags: ["a"]
  facts: [{ statement: "long enough statement", confidence: "consensus" }]
}`,
      `prime B extends Knowledge {
  name: "beta"
  version: "1.0.0"
  tags: ["b"]
  facts: [{ statement: "long enough statement", confidence: "consensus" }]
}`,
    ]);
    const edges = g.outgoing("alpha", "requires");
    expect(edges).toHaveLength(1);
    expect(edges[0].to).toBe("beta");
  });

  test("extracts array-style requires edges", () => {
    const g = buildGraph([
      `prime A extends Knowledge {
  name: "alpha"
  version: "1.0.0"
  requires: ["beta", "gamma"]
  tags: ["a"]
  facts: [{ statement: "long enough statement", confidence: "consensus" }]
}`,
      `prime B extends Knowledge {
  name: "beta"
  version: "1.0.0"
  tags: ["b"]
  facts: [{ statement: "long enough statement", confidence: "consensus" }]
}`,
      `prime C extends Knowledge {
  name: "gamma"
  version: "1.0.0"
  tags: ["c"]
  facts: [{ statement: "long enough statement", confidence: "consensus" }]
}`,
    ]);
    expect(g.outgoing("alpha", "requires").map((e) => e.to).sort()).toEqual(["beta", "gamma"]);
  });

  test("ignores dangling edges by default", () => {
    const g = buildGraph([
      `prime A extends Knowledge {
  name: "alpha"
  version: "1.0.0"
  requires: "missing"
  tags: ["a"]
  facts: [{ statement: "long enough statement", confidence: "consensus" }]
}`,
    ]);
    expect(g.outgoing("alpha", "requires")).toHaveLength(0);
    expect(g.stats().danglingEdges).toBe(1);
  });
});

describe("CorpusGraph — closure", () => {
  test("computes transitive requires closure", () => {
    const g = buildGraph([
      `prime A extends Knowledge { name: "a" version: "1.0.0" requires: "b" tags: ["x"] facts: [{ statement: "long enough", confidence: "consensus" }] }`,
      `prime B extends Knowledge { name: "b" version: "1.0.0" requires: "c" tags: ["x"] facts: [{ statement: "long enough", confidence: "consensus" }] }`,
      `prime C extends Knowledge { name: "c" version: "1.0.0" tags: ["x"] facts: [{ statement: "long enough", confidence: "consensus" }] }`,
    ]);
    expect(g.closure("a", ["requires"]).sort()).toEqual(["b", "c"]);
  });

  test("respects verb filter", () => {
    const g = buildGraph([
      `prime A extends Knowledge { name: "a" version: "1.0.0" requires: "b" enhances: "c" tags: ["x"] facts: [{ statement: "long enough", confidence: "consensus" }] }`,
      `prime B extends Knowledge { name: "b" version: "1.0.0" tags: ["x"] facts: [{ statement: "long enough", confidence: "consensus" }] }`,
      `prime C extends Knowledge { name: "c" version: "1.0.0" tags: ["x"] facts: [{ statement: "long enough", confidence: "consensus" }] }`,
    ]);
    expect(g.closure("a", ["requires"])).toEqual(["b"]);
    expect(g.closure("a", ["enhances"])).toEqual(["c"]);
  });
});

describe("CorpusGraph — contradicts", () => {
  test("detects contradicts in either direction", () => {
    const g = buildGraph([
      `prime A extends Rule { name: "a" version: "1.0.0" contradicts: "b" tags: ["x"] checks: [{ description: "x", pass_condition: "y" }] }`,
      `prime B extends Rule { name: "b" version: "1.0.0" tags: ["x"] checks: [{ description: "x", pass_condition: "y" }] }`,
    ]);
    expect(g.contradicts("a", "b")).toBe(true);
    expect(g.contradicts("b", "a")).toBe(true);
  });

  test("violations flags conflicting pairs in a selection", () => {
    const g = buildGraph([
      `prime A extends Rule { name: "a" version: "1.0.0" contradicts: "b" tags: ["x"] checks: [{ description: "x", pass_condition: "y" }] }`,
      `prime B extends Rule { name: "b" version: "1.0.0" tags: ["x"] checks: [{ description: "x", pass_condition: "y" }] }`,
      `prime C extends Rule { name: "c" version: "1.0.0" tags: ["x"] checks: [{ description: "x", pass_condition: "y" }] }`,
    ]);
    expect(g.violations(["a", "b", "c"])).toEqual([["a", "b"]]);
    expect(g.violations(["a", "c"])).toEqual([]);
  });
});

describe("CorpusGraph — topology", () => {
  test("topologicalOrder respects requires", () => {
    const g = buildGraph([
      `prime A extends Knowledge { name: "a" version: "1.0.0" requires: "b" tags: ["x"] facts: [{ statement: "long enough", confidence: "consensus" }] }`,
      `prime B extends Knowledge { name: "b" version: "1.0.0" requires: "c" tags: ["x"] facts: [{ statement: "long enough", confidence: "consensus" }] }`,
      `prime C extends Knowledge { name: "c" version: "1.0.0" tags: ["x"] facts: [{ statement: "long enough", confidence: "consensus" }] }`,
    ]);
    const order = g.topologicalOrder();
    expect(order.indexOf("c")).toBeLessThan(order.indexOf("b"));
    expect(order.indexOf("b")).toBeLessThan(order.indexOf("a"));
  });

  test("topologicalOrder throws on cycles", () => {
    const g = buildGraph([
      `prime A extends Knowledge { name: "a" version: "1.0.0" requires: "b" tags: ["x"] facts: [{ statement: "long enough", confidence: "consensus" }] }`,
      `prime B extends Knowledge { name: "b" version: "1.0.0" requires: "a" tags: ["x"] facts: [{ statement: "long enough", confidence: "consensus" }] }`,
    ]);
    expect(() => g.topologicalOrder()).toThrow(/cycle in requires/);
  });

  test("detectRequiresCycles returns each cycle without throwing", () => {
    const g = buildGraph([
      `prime A extends Knowledge { name: "a" version: "1.0.0" requires: "b" tags: ["x"] facts: [{ statement: "long enough", confidence: "consensus" }] }`,
      `prime B extends Knowledge { name: "b" version: "1.0.0" requires: "a" tags: ["x"] facts: [{ statement: "long enough", confidence: "consensus" }] }`,
    ]);
    const cycles = g.detectRequiresCycles();
    expect(cycles.length).toBeGreaterThanOrEqual(1);
  });
});
