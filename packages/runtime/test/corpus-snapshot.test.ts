import { describe, expect, it } from "bun:test";
import { createHash } from "crypto";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadCorpusSnapshot, PrimeBundleError, validateCorpusManifest } from "../src/corpus-snapshot";

const digest = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const index = '<prime_index version="1.0" total="0" total_tokens="0"></prime_index>';

function withCorpus(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "prime-corpus-snapshot-"));
  try { run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

function manifest(indexDigest = digest(index)): Record<string, unknown> {
  return {
    protocolVersion: "2.0.0", irVersion: "2", compilerVersion: "2.1.0", emitterVersion: "3",
    corpus: "org.example/test", release: "2026.08.28.1", sourceRevision: "git:abc123",
    models: { "org.example/model": "2.0.0" }, schemaDigest: digest("schema"),
    contentDigest: digest("content"), indexDigest, createdAt: "2026-08-28T00:00:00Z",
  };
}

describe("loadCorpusSnapshot", () => {
  it("loads a valid manifest and verifies exact index bytes", () => withCorpus((dir) => {
    writeFileSync(join(dir, "_index.xml"), index);
    writeFileSync(join(dir, "corpus.manifest.json"), JSON.stringify(manifest()));
    const loaded = loadCorpusSnapshot(dir);
    expect(loaded.snapshot.kind).toBe("manifest");
    expect(loaded.snapshot.corpus).toBe("org.example/test");
    expect(loaded.snapshot).not.toHaveProperty("primeDir");
    expect(loaded.diagnostics).toEqual([]);
  }));

  it("creates a portable legacy snapshot and warning when the manifest is absent", () => withCorpus((dir) => {
    writeFileSync(join(dir, "_index.xml"), index);
    const loaded = loadCorpusSnapshot(dir);
    expect(loaded.snapshot.kind).toBe("legacy");
    expect(loaded.snapshot.release).toBe(`index:${digest(index).slice(7)}`);
    expect(loaded.diagnostics[0]?.code).toBe("MANIFEST_MISSING");
  }));

  it("fails closed for a missing manifest in strict mode", () => withCorpus((dir) => {
    writeFileSync(join(dir, "_index.xml"), index);
    expect(() => loadCorpusSnapshot(dir, { requireManifest: true })).toThrow(PrimeBundleError);
    try { loadCorpusSnapshot(dir, { requireManifest: true }); } catch (error) {
      expect((error as PrimeBundleError).code).toBe("MANIFEST_MISSING");
    }
  }));

  it("fails closed when the index digest differs", () => withCorpus((dir) => {
    writeFileSync(join(dir, "_index.xml"), index);
    writeFileSync(join(dir, "corpus.manifest.json"), JSON.stringify(manifest(digest("different index"))));
    try { loadCorpusSnapshot(dir); } catch (error) {
      expect((error as PrimeBundleError).code).toBe("INDEX_DIGEST_MISMATCH");
      return;
    }
    throw new Error("expected index digest mismatch");
  }));

  it("fails closed for unsupported protocol and IR versions", () => withCorpus((dir) => {
    writeFileSync(join(dir, "_index.xml"), index);
    writeFileSync(join(dir, "corpus.manifest.json"), JSON.stringify({ ...manifest(), protocolVersion: "banana" }));
    try {
      loadCorpusSnapshot(dir);
      throw new Error("expected unsupported protocol version");
    } catch (error) {
      expect((error as PrimeBundleError).code).toBe("PROTOCOL_VERSION_UNSUPPORTED");
    }
    writeFileSync(join(dir, "corpus.manifest.json"), JSON.stringify({ ...manifest(), irVersion: "3" }));
    try {
      loadCorpusSnapshot(dir);
      throw new Error("expected unsupported IR version");
    } catch (error) {
      expect((error as PrimeBundleError).code).toBe("IR_VERSION_UNSUPPORTED");
    }
  }));

  it("rejects invalid manifest fields", () => {
    expect(() => validateCorpusManifest({ ...manifest(), indexDigest: "abc" })).toThrow("canonical sha256");
    expect(() => validateCorpusManifest({ ...manifest(), createdAt: "not-a-date" })).toThrow("ISO-8601");
    expect(() => validateCorpusManifest({ ...manifest(), createdAt: "2026-02-30T00:00:00Z" })).toThrow("ISO-8601");
  });
});
