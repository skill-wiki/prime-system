import { describe, expect, it } from "bun:test";
import { evaluateLicense, formatLicenseExpression, licenseIdentifiers, parseLicenseExpression, type LicensePolicy } from "../src/license.ts";

const permissive: LicensePolicy = {
  allow: ["MIT", "Apache-2.0", "MPL-2.0"],
  deny: ["GPL-3.0", "AGPL-3.0"],
  requireDeclared: true,
  allowDisjunctiveEscape: false,
};

describe("parseLicenseExpression", () => {
  it("binds AND tighter than OR, per SPDX Annex D", () => {
    const parsed = parseLicenseExpression("MIT AND Apache-2.0 OR GPL-3.0");
    expect(parsed.kind).toBe("or");
    expect(formatLicenseExpression(parsed)).toBe("MIT AND Apache-2.0 OR GPL-3.0");
  });

  it("keeps parentheses that change grouping", () => {
    const parsed = parseLicenseExpression("MIT AND (Apache-2.0 OR GPL-3.0)");
    expect(parsed.kind).toBe("and");
    expect(formatLicenseExpression(parsed)).toBe("MIT AND (Apache-2.0 OR GPL-3.0)");
  });

  it("parses WITH exceptions, or-later, and LicenseRef ids", () => {
    expect(parseLicenseExpression("GPL-2.0 WITH Classpath-exception-2.0")).toEqual({ kind: "id", id: "GPL-2.0", orLater: false, exception: "Classpath-exception-2.0" });
    expect(parseLicenseExpression("LGPL-2.1+")).toEqual({ kind: "id", id: "LGPL-2.1", orLater: true });
    expect(licenseIdentifiers(parseLicenseExpression("LicenseRef-W3C-Citation-Only AND Apache-2.0"))).toEqual(["LicenseRef-W3C-Citation-Only", "Apache-2.0"]);
  });

  it("marks prose and NOASSERTION unparsable instead of silently accepting them", () => {
    // The legacy corpus has 19 such values, e.g. "metadata-only (screenshots
    // remain copyright of original site owners)". A policy must be able to reject
    // them; treating them as compliant is how a licence hole becomes invisible.
    expect(parseLicenseExpression("metadata-only (screenshots remain copyright of original site owners)").kind).toBe("unparsable");
    expect(parseLicenseExpression("NOASSERTION").kind).toBe("unparsable");
    expect(parseLicenseExpression("MIT AND").kind).toBe("unparsable");
  });
});

describe("evaluateLicense", () => {
  it("requires every operand of a conjunction", () => {
    expect(evaluateLicense(parseLicenseExpression("MIT AND Apache-2.0"), permissive).ok).toBe(true);
    const mixed = evaluateLicense(parseLicenseExpression("MIT AND GPL-3.0"), permissive);
    expect(mixed.ok).toBe(false);
    if (!mixed.ok) {
      expect(mixed.code).toBe("LICENSE_DENIED");
      expect(mixed.offending).toContain("GPL-3.0");
    }
  });

  it("refuses a disjunction whose branch was not chosen explicitly", () => {
    const strict = evaluateLicense(parseLicenseExpression("MIT OR GPL-3.0"), permissive);
    expect(strict.ok).toBe(false);
    if (!strict.ok) expect(strict.message).toContain("allowDisjunctiveEscape");
  });

  it("accepts the same disjunction when escape is enabled", () => {
    const relaxed = evaluateLicense(parseLicenseExpression("MIT OR GPL-3.0"), { ...permissive, allowDisjunctiveEscape: true });
    expect(relaxed.ok).toBe(true);
    if (relaxed.ok) expect(relaxed.satisfyingBranch).toBe("MIT");
  });

  it("reports every branch of an unsatisfiable disjunction", () => {
    const none = evaluateLicense(parseLicenseExpression("GPL-3.0 OR AGPL-3.0"), permissive);
    expect(none.ok).toBe(false);
    if (!none.ok) {
      expect(none.code).toBe("LICENSE_DENIED");
      expect([...none.offending].sort()).toEqual(["AGPL-3.0", "GPL-3.0"]);
    }
  });

  it("rejects an id outside the allow list without needing a deny entry", () => {
    const outside = evaluateLicense(parseLicenseExpression("BSD-3-Clause"), permissive);
    expect(outside.ok).toBe(false);
    if (!outside.ok) expect(outside.code).toBe("LICENSE_NOT_ALLOWED");
  });

  it("permits every id when no allow list is declared", () => {
    expect(evaluateLicense(parseLicenseExpression("BSD-3-Clause"), { ...permissive, allow: [] }).ok).toBe(true);
  });

  it("rejects an unparsable licence", () => {
    const prose = evaluateLicense(parseLicenseExpression("varies per repo (mostly MIT, Apache 2.0)"), permissive);
    expect(prose.ok).toBe(false);
    if (!prose.ok) expect(prose.code).toBe("LICENSE_UNPARSABLE");
  });
});
