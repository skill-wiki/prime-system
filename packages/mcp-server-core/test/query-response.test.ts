import { describe, expect, it } from "bun:test";
import { createPrimeQueryResponse } from "../src/query-response";

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
  });
});
