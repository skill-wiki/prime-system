import { describe, expect, it } from "bun:test";
import { createPrimeQueryResponse, createPrimeResourceUri } from "../src/query-response";

describe("createPrimeQueryResponse", () => {
  it("keeps legacy result fields while adding portable snapshot metadata", () => {
    const response = createPrimeQueryResponse({
      kind: "manifest", protocolVersion: "2.0.0", irVersion: "2", compilerVersion: "2.1.0",
      emitterVersion: "3", corpus: "org.example/test", release: "2026.08.28.1",
      sourceRevision: "git:abc", models: {}, schemaDigest: "sha256:" + "a".repeat(64),
      contentDigest: "sha256:" + "b".repeat(64), indexDigest: "sha256:" + "c".repeat(64),
      createdAt: "2026-08-28T00:00:00Z",
    }, [{ id: "@example/unit", kind: "unit", description: "test", tokens: 2, level: "core", path: "/local/projection.md" }], 2);
    expect(response.total_index_tokens).toBe(2);
    expect(response.results[0]?.path).toBe("/local/projection.md");
    expect(response.snapshot).not.toHaveProperty("primeDir");
    expect(response.snapshot.release).toBe("2026.08.28.1");
    expect(response.results[0]?.resource_uri).toBe("prime://corpus/org.example%2Ftest/releases/2026.08.28.1/units/%40example%2Funit/projections/core");
  });
  it("encodes every URI segment, including legacy release identity", () => {
    expect(createPrimeResourceUri({ kind: "legacy", protocolVersion: "legacy", irVersion: "legacy", compilerVersion: "unknown", emitterVersion: "unknown", corpus: "a/b", release: "index:abc def", sourceRevision: "unknown", models: {}, schemaDigest: "x", contentDigest: "x", indexDigest: "x", createdAt: "1970-01-01T00:00:00Z" }, "@a/b", "core")).toBe("prime://corpus/a%2Fb/releases/index%3Aabc%20def/units/%40a%2Fb/projections/core");
  });
  it("uses RFC3986 segment encoding without local paths", () => {
    expect(createPrimeResourceUri({ kind: "manifest", protocolVersion: "2", irVersion: "2", compilerVersion: "2", emitterVersion: "2", corpus: "a/b!'()*", release: "r: 1%", sourceRevision: "x", models: {}, schemaDigest: "x", contentDigest: "x", indexDigest: "x", createdAt: "x" }, "@a/雪", "full")).toBe("prime://corpus/a%2Fb%21%27%28%29%2A/releases/r%3A%201%25/units/%40a%2F%E9%9B%AA/projections/full");
  });
});
