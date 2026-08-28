import { describe, expect, it } from "bun:test";
import { doctorCommand, formatDoctorHuman, formatDoctorJson, parseDoctorArgs, runDoctor } from "../src/commands/doctor";
import { PrimeBundleError } from "@skill-wiki/runtime";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const snapshot = { kind: "manifest" as const, protocolVersion: "2.0.0", irVersion: "2", compilerVersion: "2", emitterVersion: "2", corpus: "org/example", release: "r 1", sourceRevision: "git:x", models: {}, schemaDigest: "sha256:" + "a".repeat(64), contentDigest: "sha256:" + "b".repeat(64), indexDigest: "sha256:" + "c".repeat(64), createdAt: "2026-08-28T00:00:00Z" };
describe("doctor", () => {
  it("parses flags with explicit directory precedence and help/errors", () => {
    expect(parseDoctorArgs(["--dir", "explicit", "--json"], { PRIME_DIR: "env" })).toMatchObject({ kind: "options", options: { dir: "explicit", json: true } });
    expect(parseDoctorArgs([], { PRIME_DIR: "env" })).toMatchObject({ kind: "options", options: { dir: "env" } });
    expect(parseDoctorArgs(["--help"], {})).toEqual({ kind: "help" });
    expect(parseDoctorArgs(["--wat"], {})).toMatchObject({ kind: "error" });
    expect(parseDoctorArgs(["--dir", "--json"], {})).toMatchObject({ kind: "error" });
    const output: string[] = []; expect(doctorCommand(["--json"], {}, (text) => output.push(text))).toBe(1); expect(JSON.parse(output[0]!).diagnostics[0].code).toBe("PRIME_DIR_REQUIRED");
    for (const argv of [["--dir", "--json"], ["--wat", "--json"]]) { const out: string[] = []; expect(doctorCommand(argv, {}, (text) => out.push(text))).toBe(1); expect(JSON.parse(out[0]!).diagnostics[0].code).toBe("DOCTOR_ARGUMENT_INVALID"); }
  });
  it("reports manifest success, legacy warning, and failures without exiting", () => {
    const good = runDoctor({ dir: "/secret", strictManifest: false, json: true }, { loadCorpusSnapshot: () => ({ snapshot, diagnostics: [] }), loadIndex: () => ({ version: "1", total: 1, totalTokens: 2, clusters: [], atoms: [], deprecated: [] }) });
    expect(good.exitCode).toBe(0); expect(formatDoctorJson(good.report)).not.toContain("/secret"); expect(formatDoctorHuman(good.report, "/secret")).toContain("/secret");
    const legacy = runDoctor({ dir: "x", strictManifest: false, json: false }, { loadCorpusSnapshot: () => ({ snapshot: { ...snapshot, kind: "legacy" as const }, diagnostics: [{ code: "MANIFEST_MISSING", message: "legacy", severity: "warning" }] }), loadIndex: () => ({ version: "1", total: 0, totalTokens: 0, clusters: [], atoms: [], deprecated: [] }) });
    expect(legacy.exitCode).toBe(0); expect(legacy.report.status).toBe("warning");
    for (const code of ["MANIFEST_MISSING", "INDEX_DIGEST_MISMATCH", "PROTOCOL_VERSION_UNSUPPORTED"] as const) {
      const failure = runDoctor({ dir: "x", strictManifest: true, json: true }, { loadCorpusSnapshot: () => { throw new PrimeBundleError(code, code); }, loadIndex: () => { throw new Error("not reached"); } });
      expect(failure.exitCode).toBe(1); expect(failure.report.diagnostics[0]?.code).toBe(code);
    }
  });
});

const manifestFixture = join(import.meta.dir, "fixtures", "doctor-manifest");
const legacyFixture = join(import.meta.dir, "..", "..", "runtime", "test", "fixtures", "atom-dir");
function withBundle(mutate: (dir: string) => void, run: (dir: string) => void) { const dir = mkdtempSync(join(tmpdir(), "prime-doctor-")); try { cpSync(manifestFixture, dir, { recursive: true }); mutate(dir); run(dir); } finally { rmSync(dir, { recursive: true, force: true }); } }
describe("doctor default runtime loaders", () => {
  it("loads valid manifest fixture", () => { const result = runDoctor({ dir: manifestFixture, strictManifest: false, json: true }); expect(result.exitCode).toBe(0); expect(result.report.mode).toBe("manifest"); });
  it("loads legacy fixture with warning", () => { const result = runDoctor({ dir: legacyFixture, strictManifest: false, json: true }); expect(result.exitCode).toBe(0); expect(result.report.mode).toBe("legacy"); });
  it("fails strict legacy fixture", () => { const result = runDoctor({ dir: legacyFixture, strictManifest: true, json: true }); expect(result.exitCode).toBe(1); expect(result.report.diagnostics[0]?.code).toBe("MANIFEST_MISSING"); });
  it("fails digest mismatch with default loader", () => withBundle((dir) => writeFileSync(join(dir, "_index.xml"), readFileSync(join(dir, "_index.xml"), "utf8") + "x"), (dir) => { const r = runDoctor({ dir, strictManifest: false, json: true }); expect(r.report.diagnostics[0]?.code).toBe("INDEX_DIGEST_MISMATCH"); }));
  it("fails unsupported protocol with default loader", () => withBundle((dir) => { const p = join(dir, "corpus.manifest.json"); writeFileSync(p, JSON.stringify({ ...JSON.parse(readFileSync(p, "utf8")), protocolVersion: "3.0.0" })); }, (dir) => { expect(runDoctor({ dir, strictManifest: false, json: true }).report.diagnostics[0]?.code).toBe("PROTOCOL_VERSION_UNSUPPORTED"); }));
  it("fails unsupported IR with default loader", () => withBundle((dir) => { const p = join(dir, "corpus.manifest.json"); writeFileSync(p, JSON.stringify({ ...JSON.parse(readFileSync(p, "utf8")), irVersion: "3" })); }, (dir) => { expect(runDoctor({ dir, strictManifest: false, json: true }).report.diagnostics[0]?.code).toBe("IR_VERSION_UNSUPPORTED"); }));
});
