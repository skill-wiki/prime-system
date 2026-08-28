import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { loadModelOrThrow } from "@skill-wiki/model-schema";
import type { LoadedModel } from "@skill-wiki/model-schema";
import { buildRelationIndex, defaultRelationIndex } from "../src/relation-semantics";

const compat = loadModelOrThrow(join(import.meta.dir, "../../../compat/prime-v1-model"));

describe("relation index reads semantics from the model", () => {
  const index = buildRelationIndex(compat);

  test("resolves a declared alias to the canonical name", () => {
    // relations.yaml declares `validates-with` with aliases: [validates_with]
    expect(index.canonical("validates_with")).toBe("validates-with");
    expect(index.canonical("supplies_to")).toBe("supplies-to");
    expect(index.canonical("see_also")).toBe("see-also");
    expect(index.canonical("derived_from")).toBe("derived-from");
  });

  test("load direction is the declared loadOrder", () => {
    expect(index.direction("requires")).toBe("before");
    expect(index.direction("extends")).toBe("before");
    expect(index.direction("validates-with")).toBe("after");
    // D-7: declared `after`; the switch table this replaced returned "before".
    expect(index.direction("supplies-to")).toBe("after");
    // loadOrder: none does not constrain ordering.
    expect(index.direction("enhances")).toBe("any");
    expect(index.direction("specializes")).toBe("any");
  });

  test("an alias carries the same semantics as its canonical name", () => {
    expect(index.direction("supplies_to")).toBe(index.direction("supplies-to"));
    expect(index.required("validates_with")).toBe(index.required("validates-with"));
  });

  test("exclusion is selection: exclude, which covers more than one relation", () => {
    expect(index.excludes("contradicts")).toBe(true);
    // `conflicts` declares the same selection; the hardcoded
    // `type === "CONTRADICTS"` test never covered it.
    expect(index.excludes("conflicts")).toBe(true);
    expect(index.excludes("requires")).toBe(false);
    expect(index.excludes("enhances")).toBe(false);
  });

  test("required is selection: closure", () => {
    expect(index.required("requires")).toBe(true);
    expect(index.required("enhances")).toBe(false);
    expect(index.required("specializes")).toBe(false);
  });

  test("keys cover every legal spelling, names only the canonical ones", () => {
    expect(index.names).toContain("validates-with");
    expect(index.names).not.toContain("validates_with");
    expect(index.keys).toContain("validates-with");
    expect(index.keys).toContain("validates_with");
    expect(index.keys.length).toBeGreaterThan(index.names.length);
  });

  test("an undeclared verb yields no invented semantics", () => {
    expect(index.definition("x-not-a-relation")).toBeUndefined();
    expect(index.canonical("x-not-a-relation")).toBe("x-not-a-relation");
    expect(index.direction("x-not-a-relation")).toBe("any");
    expect(index.excludes("x-not-a-relation")).toBe(false);
    expect(index.required("x-not-a-relation")).toBe(false);
  });

  test("a model declaring no relations yields an empty index rather than a default set", () => {
    const empty = buildRelationIndex({ ...compat, definitions: [] } as LoadedModel);
    expect(empty.names).toHaveLength(0);
    expect(empty.keys).toHaveLength(0);
    expect(empty.direction("requires")).toBe("any");
    expect(empty.excludes("contradicts")).toBe(false);
  });

  test("a different model wins over the compat model", () => {
    const swapped = buildRelationIndex({
      ...compat,
      definitions: [{
        kind: "relation", name: "requires", version: "1.0.0", from: "*", to: "*",
        cardinality: "many-to-many", directional: true,
        // Deliberately the opposite of the compat model: proves nothing in the
        // engine still answers this question on its own.
        semantics: { traversal: "one-hop", selection: "exclude", loadOrder: "after", cyclePolicy: "allow", conflictSeverity: "none" },
      }],
    } as LoadedModel);
    expect(swapped.direction("requires")).toBe("after");
    expect(swapped.excludes("requires")).toBe(true);
    expect(swapped.required("requires")).toBe(false);
  });

  test("the default index is the compat model, memoized", () => {
    expect(defaultRelationIndex()).toBe(defaultRelationIndex());
    expect(defaultRelationIndex().direction("supplies-to")).toBe("after");
  });
});
