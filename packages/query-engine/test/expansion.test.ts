import { describe, expect, test } from "bun:test";
import type { RelationDefinition } from "@aoe/model-schema";
import {
  admit,
  buildAdjacency,
  expandSelection,
  findExclusions,
  orderByLoadOrder,
} from "../src/index.ts";
import { anyPrincipal, corpusA } from "./support/harness.ts";
import { domainA, edge, graph, str, unit } from "./support/model.ts";

/**
 * Expansion always runs on the admitted graph in the real pipeline, so the unit
 * tests use the admitted graph too — otherwise they would assert behaviour over
 * units the engine never sees.
 */
const adjacency = () =>
  buildAdjacency(
    admit(corpusA(), {
      requestId: "r",
      profile: domainA.profile.name,
      principal: anyPrincipal,
      maxTokens: 1000,
    }).graph,
  );

function semantics(overrides: Partial<RelationDefinition["semantics"]>): RelationDefinition["semantics"] {
  return {
    traversal: "one-hop",
    selection: "expand",
    loadOrder: "none",
    cyclePolicy: "allow",
    conflictSeverity: "none",
    ...overrides,
  };
}

function relation(name: string, overrides: Partial<RelationDefinition["semantics"]>, directional = true): RelationDefinition {
  return {
    kind: "relation",
    name,
    version: "1.0.0",
    from: "A",
    to: "A",
    cardinality: "many-to-many",
    directional,
    semantics: semantics(overrides),
  };
}

describe("expansion driven by relation semantics", () => {
  test("a closure over a transitive relation pulls the whole chain", () => {
    const result = expandSelection(["I1"], adjacency(), domainA.relations, 8);
    expect(result.discovered).toEqual(["I3", "I5"]);
    const blocked = result.expansions.find(e => e.relationRef === "blocked-by" && e.from === "I1");
    expect(blocked?.discovered).toEqual(["I3", "I5"]);
    expect(blocked?.depth).toBe(2);
  });

  test("traversal 'none' overrides selection 'expand', so the relation is inert", () => {
    // `superseded-by` declares selection 'expand' with traversal 'none'.
    const result = expandSelection(["I1"], adjacency(), domainA.relations, 8);
    expect(result.expansions.some(e => e.relationRef === "superseded-by")).toBe(false);
    expect(result.discovered).not.toContain("I2");
  });

  test("an informational relation neither pulls in nor prohibits", () => {
    const result = expandSelection(["I1"], adjacency(), domainA.relations, 8);
    expect(result.expansions.some(e => e.relationRef === "mentioned-in")).toBe(false);
    expect(result.discovered).not.toContain("N1");
  });

  test("selection 'expand' stops at one level even when traversal is transitive", () => {
    const relations = { chain: relation("chain", { traversal: "transitive", selection: "expand" }) };
    const corpus = graph(
      [
        unit({ id: "a", typeRef: "A", fields: { n: str("a") } }),
        unit({ id: "b", typeRef: "A", fields: { n: str("b") } }),
        unit({ id: "c", typeRef: "A", fields: { n: str("c") } }),
      ],
      [edge("chain", "a", "b"), edge("chain", "b", "c")],
    );
    const result = expandSelection(["a"], buildAdjacency(corpus), relations, 8);
    expect(result.discovered).toEqual(["b"]);
  });

  test("cyclePolicy 'reject' produces an error diagnostic and still terminates", () => {
    const relations = {
      loop: relation("loop", { traversal: "transitive", selection: "closure", cyclePolicy: "reject" }),
    };
    const corpus = graph(
      [
        unit({ id: "a", typeRef: "A", fields: { n: str("a") } }),
        unit({ id: "b", typeRef: "A", fields: { n: str("b") } }),
      ],
      [edge("loop", "a", "b"), edge("loop", "b", "a")],
    );
    const result = expandSelection(["a"], buildAdjacency(corpus), relations, 8);
    expect(result.diagnostics.map(d => d.code)).toContain("RELATION_CYCLE_REJECTED");
    expect(result.diagnostics.find(d => d.code === "RELATION_CYCLE_REJECTED")?.severity).toBe("error");
  });

  test("cyclePolicy 'collapse' terminates silently", () => {
    const relations = {
      loop: relation("loop", { traversal: "transitive", selection: "closure", cyclePolicy: "collapse" }),
    };
    const corpus = graph(
      [
        unit({ id: "a", typeRef: "A", fields: { n: str("a") } }),
        unit({ id: "b", typeRef: "A", fields: { n: str("b") } }),
      ],
      [edge("loop", "a", "b"), edge("loop", "b", "a")],
    );
    const result = expandSelection(["a"], buildAdjacency(corpus), relations, 8);
    expect(result.diagnostics).toEqual([]);
    expect(result.discovered).toEqual(["b"]);
  });

  test("a non-directional relation is walked in both directions", () => {
    const relations = { peer: relation("peer", { selection: "expand" }, false) };
    const corpus = graph(
      [
        unit({ id: "a", typeRef: "A", fields: { n: str("a") } }),
        unit({ id: "b", typeRef: "A", fields: { n: str("b") } }),
      ],
      [edge("peer", "a", "b")],
    );
    expect(expandSelection(["b"], buildAdjacency(corpus), relations, 8).discovered).toEqual(["a"]);
  });

  test("a directional relation is not walked backwards", () => {
    const relations = { flows: relation("flows", { selection: "expand" }, true) };
    const corpus = graph(
      [
        unit({ id: "a", typeRef: "A", fields: { n: str("a") } }),
        unit({ id: "b", typeRef: "A", fields: { n: str("b") } }),
      ],
      [edge("flows", "a", "b")],
    );
    expect(expandSelection(["b"], buildAdjacency(corpus), relations, 8).discovered).toEqual([]);
  });

  test("an undeclared relation reference is reported and ignored", () => {
    const result = expandSelection(["I1"], adjacency(), { "blocked-by": domainA.relations["blocked-by"]! }, 8);
    expect(result.diagnostics.map(d => d.code)).toContain("RELATION_NOT_DECLARED");
  });
});

describe("exclusion", () => {
  test("an exclude relation between two present units is a conflict pair", () => {
    const pairs = findExclusions(["I1", "I4"], adjacency(), domainA.relations);
    expect(pairs).toEqual([{ relationRef: "duplicate-of", a: "I1", b: "I4", severity: "error" }]);
  });

  test("no pair when only one side is present", () => {
    expect(findExclusions(["I1"], adjacency(), domainA.relations)).toEqual([]);
  });

  test("the declared conflictSeverity is carried through, not assumed", () => {
    const relations = { swap: relation("swap", { selection: "exclude", conflictSeverity: "warning" }, false) };
    const corpus = graph(
      [
        unit({ id: "a", typeRef: "A", fields: { n: str("a") } }),
        unit({ id: "b", typeRef: "A", fields: { n: str("b") } }),
      ],
      [edge("swap", "a", "b")],
    );
    expect(findExclusions(["a", "b"], buildAdjacency(corpus), relations)[0]!.severity).toBe("warning");
  });

  test("traversal 'none' disables an exclude relation too", () => {
    const relations = { dead: relation("dead", { selection: "exclude", traversal: "none" }) };
    const corpus = graph(
      [
        unit({ id: "a", typeRef: "A", fields: { n: str("a") } }),
        unit({ id: "b", typeRef: "A", fields: { n: str("b") } }),
      ],
      [edge("dead", "a", "b")],
    );
    expect(findExclusions(["a", "b"], buildAdjacency(corpus), relations)).toEqual([]);
  });
});

describe("load order", () => {
  test("a loadOrder 'before' constraint outranks the score order", () => {
    const result = orderByLoadOrder(["high", "low"], [{ earlier: "low", later: "high", relationRef: "r" }]);
    expect(result.ordered).toEqual(["low", "high"]);
    expect(result.diagnostics).toEqual([]);
  });

  test("units free to load keep score order", () => {
    const result = orderByLoadOrder(["a", "b", "c"], []);
    expect(result.ordered).toEqual(["a", "b", "c"]);
  });

  test("constraints touching an absent unit are ignored", () => {
    const result = orderByLoadOrder(["a"], [{ earlier: "ghost", later: "a", relationRef: "r" }]);
    expect(result.ordered).toEqual(["a"]);
  });

  test("a cyclic constraint set degrades to rank order with a warning rather than losing units", () => {
    const result = orderByLoadOrder(
      ["a", "b"],
      [
        { earlier: "a", later: "b", relationRef: "r" },
        { earlier: "b", later: "a", relationRef: "r" },
      ],
    );
    expect([...result.ordered].sort()).toEqual(["a", "b"]);
    expect(result.diagnostics.map(d => d.code)).toEqual(["LOAD_ORDER_CYCLE"]);
  });

  test("blocked-by's declared 'before' puts the dependency chain ahead of its origin", () => {
    const expansion = expandSelection(["I1"], adjacency(), domainA.relations, 8);
    const ordered = orderByLoadOrder(["I1", "I5", "I3"], expansion.orderConstraints).ordered;
    expect(ordered.indexOf("I5")).toBeLessThan(ordered.indexOf("I1"));
    expect(ordered.indexOf("I3")).toBeLessThan(ordered.indexOf("I1"));
  });
});
