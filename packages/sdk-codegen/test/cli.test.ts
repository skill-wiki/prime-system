/**
 * The CLI is the way this package affects the system (it is a toolchain step, run
 * rather than imported), so its argument handling and its refusal paths are tested
 * like any other public surface.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { run } from "../src/cli.ts";

const REPO = resolve(import.meta.dir, "../../..");
const scratch = mkdtempSync(join(tmpdir(), "prime-sdk-codegen-cli-"));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("prime-sdk-codegen", () => {
  test("writes every artifact for a real model package and exits 0", () => {
    const out = join(scratch, "security");
    expect(run(["--model", join(REPO, "packages/testkit/fixtures/security-model"), "--out", out])).toBe(0);
    for (const file of ["types.ts", "client.ts", "mcp-tools.json", "schema.json"]) {
      expect(existsSync(join(out, file))).toBe(true);
    }
    const schema = JSON.parse(readFileSync(join(out, "schema.json"), "utf8"));
    expect(readFileSync(join(out, "types.ts"), "utf8")).toContain(schema.model.digest);
  });

  test("creates a nested output directory rather than failing on it", () => {
    const out = join(scratch, "nested/deeper/still");
    expect(run(["--model", join(REPO, "compat/prime-v1-model"), "--out", out])).toBe(1 - 1);
    expect(existsSync(join(out, "types.ts"))).toBe(true);
  });

  test("an invalid model package exits non-zero instead of emitting a partial SDK", () => {
    const out = join(scratch, "invalid");
    expect(run(["--model", join(scratch, "no-such-model"), "--out", out])).toBe(1);
    expect(existsSync(out)).toBe(false);
  });

  test("regenerating into the same directory is byte-identical", () => {
    const out = join(scratch, "repeat");
    run(["--model", join(REPO, "packages/testkit/fixtures/security-model"), "--out", out]);
    const first = readFileSync(join(out, "types.ts"), "utf8");
    run(["--model", join(REPO, "packages/testkit/fixtures/security-model"), "--out", out]);
    expect(readFileSync(join(out, "types.ts"), "utf8")).toBe(first);
  });
});
