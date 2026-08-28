import { describe, expect, test } from "bun:test";
import {
  buildAdjacency,
  collectStrings,
  describeFacet,
  matchedFacets,
  matchesFacet,
  quantize,
  resolvePath,
  typedValueMatches,
} from "../src/index.ts";
import { edge, graph, list, num, obj, str, unit } from "./support/model.ts";

const reference = {
  kind: "reference" as const,
  path: ["outer", "inner"],
  target: "T1",
  source: { loc: { line: 1, column: 1, offset: 0 } },
};

describe("resolvePath", () => {
  const fields = {
    plain: str("hello"),
    nested: obj({ deep: str("value") }),
    rows: list(obj({ cell: str("a") }), obj({ cell: str("b") })),
  };

  test("an empty path resolves to nothing", () => {
    expect(resolvePath(fields, [])).toEqual([]);
  });

  test("a missing head resolves to nothing", () => {
    expect(resolvePath(fields, ["absent"])).toEqual([]);
  });

  test("descends objects", () => {
    expect(resolvePath(fields, ["nested", "deep"])).toEqual([str("value")]);
  });

  test("traverses arrays rather than indexing them", () => {
    expect(resolvePath(fields, ["rows", "cell"])).toEqual([str("a"), str("b")]);
  });

  test("a path that runs past a scalar resolves to nothing", () => {
    expect(resolvePath(fields, ["plain", "deeper"])).toEqual([]);
  });
});

describe("typedValueMatches", () => {
  test("compares scalars by value", () => {
    expect(typedValueMatches(str("x"), "x")).toBe(true);
    expect(typedValueMatches(str("x"), "y")).toBe(false);
    expect(typedValueMatches(num(3), 3)).toBe(true);
  });

  test("compares a reference on its resolved target", () => {
    expect(typedValueMatches(reference, "T1")).toBe(true);
    expect(typedValueMatches(reference, "outer")).toBe(false);
  });

  test("an array matches when any item matches", () => {
    expect(typedValueMatches(list(str("a"), str("b")), "b")).toBe(true);
    expect(typedValueMatches(list(str("a")), "b")).toBe(false);
  });

  test("an object never matches directly, only through a path", () => {
    expect(typedValueMatches(obj({ k: str("v") }), "v")).toBe(false);
  });
});

describe("collectStrings", () => {
  test("harvests values and reference targets but not object keys", () => {
    const out: string[] = [];
    collectStrings(obj({ secretFieldName: str("content"), n: num(7), ref: reference }), out);
    expect(out).toContain("content");
    expect(out).toContain("7");
    expect(out).toContain("T1");
    expect(out).not.toContain("secretFieldName");
  });
});

describe("facet description", () => {
  test("each facet kind renders", () => {
    expect(describeFacet({ kind: "typeRef", anyOf: ["A"] })).toContain("typeRef");
    expect(describeFacet({ kind: "implements", anyOf: ["I"] })).toContain("implements");
    expect(describeFacet({ kind: "field", path: ["a", "b"], anyOf: ["v"] })).toContain("a.b");
  });

  test("matchesFacet and matchedFacets agree", () => {
    const subject = unit({ id: "u", typeRef: "A", fields: { k: str("v") }, implements: ["Iface"] });
    expect(matchesFacet(subject, { kind: "implements", anyOf: ["Iface"] })).toBe(true);
    expect(matchesFacet(subject, { kind: "implements", anyOf: ["Other"] })).toBe(false);
    expect(
      matchedFacets(subject, [
        { kind: "typeRef", anyOf: ["A"] },
        { kind: "typeRef", anyOf: ["B"] },
      ]).length,
    ).toBe(1);
  });
});

describe("quantize", () => {
  test("rounds to the published precision", () => {
    expect(quantize(1 / 3)).toBe(0.333333);
  });

  test("normalises negative zero, which serializes differently from zero", () => {
    expect(Object.is(quantize(-0), 0)).toBe(true);
    expect(JSON.stringify({ v: quantize(-0) })).toBe('{"v":0}');
  });
});

describe("buildAdjacency", () => {
  const corpus = graph(
    [
      unit({ id: "b", typeRef: "A", fields: { n: str("b") } }),
      unit({ id: "a", typeRef: "A", fields: { n: str("a") } }),
    ],
    [edge("z", "a", "b"), edge("a", "a", "b")],
  );

  test("indexes units by id and both edge directions", () => {
    const adjacency = buildAdjacency(corpus);
    expect([...adjacency.unitsById.keys()].sort()).toEqual(["a", "b"]);
    expect(adjacency.outgoing.get("a")?.length).toBe(2);
    expect(adjacency.incoming.get("b")?.length).toBe(2);
    expect(adjacency.outgoing.get("b")).toBeUndefined();
  });

  test("sorts edges so traversal order never depends on corpus order", () => {
    expect(buildAdjacency(corpus).edges.map(e => e.relationRef)).toEqual(["a", "z"]);
  });
});
