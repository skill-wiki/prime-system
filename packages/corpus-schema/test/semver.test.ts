import { describe, expect, it } from "bun:test";
import { compareSemVer, parseRange, parseSemVer, resolveVersion, satisfies, SemVerError } from "../src/semver.ts";

describe("parseSemVer", () => {
  it("parses prerelease identifiers as numbers when numeric", () => {
    expect(parseSemVer("1.2.3-rc.1").prerelease).toEqual(["rc", 1]);
    expect(parseSemVer("1.2.3+build.5").build).toBe("build.5");
  });

  it("rejects a leading zero and a partial version", () => {
    expect(() => parseSemVer("01.2.3")).toThrow(SemVerError);
    expect(() => parseSemVer("1.2")).toThrow(SemVerError);
  });
});

describe("compareSemVer", () => {
  it("orders a prerelease below its release (SemVer §11.3)", () => {
    expect(compareSemVer(parseSemVer("1.0.0-rc.1"), parseSemVer("1.0.0"))).toBe(-1);
  });

  it("orders numeric prerelease identifiers below alphanumeric ones (§11.4.3)", () => {
    expect(compareSemVer(parseSemVer("1.0.0-1"), parseSemVer("1.0.0-alpha"))).toBe(-1);
  });

  it("orders a longer prerelease above its prefix (§11.4.4)", () => {
    expect(compareSemVer(parseSemVer("1.0.0-alpha"), parseSemVer("1.0.0-alpha.1"))).toBe(-1);
  });

  it("ignores build metadata in ordering (§10)", () => {
    expect(compareSemVer(parseSemVer("1.0.0+a"), parseSemVer("1.0.0+b"))).toBe(0);
  });
});

describe("satisfies", () => {
  it("holds the leftmost non-zero field for caret ranges", () => {
    expect(satisfies("1.9.9", "^1.0.0")).toBe(true);
    expect(satisfies("2.0.0", "^1.0.0")).toBe(false);
    expect(satisfies("0.2.0", "^0.1.0")).toBe(false);
    expect(satisfies("0.1.9", "^0.1.0")).toBe(true);
    expect(satisfies("0.0.2", "^0.0.1")).toBe(false);
  });

  it("holds minor for tilde ranges", () => {
    expect(satisfies("1.2.9", "~1.2.0")).toBe(true);
    expect(satisfies("1.3.0", "~1.2.0")).toBe(false);
    expect(satisfies("1.9.0", "~1")).toBe(true);
  });

  it("widens an unpinned field instead of filling it with zero", () => {
    expect(satisfies("1.2.7", "1.2")).toBe(true);
    expect(satisfies("1.3.0", "1.2")).toBe(false);
    expect(satisfies("1.9.0", "1.x")).toBe(true);
  });

  it("supports comparator conjunctions, hyphen ranges and disjunctions", () => {
    expect(satisfies("1.5.0", ">=1.2.0 <2.0.0")).toBe(true);
    expect(satisfies("2.0.0", ">=1.2.0 <2.0.0")).toBe(false);
    expect(satisfies("1.2.5", "1.2.0 - 1.3")).toBe(true);
    expect(satisfies("1.4.0", "1.2.0 - 1.3")).toBe(false);
    expect(satisfies("3.0.0", "^1.0.0 || ^3.0.0")).toBe(true);
  });

  it("never selects a prerelease for a range that named none", () => {
    // The rule that stops ^1.0.0 from resolving to 2.0.0-rc.1 — and, more
    // importantly, from resolving to 1.9.0-rc.1 ahead of 1.8.0.
    expect(satisfies("1.9.0-rc.1", "^1.0.0")).toBe(false);
    expect(satisfies("1.9.0-rc.1", ">=1.9.0-rc.0 <2.0.0")).toBe(true);
    expect(satisfies("1.0.0-rc.1", "*")).toBe(false);
  });

  it("matches everything releasable for a bare wildcard", () => {
    expect(satisfies("9.9.9", "*")).toBe(true);
  });

  it("rejects an unparsable range rather than accepting everything", () => {
    expect(() => parseRange("~>1.0")).toThrow(SemVerError);
    expect(() => parseRange("")).toThrow(SemVerError);
    expect(() => parseRange("^")).toThrow(SemVerError);
  });
});

describe("resolveVersion", () => {
  it("picks the highest satisfying version, not the first offered", () => {
    const resolution = resolveVersion("^1.0.0", ["1.0.0", "1.4.2", "1.2.0", "2.0.0"]);
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.version.raw).toBe("1.4.2");
    expect(resolution.candidates.map(candidate => candidate.raw)).toEqual(["1.4.2", "1.2.0", "1.0.0"]);
  });

  it("fails closed with no candidates rather than defaulting", () => {
    const empty = resolveVersion("^1.0.0", []);
    expect(empty.ok).toBe(false);
    if (empty.ok) return;
    expect(empty.code).toBe("NO_CANDIDATES");
  });

  it("fails closed when nothing matches and reports what was available", () => {
    const missed = resolveVersion("^2.0.0", ["1.0.0", "1.4.2"]);
    expect(missed.ok).toBe(false);
    if (missed.ok) return;
    expect(missed.code).toBe("NO_MATCHING_VERSION");
    expect(missed.message).toContain("1.4.2");
  });

  it("resolves the binding this repo's corpus actually declares", () => {
    // `prime-corpus.yaml` binds `prime-v1-compatibility: ^1.0.0` and the model at
    // compat/prime-v1-model declares 1.0.0. This is the exact resolution
    // `validateCorpusManifest`'s non-empty-string check could never perform.
    const resolution = resolveVersion("^1.0.0", ["1.0.0"]);
    expect(resolution.ok).toBe(true);
    if (resolution.ok) expect(resolution.version.raw).toBe("1.0.0");
  });
});
