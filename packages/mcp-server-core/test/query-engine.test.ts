import { describe, expect, it } from "bun:test";
import { executePrimeQuery } from "../src/query-engine";

const atoms = [
  { id: "@test/alpha", kind: "fact", description: "alpha accessibility" , tokens: 4 },
  { id: "@test/beta", kind: "rule", description: "beta accessibility", tokens: 5 },
  { id: "@test/gamma", kind: "rule", description: "gamma", tokens: 6 },
];

function query(args: Parameters<typeof executePrimeQuery>[0], extra: Partial<Parameters<typeof executePrimeQuery>[1]> = {}) {
  return executePrimeQuery(args, {
    atoms,
    loadMeta: (id) => id === "@test/alpha" ? {
      relations: [
        { type: "requires", target: "@test/beta" },
        { type: "requires", target: "@test/beta" },
        { type: "supports", target: "@test/gamma" },
      ],
    } : undefined,
    resolveProjection: (id, level) => `/fixture/${id.slice(1)}/${level}.md`,
    ...extra,
  });
}

describe("executePrimeQuery", () => {
  it("keeps atoms keyword search, kind filtering, limit, and core default", () => {
    const outcome = query({ scope: "atoms", query: "alpha accessibility", kind: "fact", limit: 1 });
    expect("results" in outcome && outcome.results).toHaveLength(1);
    if ("results" in outcome) {
      expect(outcome.results[0]).toMatchObject({ id: "@test/alpha", level: "core", path: "/fixture/test/alpha/core.md" });
    }
  });

  it("applies optional kind boosts and domain tag vocabulary without domain-specific logic", () => {
    const outcome = query({ scope: "atoms", query: "accessibility", limit: 2 }, {
      kindBoosts: { rule: 10 }, domainTags: new Set(["accessibility"]),
    });
    expect("results" in outcome && outcome.results[0]?.kind).toBe("rule");
  });

  it("supports show and a requested projection level", () => {
    const outcome = query({ scope: "show", id: "@test/beta", level: "summary" });
    expect("results" in outcome && outcome.results[0]).toMatchObject({ id: "@test/beta", level: "summary", path: "/fixture/test/beta/summary.md" });
  });

  it("preserves related traversal, duplicate suppression, relation prefix, and limit", () => {
    const outcome = query({ scope: "related", id: "@test/alpha", limit: 1 });
    expect("results" in outcome && outcome.results).toHaveLength(1);
    if ("results" in outcome) expect(outcome.results[0]).toMatchObject({ id: "@test/beta", description: "[requires] beta accessibility" });
  });

  it("preserves missing and unknown id error text", () => {
    expect(query({ scope: "show" })).toEqual({ error: "scope=show requires `id`." });
    expect(query({ scope: "related" })).toEqual({ error: "scope=related requires `id`." });
    expect(query({ scope: "show", id: "@test/missing" })).toEqual({ error: "Atom not found: @test/missing" });
    expect(query({ scope: "related", id: "@test/missing" })).toEqual({ error: "Atom not found: @test/missing" });
  });

  it("propagates corruption for known artifacts instead of returning empty results", () => {
    expect(() => query({ scope: "show", id: "@test/alpha" }, {
      resolveProjection: () => { throw new Error("projection corrupt"); },
    })).toThrow("projection corrupt");
    expect(() => query({ scope: "related", id: "@test/alpha" }, {
      loadMeta: () => { throw new Error("metadata corrupt"); },
    })).toThrow("metadata corrupt");
  });
});
