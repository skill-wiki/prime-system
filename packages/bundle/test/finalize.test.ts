import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCorpusSnapshot, PrimeBundleError } from "@skill-wiki/runtime";
import { finalizeCorpusBundle } from "../src/index";

const digest = (x: string) => `sha256:${createHash("sha256").update(x).digest("hex")}`;
const manifest = { protocolVersion: "2.0.0", irVersion: "2", compilerVersion: "2.1.0", emitterVersion: "3", corpus: "org.example/test", release: "r1", sourceRevision: "git:test", models: { tickets: "1.0.0" }, schemaDigest: digest("schema"), createdAt: "2026-08-28T00:00:00Z" };
const entry = (id: string) => ({ id, kind: "Ticket", version: "1.0.0", description: id, domain: "tickets", tags: ["Ticket"], tokens: { summary: 1, core: 2, full: 3 } });
function temp(run: (dir: string) => void): void { const dir = mkdtempSync(join(realpathSync(tmpdir()), "prime-bundle-")); try { run(dir); } finally { rmSync(dir, { recursive: true, force: true }); } }

test("finalizer is deterministic, self-verifies, and leaves no temp manifest", () => temp(dir => {
  mkdirSync(join(dir, "A")); writeFileSync(join(dir, "A", "atom.yaml"), "id: A\n");
  writeFileSync(join(dir, ".corpus.manifest.json.tmp-abandoned"), "stale");
  const first = finalizeCorpusBundle({ outDir: dir, entries: [entry("B"), entry("A")], manifest });
  const firstIndex = readFileSync(join(dir, "_index.xml")); const firstManifest = readFileSync(join(dir, "corpus.manifest.json"));
  const second = finalizeCorpusBundle({ outDir: dir, entries: [entry("A"), entry("B")], manifest });
  expect(second.manifest.contentDigest).toBe(first.manifest.contentDigest);
  expect(readFileSync(join(dir, "_index.xml")).equals(firstIndex)).toBe(true); expect(readFileSync(join(dir, "corpus.manifest.json")).equals(firstManifest)).toBe(true);
  expect(loadCorpusSnapshot(dir, { requireManifest: true }).snapshot.kind).toBe("manifest");
  expect(readdirSync(dir).filter(x => x.startsWith(".corpus.manifest.json.tmp"))).toEqual([]);
}));
test("finalizer rejects invalid metadata and symlink content", () => temp(dir => {
  expect(() => finalizeCorpusBundle({ outDir: dir, entries: [{ ...entry("A"), id: "../escape" }], manifest })).toThrow("Invalid corpus index entry id");
  writeFileSync(join(dir, "real"), "x"); symlinkSync(join(dir, "real"), join(dir, "link"));
  expect(() => finalizeCorpusBundle({ outDir: dir, entries: [entry("A")], manifest })).toThrow(PrimeBundleError);
}));
test("finalizer rejects a symlink corpus root", () => temp(dir => {
  const linked = `${dir}-linked`; try { symlinkSync(dir, linked); expect(() => finalizeCorpusBundle({ outDir: linked, entries: [entry("A")], manifest })).toThrow(); expect(existsSync(join(dir, "_index.xml"))).toBe(false); } finally { rmSync(linked, { force: true }); }
}));
test("finalizer validates manifest metadata and duplicate entry ids before writes", () => temp(dir => {
  expect(() => finalizeCorpusBundle({ outDir: dir, entries: [entry("A")], manifest: { ...manifest, createdAt: "not-a-date" } })).toThrow(PrimeBundleError);
  expect(() => finalizeCorpusBundle({ outDir: dir, entries: [entry("A"), entry("A")], manifest })).toThrow("Duplicate corpus index entry");
  expect(readdirSync(dir)).toEqual([]);
}));
test("finalizer rejects symlink index and manifest targets without modifying them", () => temp(dir => {
  const outside = mkdtempSync(join(realpathSync(tmpdir()), "prime-bundle-outside-"));
  try { const externalIndex = join(outside, "index"); const externalManifest = join(outside, "manifest"); writeFileSync(externalIndex, "outside-index"); writeFileSync(externalManifest, "outside-manifest"); symlinkSync(externalIndex, join(dir, "_index.xml")); expect(() => finalizeCorpusBundle({ outDir: dir, entries: [entry("A")], manifest })).toThrow("regular non-symlink"); expect(require("node:fs").readFileSync(externalIndex, "utf8")).toBe("outside-index"); rmSync(join(dir, "_index.xml")); symlinkSync(externalManifest, join(dir, "corpus.manifest.json")); expect(() => finalizeCorpusBundle({ outDir: dir, entries: [entry("A")], manifest })).toThrow("regular non-symlink"); }
  finally { rmSync(outside, { recursive: true, force: true }); }
}));
test("a validation failure preserves a prior valid index and manifest", () => temp(dir => {
  finalizeCorpusBundle({ outDir: dir, entries: [entry("A")], manifest }); const index = readFileSync(join(dir, "_index.xml")); const release = readFileSync(join(dir, "corpus.manifest.json"));
  const outside = mkdtempSync(join(realpathSync(tmpdir()), "prime-bundle-outside-"));
  try { symlinkSync(outside, join(dir, "nested")); expect(() => finalizeCorpusBundle({ outDir: dir, entries: [entry("B")], manifest })).toThrow(PrimeBundleError); expect(readFileSync(join(dir, "_index.xml")).equals(index)).toBe(true); expect(readFileSync(join(dir, "corpus.manifest.json")).equals(release)).toBe(true); }
  finally { rmSync(outside, { recursive: true, force: true }); }
}));
test("finalizer rejects lexical symlink ancestors before creating or overwriting children", () => {
  const base = mkdtempSync(join(realpathSync(tmpdir()), "bundle-ancestor-")); const outside = mkdtempSync(join(realpathSync(tmpdir()), "bundle-outside-")); const link = join(base, "link");
  try { symlinkSync(outside, link); expect(() => finalizeCorpusBundle({ outDir: join(link, "new-child"), entries: [entry("A")], manifest })).toThrow("symlink ancestor"); expect(existsSync(join(outside, "new-child"))).toBe(false); mkdirSync(join(outside, "existing")); expect(() => finalizeCorpusBundle({ outDir: join(link, "existing"), entries: [entry("A")], manifest })).toThrow("symlink ancestor"); }
  finally { rmSync(base, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});
