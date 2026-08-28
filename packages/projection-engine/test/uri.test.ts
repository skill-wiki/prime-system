/**
 * Resource URI round-trip (plan §11.3).
 *
 * The interesting cases are the ones that would break a naive `split("/")`
 * implementation: a unit id that itself contains `@` and `/`.
 */

import { describe, expect, test } from "bun:test";
import { formatProjectionUri, parseProjectionUri, type ProjectionUri } from "../src/uri.ts";

const plain: ProjectionUri = {
  tenant: "tenant-a",
  corpus: "cx",
  release: "r-1",
  unitId: "u-1",
  profile: "pf-one",
  level: "lv-wide",
};

/** Scoped ids are the real-world shape: `@scope/name` has both `@` and `/`. */
const scopedId: ProjectionUri = { ...plain, unitId: "@scope-x/unit-y" };

describe("formatProjectionUri", () => {
  test("emits the §11.3 shape", () => {
    expect(formatProjectionUri(plain)).toBe(
      "prime://tenant-a/cx@r-1/units/u-1/projections/pf-one/lv-wide",
    );
  });

  test("percent-encodes an id containing '/' and '@' so the grammar stays unambiguous", () => {
    const raw = formatProjectionUri(scopedId);
    expect(raw).toBe("prime://tenant-a/cx@r-1/units/%40scope-x%2Funit-y/projections/pf-one/lv-wide");
    expect(raw.split("/").length).toBe(9); // "prime:", "", tenant, corpus@rel, units, id, projections, profile, level
  });

  test("rejects an empty field", () => {
    expect(() => formatProjectionUri({ ...plain, tenant: "" })).toThrow();
  });

  test("rejects a NUL byte in a field", () => {
    expect(() => formatProjectionUri({ ...plain, profile: "pf\0one" })).toThrow();
  });
});

describe("parseProjectionUri", () => {
  test("round-trips a plain URI without loss", () => {
    const parsed = parseProjectionUri(formatProjectionUri(plain));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value).toEqual(plain);
  });

  test("round-trips a scoped unit id without loss", () => {
    const parsed = parseProjectionUri(formatProjectionUri(scopedId));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value).toEqual(scopedId);
  });

  test("round-trips a release carrying a prerelease tag", () => {
    const withPre: ProjectionUri = { ...plain, release: "2.0.0-rc.1" };
    const parsed = parseProjectionUri(formatProjectionUri(withPre));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value).toEqual(withPre);
  });

  test("format(parse(x)) === x for every generated form", () => {
    for (const source of [plain, scopedId, { ...plain, corpus: "@ns/cx" }]) {
      const text = formatProjectionUri(source);
      const parsed = parseProjectionUri(text);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(formatProjectionUri(parsed.value)).toBe(text);
    }
  });

  test("rejects a non-prime scheme", () => {
    const parsed = parseProjectionUri("https://tenant-a/cx@r-1/units/u-1/projections/pf-one/lv-wide");
    expect(parsed.ok).toBe(false);
  });

  test("rejects a missing 'units' marker", () => {
    const parsed = parseProjectionUri("prime://tenant-a/cx@r-1/nodes/u-1/projections/pf-one/lv-wide");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toContain("units");
  });

  test("rejects a missing 'projections' marker", () => {
    const parsed = parseProjectionUri("prime://tenant-a/cx@r-1/units/u-1/views/pf-one/lv-wide");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toContain("projections");
  });

  test("rejects the wrong segment count", () => {
    const parsed = parseProjectionUri("prime://tenant-a/cx@r-1/units/u-1/projections/pf-one");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toContain("7 segments");
  });

  test("rejects a corpus without a release", () => {
    const parsed = parseProjectionUri("prime://tenant-a/cx/units/u-1/projections/pf-one/lv-wide");
    expect(parsed.ok).toBe(false);
  });

  test("rejects an empty release after '@'", () => {
    const parsed = parseProjectionUri("prime://tenant-a/cx@/units/u-1/projections/pf-one/lv-wide");
    expect(parsed.ok).toBe(false);
  });

  test("rejects a NUL byte anywhere in the URI", () => {
    const parsed = parseProjectionUri("prime://tenant-a/cx@r-1/units/u\0-1/projections/pf-one/lv-wide");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toContain("NUL");
  });

  test("rejects invalid percent-encoding rather than throwing", () => {
    const parsed = parseProjectionUri("prime://tenant-a/cx@r-1/units/%E0%A4%A/projections/pf-one/lv-wide");
    expect(parsed.ok).toBe(false);
  });
});
