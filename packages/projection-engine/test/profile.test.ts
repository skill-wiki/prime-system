/**
 * Profile catalog: custom profiles must work, and the engine must never assume a
 * fixed level vocabulary.
 */

import { describe, expect, test } from "bun:test";
import type { ProjectionDefIR } from "@aoe/ir";
import { ProjectionCatalog, levelFromDefinition, levelFromIR } from "../src/profile.ts";
import { levelAppliesToUnit } from "../src/select.ts";
import { projectionDef, unit } from "./fixtures.ts";

describe("levelFromDefinition", () => {
  test("reads profile/level from extensions when present", () => {
    const level = levelFromDefinition(
      projectionDef("anything-at-all", 120, { extensions: { profile: "pf-tool", level: "lv-sig" } }),
    );
    expect(level.profile).toBe("pf-tool");
    expect(level.level).toBe("lv-sig");
    expect(level.definitionName).toBe("anything-at-all");
  });

  test("falls back to the '<profile>/<level>' name convention", () => {
    const level = levelFromDefinition(projectionDef("pf-audit/lv-evidence", 400));
    expect(level.profile).toBe("pf-audit");
    expect(level.level).toBe("lv-evidence");
  });

  test("treats an unsplittable name as a single-level profile", () => {
    const level = levelFromDefinition(projectionDef("pf-solo", 60));
    expect(level.profile).toBe("pf-solo");
    expect(level.level).toBe("pf-solo");
  });

  test("carries include/exclude/typeGroups/rules through verbatim — never rewritten", () => {
    const level = levelFromDefinition(
      projectionDef("pf-one/lv-wide", 800, {
        include: ["*"],
        exclude: ["fX"],
        typeGroups: { gA: ["tA", "tB"] },
        rules: [{ layer: "lyr-1", typeRef: "tA", include: ["fY"] }],
      }),
    );
    expect(level.include).toEqual(["*"]);
    expect(level.exclude).toEqual(["fX"]);
    expect(level.typeGroups).toEqual({ gA: ["tA", "tB"] });
    expect(level.rules).toEqual([{ layer: "lyr-1", typeRef: "tA", include: ["fY"] }]);
  });
});

describe("levelFromIR", () => {
  test("recovers definition-wide include/exclude from untargeted rules", () => {
    const ir: ProjectionDefIR = {
      name: "pf-two/lv-thin",
      version: "1.0.0",
      targetTokens: 40,
      rules: [
        { include: ["fA", "fB"], exclude: ["fC"] },
        { typeRef: "tA", include: ["fD"] },
      ],
    };
    const level = levelFromIR(ir);
    expect(level.profile).toBe("pf-two");
    expect(level.level).toBe("lv-thin");
    expect(level.include).toEqual(["fA", "fB"]);
    expect(level.exclude).toEqual(["fC"]);
    expect(level.rules).toEqual([{ typeRef: "tA", include: ["fD"] }]);
  });

  test("lets a rule carry profile/level explicitly", () => {
    const level = levelFromIR({
      name: "opaque",
      version: "1.0.0",
      targetTokens: 10,
      rules: [{ profile: "pf-x", level: "lv-y" }],
    });
    expect(level.profile).toBe("pf-x");
    expect(level.level).toBe("lv-y");
  });

  test("ignores a rule array whose entries are not string arrays", () => {
    const level = levelFromIR({
      name: "pf-z/lv-z",
      version: "1.0.0",
      targetTokens: 10,
      rules: [{ include: [1, 2] }],
    });
    expect(level.include).toEqual([]);
  });
});

describe("ProjectionCatalog", () => {
  const catalog = ProjectionCatalog.fromDefinitions([
    projectionDef("pf-one/lv-wide", 800),
    projectionDef("pf-one/lv-thin", 50),
    projectionDef("pf-one/lv-mid", 200),
    // A wholly custom profile the engine has never heard of.
    projectionDef("pf-tool/lv-sig", 30),
    projectionDef("pf-audit/lv-evidence", 1200),
    { kind: "type", name: "tA", version: "1.0.0", fields: [], additionalFields: "reject" },
  ] as never);

  test("groups definitions into profiles", () => {
    expect(catalog.profiles()).toEqual(["pf-audit", "pf-one", "pf-tool"]);
  });

  test("ignores non-projection definitions", () => {
    expect(catalog.profile("tA")).toBeUndefined();
  });

  test("orders levels cheapest first so degradation has a direction", () => {
    expect(catalog.levels("pf-one").map((l) => l.level)).toEqual(["lv-thin", "lv-mid", "lv-wide"]);
  });

  test("resolves a custom profile that is not summary/core/full", () => {
    const level = catalog.level("pf-tool", "lv-sig");
    expect(level?.targetTokens).toBe(30);
  });

  test("returns an empty level list for an unknown profile instead of throwing", () => {
    expect(catalog.levels("pf-absent")).toEqual([]);
  });

  test("builds from SchemaIR projections too", () => {
    const fromIR = ProjectionCatalog.fromSchemaIR({
      a: { name: "pf-ir/lv-a", version: "1.0.0", targetTokens: 10, rules: [] },
      b: { name: "pf-ir/lv-b", version: "1.0.0", targetTokens: 20, rules: [] },
    });
    expect(fromIR.levels("pf-ir").map((l) => l.level)).toEqual(["lv-a", "lv-b"]);
  });
});

describe("levelAppliesToUnit", () => {
  test("a level with no type restriction applies to every unit", () => {
    const level = levelFromDefinition(projectionDef("pf-one/lv-wide", 800));
    expect(levelAppliesToUnit(level, unit())).toBe(true);
  });

  test("typeGroups restrict the level to the named types", () => {
    const level = levelFromDefinition(
      projectionDef("pf-one/lv-wide", 800, { typeGroups: { gA: ["tB"] } }),
    );
    expect(levelAppliesToUnit(level, unit({ typeRef: "tA" }))).toBe(false);
    expect(levelAppliesToUnit(level, unit({ typeRef: "tB" }))).toBe(true);
  });

  test("an implemented interface satisfies a typeGroup", () => {
    const level = levelFromDefinition(
      projectionDef("pf-one/lv-wide", 800, { typeGroups: { gA: ["iX"] } }),
    );
    expect(levelAppliesToUnit(level, unit({ typeRef: "tA", implements: ["iX"] }))).toBe(true);
  });

  test("rule typeRefs restrict the level when no typeGroups are declared", () => {
    const level = levelFromDefinition(
      projectionDef("pf-one/lv-wide", 800, { rules: [{ typeRef: "tB", include: ["fA"] }] }),
    );
    expect(levelAppliesToUnit(level, unit({ typeRef: "tA" }))).toBe(false);
    expect(levelAppliesToUnit(level, unit({ typeRef: "tB" }))).toBe(true);
  });
});
