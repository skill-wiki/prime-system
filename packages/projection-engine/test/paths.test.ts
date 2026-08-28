/**
 * Path containment attacks (plan §12.3). The work order requires one test per
 * attack class; each of the four below is a real filesystem attempt against a
 * real bundle root, not a string assertion.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectionPathError, requireBundlePath, resolveBundlePath } from "../src/paths.ts";

let bundleRoot: string;
let outsideDir: string;
let outsideFile: string;

beforeAll(() => {
  const base = mkdtempSync(join(tmpdir(), "prime-proj-paths-"));
  bundleRoot = join(base, "bundle");
  outsideDir = join(base, "outside");
  mkdirSync(join(bundleRoot, "units", "u-1"), { recursive: true });
  mkdirSync(outsideDir, { recursive: true });

  writeFileSync(join(bundleRoot, "units", "u-1", "lv-wide.md"), "inside\n", "utf8");
  outsideFile = join(outsideDir, "stolen.md");
  writeFileSync(outsideFile, "outside\n", "utf8");

  // Attack 4 fixture: a link that lives inside the bundle but points out of it.
  symlinkSync(outsideFile, join(bundleRoot, "units", "u-1", "escape.md"));
  // Control fixture: a link inside the bundle pointing at another inside file,
  // which must still be accepted — otherwise the check is just "no symlinks".
  symlinkSync(join(bundleRoot, "units", "u-1", "lv-wide.md"), join(bundleRoot, "units", "u-1", "alias.md"));
});

afterAll(() => {
  rmSync(join(bundleRoot, ".."), { recursive: true, force: true });
});

describe("resolveBundlePath — legitimate paths", () => {
  test("accepts a bundle-relative artifact path", () => {
    const result = resolveBundlePath(bundleRoot, "units/u-1/lv-wide.md");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.absolutePath.endsWith("units/u-1/lv-wide.md")).toBe(true);
  });

  test("accepts a symlink that stays inside the bundle", () => {
    const result = resolveBundlePath(bundleRoot, "units/u-1/alias.md");
    expect(result.ok).toBe(true);
  });
});

describe("resolveBundlePath — the four attack classes (§12.3)", () => {
  test("attack 1 — '..' traversal is rejected", () => {
    const result = resolveBundlePath(bundleRoot, "units/u-1/../../../outside/stolen.md");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("PATH_TRAVERSAL");
  });

  test("attack 1b — a single leading '..' is rejected", () => {
    const result = resolveBundlePath(bundleRoot, "../outside/stolen.md");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("PATH_TRAVERSAL");
  });

  test("attack 2 — an absolute projection path is rejected", () => {
    const result = resolveBundlePath(bundleRoot, outsideFile);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("PATH_ABSOLUTE");
  });

  test("attack 3 — a NUL byte is rejected before any fs call", () => {
    const result = resolveBundlePath(bundleRoot, "units/u-1/lv-wide.md\0../../../outside/stolen.md");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("PATH_NUL_BYTE");
  });

  test("attack 4 — a symlink escaping the bundle is rejected after realpath", () => {
    // Every string segment is innocent here; only realpath exposes the escape.
    const result = resolveBundlePath(bundleRoot, "units/u-1/escape.md");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("PATH_ESCAPES_ROOT");
  });
});

describe("resolveBundlePath — other refusals", () => {
  test("an empty path is rejected", () => {
    const result = resolveBundlePath(bundleRoot, "   ");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("PATH_EMPTY");
  });

  test("a directory is not a valid artifact", () => {
    const result = resolveBundlePath(bundleRoot, "units/u-1");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("PATH_NOT_A_FILE");
  });

  test("a missing artifact is reported as not found", () => {
    const result = resolveBundlePath(bundleRoot, "units/u-1/absent.md");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("PATH_NOT_FOUND");
  });

  test("a missing bundle root is reported distinctly", () => {
    const result = resolveBundlePath(join(bundleRoot, "nope"), "units/u-1/lv-wide.md");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("ROOT_NOT_FOUND");
  });
});

describe("requireBundlePath", () => {
  test("returns the absolute path on success", () => {
    expect(requireBundlePath(bundleRoot, "units/u-1/lv-wide.md").endsWith("lv-wide.md")).toBe(true);
  });

  test("throws a coded ProjectionPathError on refusal", () => {
    try {
      requireBundlePath(bundleRoot, "units/u-1/escape.md");
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error instanceof ProjectionPathError).toBe(true);
      if (error instanceof ProjectionPathError) {
        expect(error.code).toBe("PATH_ESCAPES_ROOT");
        expect(error.requestedPath).toBe("units/u-1/escape.md");
      }
    }
  });
});
