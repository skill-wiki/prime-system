import { describe, expect, it } from "bun:test";
import { createHash } from "crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { spawnSync } from "node:child_process";
import { computeCorpusContentDigest, loadCorpusSnapshot, PrimeBundleError, SUPPORTED_CORPUS_EMITTER_VERSION, validateCorpusManifest } from "../src/corpus-snapshot";

const digest = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const index = '<prime_index version="1.0" total="0" total_tokens="0"></prime_index>';

function withCorpus(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "prime-corpus-snapshot-"));
  try { run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

function manifest(indexDigest = digest(index), contentDigest = digest("content")): Record<string, unknown> {
  return {
    protocolVersion: "2.0.0", irVersion: "2", compilerVersion: "2.1.0", emitterVersion: "3",
    corpus: "org.example/test", release: "2026.08.28.1", sourceRevision: "git:abc123",
    models: { "org.example/model": "2.0.0" }, schemaDigest: digest("schema"),
    contentDigest, indexDigest, createdAt: "2026-08-28T00:00:00Z",
  };
}

describe("loadCorpusSnapshot", () => {
  it("loads a valid manifest and verifies exact index bytes", () => withCorpus((dir) => {
    writeFileSync(join(dir, "_index.xml"), index);
    writeFileSync(join(dir, "corpus.manifest.json"), JSON.stringify(manifest(digest(index), computeCorpusContentDigest(dir))));
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

  it("fails closed when an artifact changes after the manifest is written", () => withCorpus((dir) => {
    writeFileSync(join(dir, "_index.xml"), index); writeFileSync(join(dir, "projection.md"), "original\n");
    writeFileSync(join(dir, "corpus.manifest.json"), JSON.stringify(manifest(digest(index), computeCorpusContentDigest(dir))));
    writeFileSync(join(dir, "projection.md"), "tampered\n");
    expect(() => loadCorpusSnapshot(dir, { requireManifest: true })).toThrow(PrimeBundleError);
    try { loadCorpusSnapshot(dir, { requireManifest: true }); } catch (error) { expect((error as PrimeBundleError).code).toBe("CONTENT_DIGEST_MISMATCH"); }
  }));

  it("verifies contentDigest even when manifest strictness is not requested", () => withCorpus((dir) => {
    writeFileSync(join(dir, "_index.xml"), index); writeFileSync(join(dir, "projection.md"), "original\n");
    writeFileSync(join(dir, "corpus.manifest.json"), JSON.stringify(manifest(digest(index), computeCorpusContentDigest(dir)))); writeFileSync(join(dir, "projection.md"), "changed\n");
    try { loadCorpusSnapshot(dir); } catch (error) { expect((error as PrimeBundleError).code).toBe("CONTENT_DIGEST_MISMATCH"); return; } throw new Error("expected digest mismatch");
  }));

  it("uses deterministic path-sorted framing and rejects symlinks", () => withCorpus((dir) => {
    writeFileSync(join(dir, "b.txt"), "b"); writeFileSync(join(dir, "a.txt"), "a"); const first = computeCorpusContentDigest(dir);
    const other = mkdtempSync(join(realpathSync(tmpdir()), "prime-corpus-content-"));
    try { writeFileSync(join(other, "a.txt"), "a"); writeFileSync(join(other, "b.txt"), "b"); expect(computeCorpusContentDigest(other)).toBe(first); symlinkSync(join(other, "a.txt"), join(other, "link.txt")); expect(() => computeCorpusContentDigest(other)).toThrow(PrimeBundleError); }
    finally { rmSync(other, { recursive: true, force: true }); }
  }));
  it("excludes only explicit nonartifact noise", () => withCorpus((dir) => {
    writeFileSync(join(dir, "artifact.md"), "x"); const before = computeCorpusContentDigest(dir); writeFileSync(join(dir, ".DS_Store"), "noise"); mkdirSync(join(dir, "nested")); writeFileSync(join(dir, "nested", ".DS_Store"), "noise"); expect(computeCorpusContentDigest(dir)).toBe(before);
  }));
  it("fails closed before reading an index symlink", () => withCorpus((dir) => {
    const outside = mkdtempSync(join(tmpdir(), "prime-index-outside-"));
    try { writeFileSync(join(outside, "index"), index); symlinkSync(join(outside, "index"), join(dir, "_index.xml")); try { loadCorpusSnapshot(dir); } catch (error) { expect((error as PrimeBundleError).code).toBe("BUNDLE_CONTENT_INVALID"); return; } throw new Error("expected invalid content"); }
    finally { rmSync(outside, { recursive: true, force: true }); }
  }));
  it("fails closed for a FIFO when the platform provides mkfifo", () => withCorpus((dir) => {
    const fifo = join(dir, "pipe"); const made = spawnSync("mkfifo", [fifo]); if (made.error || made.status !== 0) return;
    try { computeCorpusContentDigest(dir); } catch (error) { expect((error as PrimeBundleError).code).toBe("BUNDLE_CONTENT_INVALID"); return; } throw new Error("expected invalid FIFO content");
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

  /**
   * Plan §16 Phase 2 acceptance 4 — "Emitter 变化一定使相关 artifact 失效重建".
   * Nothing here builds incrementally, so activation is the only place that can
   * be true: a bundle emitted by a different emitter must not be served. Before
   * this gate existed, `emitterVersion` was validated for shape and then only
   * echoed into reports, so a v4 emitter's Runtime happily served v3 artifacts.
   */
  it("fails closed when the corpus was emitted by an unsupported emitter", () => withCorpus((dir) => {
    writeFileSync(join(dir, "_index.xml"), index);
    const contentDigest = computeCorpusContentDigest(dir);
    writeFileSync(join(dir, "corpus.manifest.json"), JSON.stringify({ ...manifest(digest(index), contentDigest), emitterVersion: "4" }));
    try {
      loadCorpusSnapshot(dir);
      throw new Error("expected unsupported emitter version");
    } catch (error) {
      expect(error).toBeInstanceOf(PrimeBundleError);
      expect((error as PrimeBundleError).code).toBe("EMITTER_VERSION_UNSUPPORTED");
    }
  }));

  it("accepts the supported emitter version and reports it on the snapshot", () => withCorpus((dir) => {
    writeFileSync(join(dir, "_index.xml"), index);
    const contentDigest = computeCorpusContentDigest(dir);
    writeFileSync(join(dir, "corpus.manifest.json"), JSON.stringify({ ...manifest(digest(index), contentDigest), emitterVersion: SUPPORTED_CORPUS_EMITTER_VERSION }));
    expect(loadCorpusSnapshot(dir).snapshot.emitterVersion).toBe(SUPPORTED_CORPUS_EMITTER_VERSION);
  }));

  /**
   * A legacy v0.1 bundle has no manifest, so it cannot claim an emitter at all;
   * its `emitterVersion` is the sentinel "unknown". The gate must not reject it,
   * otherwise adding the gate silently drops legacy support.
   */
  it("does not apply the emitter gate to legacy bundles", () => withCorpus((dir) => {
    writeFileSync(join(dir, "_index.xml"), index);
    const loaded = loadCorpusSnapshot(dir);
    expect(loaded.snapshot.kind).toBe("legacy");
    expect(loaded.snapshot.emitterVersion).toBe("unknown");
  }));
});
