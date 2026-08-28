import { describe, expect, test } from "bun:test";
import { maxHops, readRelationSemantics, severityOf } from "../src/index.ts";
import { relation, semantics } from "./support.ts";

describe("relation semantics narrowing", () => {
  test("accepts the five-field closed set and returns a fully narrowed view", () => {
    const read = readRelationSemantics("rel-x", relation("rel-x", { traversal: "transitive", selection: "closure", loadOrder: "before", cyclePolicy: "reject", conflictSeverity: "error" }).semantics);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.value).toEqual({ traversal: "transitive", selection: "closure", loadOrder: "before", cyclePolicy: "reject", conflictSeverity: "error" });
  });

  test("rejects an out-of-set value on every field instead of defaulting it", () => {
    for (const field of ["traversal", "selection", "loadOrder", "cyclePolicy", "conflictSeverity"] as const) {
      const read = readRelationSemantics("rel-x", { ...semantics(), [field]: "not-a-value" });
      expect(read.ok).toBe(false);
      if (!read.ok) expect(read.diagnostics.map(diagnostic => [diagnostic.code, diagnostic.path?.at(-1)])).toEqual([["RELATION_SEMANTICS_INVALID", field]]);
    }
  });

  test("rejects a missing field, an unknown field, and a non-object block", () => {
    const missing = readRelationSemantics("rel-x", { traversal: "none", selection: "informational", loadOrder: "none", cyclePolicy: "allow" });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.diagnostics[0]?.code).toBe("RELATION_SEMANTICS_INVALID");
    const extra = readRelationSemantics("rel-x", { ...semantics(), soft: "yes" });
    expect(extra.ok).toBe(false);
    if (!extra.ok) expect(extra.diagnostics.map(diagnostic => diagnostic.code)).toEqual(["RELATION_SEMANTICS_UNKNOWN_FIELD"]);
    for (const raw of [undefined, null, 3, "x", []]) {
      const broken = readRelationSemantics("rel-x", raw);
      expect(broken.ok).toBe(false);
    }
  });

  test("traversal maps to a hop budget and conflict severity maps to diagnostic severity", () => {
    expect([maxHops("none"), maxHops("one-hop"), maxHops("transitive")]).toEqual([0, 1, Number.POSITIVE_INFINITY]);
    expect([severityOf("none"), severityOf("warning"), severityOf("error")]).toEqual(["info", "warning", "error"]);
  });
});
