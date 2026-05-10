/**
 * Tests for the L2 content-hash cache.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { rmSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { L2Cache, L2_PROMPT_VERSION } from "../src/l2-cache";
import type { Diagnostic } from "../src/types";

const TMP = join(import.meta.dir, ".l2-cache-test");

function cleanup() {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
}

describe("L2Cache", () => {
  beforeEach(() => cleanup());
  afterEach(() => cleanup());

  test("put then get returns the same diagnostics", () => {
    const cache = new L2Cache({ cacheDir: TMP });
    const ast = '{"type":"PrimeDeclaration","name":"X"}';
    const diags: Diagnostic[] = [
      { level: "warn", line: 5, message: "test", source: "L2:logic" },
    ];

    expect(cache.get(ast, "claude-haiku")).toBeNull();
    cache.put(ast, "claude-haiku", diags);
    const hit = cache.get(ast, "claude-haiku");
    expect(hit).not.toBeNull();
    expect(hit).toHaveLength(1);
    expect(hit?.[0].message).toBe("test");
  });

  test("different model produces a cache miss", () => {
    const cache = new L2Cache({ cacheDir: TMP });
    const ast = '{"type":"PrimeDeclaration","name":"X"}';
    cache.put(ast, "claude-haiku", []);
    expect(cache.get(ast, "claude-haiku")).not.toBeNull();
    expect(cache.get(ast, "claude-sonnet")).toBeNull();
  });

  test("different AST produces a cache miss", () => {
    const cache = new L2Cache({ cacheDir: TMP });
    cache.put('{"type":"A"}', "m", []);
    expect(cache.get('{"type":"A"}', "m")).not.toBeNull();
    expect(cache.get('{"type":"B"}', "m")).toBeNull();
  });

  test("disabled cache never writes or reads", () => {
    const cache = new L2Cache({ cacheDir: TMP, disabled: true });
    cache.put("ast", "m", [{ level: "warn", line: 0, message: "x" }]);
    expect(existsSync(TMP)).toBe(false);
    expect(cache.get("ast", "m")).toBeNull();
  });

  test("stats track hits, misses, writes", () => {
    const cache = new L2Cache({ cacheDir: TMP });
    cache.get("a", "m"); // miss
    cache.put("a", "m", []);
    cache.get("a", "m"); // hit
    cache.get("a", "m"); // hit
    cache.get("b", "m"); // miss

    const s = cache.stats();
    expect(s.hits).toBe(2);
    expect(s.misses).toBe(2);
    expect(s.writes).toBe(1);
  });

  test("shards cache by first 2 hex chars of key", () => {
    const cache = new L2Cache({ cacheDir: TMP });
    // Write several distinct ASTs to create multiple shards.
    for (let i = 0; i < 10; i++) {
      cache.put(`{"ast":${i}}`, "m", []);
    }
    const shards = readdirSync(TMP);
    // All shard names must be 2-char hex directories.
    for (const shard of shards) {
      expect(shard).toMatch(/^[0-9a-f]{2}$/);
    }
  });

  test("exports a prompt version constant", () => {
    expect(typeof L2_PROMPT_VERSION).toBe("string");
    expect(L2_PROMPT_VERSION.length).toBeGreaterThan(0);
  });
});
