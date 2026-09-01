import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finalizeCorpusBundle } from "../src/index";
import { compileUnit, emitCompiledUnit } from "@aoe/compiler";
import { loadModelOrThrow } from "@aoe/model-schema";
import { loadAtomMeta, loadCorpusSnapshot, loadIndex, PrimeBundleError, resolveProjection } from "../../runtime/src/index";

const digest = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;

test("generic Ticket source compiles into a strict runtime-verified corpus", () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "prime-generic-e2e-"));
  try {
    const model = loadModelOrThrow(join(import.meta.dir, "../../model-schema/test/fixtures/ticket-model"));
    const compiled = compileUnit('unit INC-42 : Ticket { title: "Fix login" priority: 1 active: true owner: Owner.alice metadata: { area: "auth" } }', model, { corpus: "org.example/tickets", version: "1.0.0", digest: digest("INC-42") });
    expect(compiled.ok).toBe(true); if (!compiled.ok) throw new Error(compiled.diagnostics.map(x => x.message).join("; "));
    emitCompiledUnit(compiled.value, dir);
    finalizeCorpusBundle({ outDir: dir, units: [compiled.value], manifest: { protocolVersion: "2.0.0", irVersion: "2", compilerVersion: "2.1.0", emitterVersion: "4", corpus: "org.example/tickets", release: "2026.08.28.1", sourceRevision: "git:test", models: { tickets: "1.0.0" }, schemaDigest: digest("ticket-schema"), createdAt: "2026-08-28T00:00:00Z" } });
    expect(loadCorpusSnapshot(dir, { requireManifest: true }).snapshot.kind).toBe("manifest");
    expect(loadIndex(dir).atoms.map(x => x.id)).toEqual(["INC-42"]);
    expect(loadAtomMeta(dir, "INC-42").kind).toBe("Ticket");
    const projection = resolveProjection(dir, "INC-42", "core"); expect(readFileSync(projection, "utf8")).toContain("Fix login");
    writeFileSync(projection, "tampered projection\n");
    try { loadCorpusSnapshot(dir, { requireManifest: true }); } catch (error) { expect((error as PrimeBundleError).code).toBe("CONTENT_DIGEST_MISMATCH"); return; }
    throw new Error("expected Runtime content digest mismatch");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
