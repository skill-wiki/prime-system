import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginPathError, requireInRoot, resolveInRoot } from "../src/paths.ts";

/**
 * A real filesystem, not a mocked one. `realpath` and `lstat` are the entire
 * substance of the symlink check, so a mocked fs would make this suite assert
 * that the code calls functions rather than that the escape is refused.
 */
const root = mkdtempSync(join(tmpdir(), "plugin-host-paths-"));
const outside = mkdtempSync(join(tmpdir(), "plugin-host-outside-"));

mkdirSync(join(root, "templates"));
writeFileSync(join(root, "templates", "page.md"), "inside\n");
writeFileSync(join(outside, "secret.txt"), "stolen\n");
symlinkSync(join(outside, "secret.txt"), join(root, "escape.txt"));
symlinkSync(join(root, "templates", "page.md"), join(root, "inside-link.txt"));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("resolveInRoot — the four path attack classes (§12.3)", () => {
  test("attack 1 — '..' traversal is rejected", () => {
    const result = resolveInRoot(root, "templates/../../etc/passwd");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("PATH_TRAVERSAL");
  });

  test("attack 1b — a single leading '..' is rejected", () => {
    const result = resolveInRoot(root, "../secret.txt");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("PATH_TRAVERSAL");
  });

  test("attack 2 — an absolute path is rejected", () => {
    const result = resolveInRoot(root, join(outside, "secret.txt"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("PATH_ABSOLUTE");
  });

  test("attack 3 — a NUL byte is rejected before any fs call", () => {
    const result = resolveInRoot(root, "templates/page.md\0../../etc/passwd");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("PATH_NUL_BYTE");
  });

  test("attack 4 — a symlink escaping the root is rejected after realpath", () => {
    const result = resolveInRoot(root, "escape.txt");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("PATH_ESCAPES_ROOT");
  });
});

describe("resolveInRoot — what must still be accepted", () => {
  /**
   * The control for attack 4. Without it the suite would pass if the
   * implementation degraded into "reject every symlink", which is a ban and not
   * containment: a plugin bundle whose files are legitimately linked inside
   * itself would stop working and no test would notice.
   */
  test("a symlink pointing INSIDE the root is accepted", () => {
    const result = resolveInRoot(root, "inside-link.txt");
    expect(result.ok).toBe(true);
  });

  test("an ordinary nested file resolves to its realpath", () => {
    const result = resolveInRoot(root, "templates/page.md", "file");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.absolutePath.endsWith(join("templates", "page.md"))).toBe(true);
  });

  test("a name merely beginning with dots is not traversal", () => {
    writeFileSync(join(root, "..hidden"), "x");
    const result = resolveInRoot(root, "..hidden", "file");
    expect(result.ok).toBe(true);
  });
});

describe("resolveInRoot — the remaining refusals", () => {
  test("an empty path is refused", () => {
    const result = resolveInRoot(root, "   ");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("PATH_EMPTY");
  });

  test("a missing path is refused", () => {
    const result = resolveInRoot(root, "nope.md");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("PATH_NOT_FOUND");
  });

  test("a directory is refused when a file was required", () => {
    const result = resolveInRoot(root, "templates", "file");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("PATH_WRONG_KIND");
  });

  test("a missing root is refused without inspecting the path", () => {
    const result = resolveInRoot(join(root, "no-such-root"), "x");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("ROOT_NOT_FOUND");
  });

  test("requireInRoot throws a coded error", () => {
    expect(() => requireInRoot(root, "../x")).toThrow(PluginPathError);
    try {
      requireInRoot(root, "../x");
    } catch (error) {
      expect((error as PluginPathError).code).toBe("PATH_TRAVERSAL");
    }
  });
});
