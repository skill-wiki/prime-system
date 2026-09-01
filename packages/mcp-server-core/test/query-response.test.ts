import { describe, expect, it } from "bun:test";
import { parseProjectionUri } from "@skill-wiki/projection-engine";
import { createAoeQueryResponse, createAoeResourceUri, type QueryResult } from "../src/query-response";

const SNAPSHOT = {
  kind: "manifest" as const, protocolVersion: "2.0.0", irVersion: "2", compilerVersion: "2.1.0",
  emitterVersion: "4", corpus: "org.example/test", release: "2026.08.28.1",
  sourceRevision: "git:abc", models: {}, schemaDigest: "sha256:" + "a".repeat(64),
  contentDigest: "sha256:" + "b".repeat(64), indexDigest: "sha256:" + "c".repeat(64),
  createdAt: "2026-08-28T00:00:00Z",
};

const IDENTITY = { tenant: "local", corpus: "org.example/test", release: "2026.08.28.1" };

const RESULT: QueryResult = {
  id: "@example/unit", kind: "unit", description: "test", tokens: 2, level: "core", profile: "core",
  transport: "path", bytes: 8, digest: "sha256:" + "d".repeat(64), path: "/local/projection.md",
};

describe("createAoeQueryResponse", () => {
  it("keeps the snapshot metadata portable and never leaks the server's prime dir", () => {
    const response = createAoeQueryResponse(SNAPSHOT, IDENTITY, [RESULT], 2);
    expect(response.total_index_tokens).toBe(2);
    expect(response.snapshot).not.toHaveProperty("corpusDir");
    expect(response.snapshot.release).toBe("2026.08.28.1");
    expect(response.diagnostics).toEqual([]);
  });

  it("carries the local path only for the pointer transport", () => {
    const response = createAoeQueryResponse(SNAPSHOT, IDENTITY, [RESULT], 2);
    expect(response.results[0]?.path).toBe("/local/projection.md");
    const inline = createAoeQueryResponse(
      SNAPSHOT, IDENTITY,
      [{ ...RESULT, transport: "inline", path: undefined, content: "body" }], 2,
    );
    expect(inline.results[0]?.path).toBeUndefined();
    expect(inline.results[0]?.content).toBe("body");
  });

  it("surfaces diagnostics rather than dropping them", () => {
    const response = createAoeQueryResponse(SNAPSHOT, IDENTITY, [RESULT], 2, [
      { code: "X", message: "y", severity: "warning" },
    ]);
    expect(response.diagnostics).toHaveLength(1);
  });
});

describe("createAoeResourceUri", () => {
  /**
   * The pre-cutover grammar was
   * `aoe://corpus/<corpus>/releases/<release>/units/<id>/projections/<level>` —
   * six segments, a literal `corpus` where §11.3 puts the tenant, and no profile.
   * Nothing in the repo could parse it back. These assertions are the replacement
   * contract: §11.3 shape, and a real round-trip through the engine's parser.
   */
  it("emits the §11.3 seven-segment shape", () => {
    const uri = createAoeResourceUri(IDENTITY, "@example/unit", "core", "core");
    expect(uri).toBe(
      "aoe://local/org.example%2Ftest@2026.08.28.1/units/%40example%2Funit/projections/core/core",
    );
  });

  it("round-trips every field through the engine's parser", () => {
    const uri = createAoeResourceUri(
      { tenant: "t 1", corpus: "a/b!'()*", release: "index:abc def" },
      "@a/雪",
      "pf/one",
      "lv wide",
    );
    const parsed = parseProjectionUri(uri);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual({
      tenant: "t 1", corpus: "a/b!'()*", release: "index:abc def",
      unitId: "@a/雪", profile: "pf/one", level: "lv wide",
    });
  });

  it("keeps a legacy release identity addressable", () => {
    const uri = createAoeResourceUri(
      { tenant: "local", corpus: "legacy", release: "index:abc" }, "@a/b", "core", "core",
    );
    const parsed = parseProjectionUri(uri);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.release).toBe("index:abc");
  });

  /**
   * The shape the frontend-design corpus actually publishes after the §4.3
   * namespace cutover, pinned as a literal rather than as a property.
   *
   * `identity.corpus` used to be `compiled-v3-final` — the *bundle directory's*
   * basename — so every published URI read
   * `aoe://local/compiled-v3-final@2026-08-29/units/…`. It is now the namespace
   * declared in `prime-corpus.yaml` and stamped into `corpus.manifest.json`, and
   * that value contains a `/`. This case exists because that slash is the whole
   * risk in the change: it must arrive percent-encoded *before* the corpus value
   * is placed between path separators, or the seven-segment grammar gains an
   * eighth segment and nothing can parse its own output back.
   */
  it("emits the adopted corpus namespace with its slash percent-encoded", () => {
    const identity = {
      tenant: "local",
      corpus: "com.github.skill-wiki/frontend-design",
      release: "2026-08-29",
    };
    const uri = createAoeResourceUri(identity, "@impeccable/persona-stripe-fintech", "core", "summary");
    expect(uri).toBe(
      "aoe://local/com.github.skill-wiki%2Ffrontend-design@2026-08-29" +
        "/units/%40impeccable%2Fpersona-stripe-fintech/projections/core/summary",
    );
    // No raw slash may survive inside the corpus segment: that is the failure the
    // encoding prevents, and asserting the literal above alone would not catch a
    // future emitter that split the segment differently.
    expect(uri.slice("aoe://local/".length).split("/")).toHaveLength(6);
    const parsed = parseProjectionUri(uri);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.corpus).toBe("com.github.skill-wiki/frontend-design");
  });
});
