import { loadCorpusSnapshot, loadIndex, PrimeBundleError, type SnapshotRef } from "@skill-wiki/runtime";

export interface DoctorOptions { dir: string; strictManifest: boolean; json: boolean; }
export type DoctorArgs = { kind: "help" } | { kind: "options"; options: DoctorOptions } | { kind: "error"; message: string; json: boolean; code: "AOE_CORPUS_DIR_REQUIRED" | "DOCTOR_ARGUMENT_INVALID" };
export interface DoctorDiagnostic { code: string; message: string; severity: "warning" | "error"; context?: Record<string, string>; }
export interface DoctorReport { ok: boolean; status: "ok" | "warning" | "error"; mode?: "manifest" | "legacy"; snapshot?: SnapshotRef; index?: { version: string; total: number; totalTokens: number; clusters: number; activeAtoms: number; deprecatedAtoms: number }; diagnostics: DoctorDiagnostic[]; }
export interface DoctorDeps { loadCorpusSnapshot: typeof loadCorpusSnapshot; loadIndex: typeof loadIndex; }

export function parseDoctorArgs(argv: string[], env: Record<string, string | undefined>): DoctorArgs {
  const requestedJson = argv.includes("--json");
  let dir: string | undefined; let strictManifest = false; let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { kind: "help" };
    if (arg === "--strict-manifest") { strictManifest = true; continue; }
    if (arg === "--json") { json = true; continue; }
    if (arg === "--dir") { dir = argv[++i]; if (!dir || dir.startsWith("-")) return { kind: "error", message: "doctor: --dir requires a path.", json: requestedJson, code: "DOCTOR_ARGUMENT_INVALID" }; continue; }
    if (arg.startsWith("--dir=")) { dir = arg.slice(6); if (!dir) return { kind: "error", message: "doctor: --dir requires a path.", json: requestedJson, code: "DOCTOR_ARGUMENT_INVALID" }; continue; }
    return { kind: "error", message: `doctor: unknown argument: ${arg}`, json: requestedJson, code: "DOCTOR_ARGUMENT_INVALID" };
  }
  dir ??= env.AOE_CORPUS_DIR;
  return dir ? { kind: "options", options: { dir, strictManifest, json } } : { kind: "error", message: "doctor: --dir or AOE_CORPUS_DIR is required.", json: requestedJson, code: "AOE_CORPUS_DIR_REQUIRED" };
}

export function runDoctor(options: DoctorOptions, deps: DoctorDeps = { loadCorpusSnapshot, loadIndex }): { exitCode: number; report: DoctorReport } {
  try {
    const loaded = deps.loadCorpusSnapshot(options.dir, { requireManifest: options.strictManifest });
    const index = deps.loadIndex(options.dir);
    return { exitCode: 0, report: { ok: true, status: loaded.diagnostics.length ? "warning" : "ok", mode: loaded.snapshot.kind === "legacy" ? "legacy" : "manifest", snapshot: loaded.snapshot, index: { version: index.version, total: index.total, totalTokens: index.totalTokens, clusters: index.clusters.length, activeAtoms: index.atoms.length, deprecatedAtoms: index.deprecated.length }, diagnostics: [...loaded.diagnostics] } };
  } catch (error) {
    const diagnostic: DoctorDiagnostic = error instanceof PrimeBundleError ? error.diagnostics[0]! : { code: "DOCTOR_FAILED", message: error instanceof Error ? error.message : String(error), severity: "error" };
    return { exitCode: 1, report: { ok: false, status: "error", diagnostics: [diagnostic] } };
  }
}

export function formatDoctorJson(report: DoctorReport): string { return JSON.stringify(report, null, 2); }
export function formatDoctorHuman(report: DoctorReport, displayDir?: string): string {
  const lines = [`AOE doctor: ${report.status.toUpperCase()}`];
  if (displayDir) lines.push(`Corpus: ${displayDir}`);
  if (report.snapshot) lines.push(`Snapshot: ${report.snapshot.corpus}@${report.snapshot.release} (${report.mode})`);
  if (report.index) lines.push(`Index: v${report.index.version}, ${report.index.activeAtoms} active, ${report.index.deprecatedAtoms} deprecated, ${report.index.totalTokens} tokens, ${report.index.clusters} clusters`);
  for (const d of report.diagnostics) lines.push(`${d.severity.toUpperCase()} ${d.code}: ${d.message}`);
  return lines.join("\n");
}

export function doctorCommand(argv: string[], env: Record<string, string | undefined> = process.env, write: (text: string) => void = console.log): number {
  const parsed = parseDoctorArgs(argv, env);
  if (parsed.kind === "help") { write("Usage: aoe doctor [--dir <compiled-corpus>] [--strict-manifest] [--json]"); return 0; }
  if (parsed.kind === "error") { const report: DoctorReport = { ok: false, status: "error", diagnostics: [{ code: parsed.code, message: parsed.message, severity: "error" }] }; write(parsed.json ? formatDoctorJson(report) : parsed.message); return 1; }
  const result = runDoctor(parsed.options);
  write(parsed.options.json ? formatDoctorJson(result.report) : formatDoctorHuman(result.report, parsed.options.dir));
  return result.exitCode;
}
