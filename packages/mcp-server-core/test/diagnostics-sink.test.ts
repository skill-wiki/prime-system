/**
 * Tests for the §8.3 `diagnostics.json` artifact.
 *
 * These assert the RELATION between an input edge and the class it lands in,
 * not a frozen copy of the current bundle's numbers — the counts move whenever
 * the corpus is recompiled, but "a deprecated target is not "absent"" has to
 * hold for every bundle.
 */
import { describe, expect, it } from "bun:test";
import {
  buildDiagnosticsDocument,
  classifyDangling,
  parseDanglingMessage,
  type ClassifyContext,
} from "../src/diagnostics-sink";

const context: ClassifyContext = {
  deprecated: new Map([["@community/anti-pattern-generic-saas-blue", "@community/anti-pattern-ai-slop-aesthetics"]]),
  sourceIds: new Set(["@community/only-in-sources"]),
  migratedLeaves: new Set(["only-in-migrated"]),
};

describe("parseDanglingMessage", () => {
  it("recovers the edge triple from the message buildCorpusGraph formats", () => {
    expect(
      parseDanglingMessage("@community/persona-airbnb -[compatible]-> @impeccable/persona-x: target is not an active unit in this snapshot")
    ).toEqual({ from: "@community/persona-airbnb", relation: "compatible", to: "@impeccable/persona-x" });
  });

  it("keeps a hyphenated relation name intact rather than splitting it", () => {
    expect(parseDanglingMessage("@a/b -[validates-with]-> @c/d: nope")?.relation).toBe("validates-with");
  });

  it("returns undefined for a message that is not a dangling report", () => {
    expect(parseDanglingMessage("some unrelated diagnostic")).toBeUndefined();
  });
});

describe("classifyDangling", () => {
  it("classes a bare aesthetic token apart from a unit ref", () => {
    // The source dialect writes `compatible: ["quiet-luxury"]` as a string; a
    // token can never be a unit id, so it must not be reported as missing data.
    expect(classifyDangling("quiet-luxury", context)).toBe("unresolved-style-token");
  });

  it("classes a deprecated target as superseded, not absent", () => {
    // The unit IS in the bundle — loadIndex routes it out of `atoms` because it
    // is deprecated. Calling this "absent" would send someone hunting for data
    // that never went anywhere.
    expect(classifyDangling("@community/anti-pattern-generic-saas-blue", context)).toBe(
      "target-deprecated-superseded"
    );
  });

  it("distinguishes a target that exists in a source tree from one that does not", () => {
    expect(classifyDangling("@community/only-in-sources", context)).toBe("target-in-migrated-not-bundled");
    expect(classifyDangling("@community/only-in-migrated", context)).toBe("target-in-migrated-not-bundled");
    expect(classifyDangling("@community/nowhere-at-all", context)).toBe("target-absent-everywhere");
  });

  it("degrades to absent-everywhere when no source tree is supplied", () => {
    // Over-reporting the honest-unknown class is the safe direction.
    const bare: ClassifyContext = { deprecated: new Map(), sourceIds: new Set(), migratedLeaves: new Set() };
    expect(classifyDangling("@community/only-in-sources", bare)).toBe("target-absent-everywhere");
  });
});

describe("buildDiagnosticsDocument", () => {
  const diagnostics = [
    { code: "CORPUS_EDGE_DANGLING", message: "@a/b -[related]-> @community/anti-pattern-generic-saas-blue: x", severity: "warning" as const },
    { code: "CORPUS_EDGE_DANGLING", message: "@a/b -[compatible]-> quiet-luxury: x", severity: "warning" as const },
    { code: "CORPUS_UNIT_METADATA_UNREADABLE", message: "@a/c: boom", severity: "error" as const },
  ];

  const doc = buildDiagnosticsDocument({
    corpus: "c", release: "r", contentDigest: "sha256:d",
    diagnostics,
    classify: (to) => classifyDangling(to, context),
    supersededBy: (to) => context.deprecated.get(to),
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  });

  it("counts every diagnostic by severity, not just the dangling ones", () => {
    expect(doc.counts).toEqual({ total: 3, error: 1, warning: 2, info: 0 });
  });

  it("records only dangling edges in the dangling section", () => {
    expect(doc.dangling.total).toBe(2);
    expect(doc.dangling.byClassification).toEqual({
      "target-deprecated-superseded": 1,
      "unresolved-style-token": 1,
    });
  });

  it("carries the retarget destination for a superseded target", () => {
    const record = doc.dangling.records.find((r) => r.classification === "target-deprecated-superseded");
    expect(record?.supersededBy).toBe("@community/anti-pattern-ai-slop-aesthetics");
  });

  it("omits supersededBy for a class that has no successor", () => {
    const record = doc.dangling.records.find((r) => r.classification === "unresolved-style-token");
    expect(record?.supersededBy).toBeUndefined();
  });

  it("preserves the full diagnostic list so nothing is dropped by classifying", () => {
    expect(doc.diagnostics).toHaveLength(3);
  });
});
