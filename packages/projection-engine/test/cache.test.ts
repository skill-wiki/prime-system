/**
 * Cache key composition (plan §12.3 and §12.4).
 *
 * The load-bearing test is tenant isolation: two tenants asking for the same unit
 * at the same level must not share an entry. Everything else is the same property
 * along a different axis.
 */

import { describe, expect, test } from "bun:test";
import { ProjectionCache, projectionCacheKey, type CacheScope, type CacheSubject } from "../src/cache.ts";
import { snapshot } from "./fixtures.ts";

const baseScope: CacheScope = {
  tenant: "tenant-a",
  workspace: "ws-a",
  corpus: "cx",
  release: "r-1",
  policyRefs: ["pol-1"],
  snapshot,
};

const baseSubject: CacheSubject = {
  unitId: "u-1",
  unitVersion: "1.0.0",
  unitDigest: "sha256:u1",
  profile: "pf-one",
  level: "lv-wide",
  levelVersion: "1.0.0",
  transport: "inline",
};

describe("projectionCacheKey — every required axis changes the key", () => {
  const base = projectionCacheKey(baseScope, baseSubject);

  test("tenant", () => {
    expect(projectionCacheKey({ ...baseScope, tenant: "tenant-b" }, baseSubject)).not.toBe(base);
  });

  test("workspace", () => {
    expect(projectionCacheKey({ ...baseScope, workspace: "ws-b" }, baseSubject)).not.toBe(base);
  });

  test("corpus", () => {
    expect(projectionCacheKey({ ...baseScope, corpus: "cy" }, baseSubject)).not.toBe(base);
  });

  test("release", () => {
    expect(projectionCacheKey({ ...baseScope, release: "r-2" }, baseSubject)).not.toBe(base);
  });

  test("snapshot — model digest", () => {
    const other = { ...baseScope, snapshot: { ...snapshot, modelDigest: "sha256:zzz" } };
    expect(projectionCacheKey(other, baseSubject)).not.toBe(base);
  });

  test("snapshot — corpus digest", () => {
    const other = { ...baseScope, snapshot: { ...snapshot, corpusDigest: "sha256:zzz" } };
    expect(projectionCacheKey(other, baseSubject)).not.toBe(base);
  });

  test("policy", () => {
    expect(projectionCacheKey({ ...baseScope, policyRefs: ["pol-2"] }, baseSubject)).not.toBe(base);
  });

  test("projection profile", () => {
    expect(projectionCacheKey(baseScope, { ...baseSubject, profile: "pf-two" })).not.toBe(base);
  });

  test("projection level", () => {
    expect(projectionCacheKey(baseScope, { ...baseSubject, level: "lv-thin" })).not.toBe(base);
  });

  test("unit version and digest", () => {
    expect(projectionCacheKey(baseScope, { ...baseSubject, unitVersion: "2.0.0" })).not.toBe(base);
    expect(projectionCacheKey(baseScope, { ...baseSubject, unitDigest: "sha256:other" })).not.toBe(base);
  });

  test("transport", () => {
    expect(projectionCacheKey(baseScope, { ...baseSubject, transport: "path" })).not.toBe(base);
  });
});

describe("projectionCacheKey — stability", () => {
  test("is deterministic for identical inputs", () => {
    expect(projectionCacheKey(baseScope, baseSubject)).toBe(projectionCacheKey(baseScope, baseSubject));
  });

  test("policy ref order does not change the key — the set is what matters", () => {
    const a = projectionCacheKey({ ...baseScope, policyRefs: ["pol-1", "pol-2"] }, baseSubject);
    const b = projectionCacheKey({ ...baseScope, policyRefs: ["pol-2", "pol-1"] }, baseSubject);
    expect(a).toBe(b);
  });

  test("a unit id containing '/' cannot collide with a different scope", () => {
    // A joined-string key would let `tenant-a/u/1` and `tenant-a/u` + `1` collide.
    const a = projectionCacheKey(baseScope, { ...baseSubject, unitId: "@s/u-1" });
    const b = projectionCacheKey({ ...baseScope, tenant: "tenant-a/@s" }, { ...baseSubject, unitId: "u-1" });
    expect(a).not.toBe(b);
  });
});

describe("ProjectionCache — tenant isolation", () => {
  test("tenant B does not read tenant A's entry for the same unit and level", () => {
    const cache = new ProjectionCache<string>();
    cache.set(baseScope, baseSubject, "payload-for-a");
    expect(cache.get({ ...baseScope, tenant: "tenant-b" }, baseSubject)).toBeUndefined();
    expect(cache.get(baseScope, baseSubject)).toBe("payload-for-a");
    expect(cache.size).toBe(1);
  });

  test("two tenants coexist as two entries", () => {
    const cache = new ProjectionCache<string>();
    cache.set(baseScope, baseSubject, "payload-for-a");
    cache.set({ ...baseScope, tenant: "tenant-b" }, baseSubject, "payload-for-b");
    expect(cache.size).toBe(2);
    expect(cache.get(baseScope, baseSubject)).toBe("payload-for-a");
    expect(cache.get({ ...baseScope, tenant: "tenant-b" }, baseSubject)).toBe("payload-for-b");
  });

  test("a different policy does not hit the same entry", () => {
    const cache = new ProjectionCache<string>();
    cache.set(baseScope, baseSubject, "payload-under-pol-1");
    expect(cache.get({ ...baseScope, policyRefs: ["pol-2"] }, baseSubject)).toBeUndefined();
  });

  test("a different snapshot does not hit the same entry", () => {
    const cache = new ProjectionCache<string>();
    cache.set(baseScope, baseSubject, "payload-at-snapshot-1");
    const moved = { ...baseScope, snapshot: { ...snapshot, corpusDigest: "sha256:moved" } };
    expect(cache.get(moved, baseSubject)).toBeUndefined();
  });

  test("every stored key mentions the tenant", () => {
    const cache = new ProjectionCache<string>();
    cache.set(baseScope, baseSubject, "x");
    expect(cache.keys().every((key) => key.includes("tenant-a"))).toBe(true);
  });
});
