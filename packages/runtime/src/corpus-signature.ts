import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const CORPUS_SIGNATURE_FILE = "signature.json";
export const CORPUS_SIGNATURE_VERSION = "1";
export const CORPUS_SIGNATURE_ALGORITHM = "sha256";

export type CorpusSignatureCode = "CORPUS_SIGNATURE_MISSING" | "CORPUS_SIGNATURE_INVALID" | "CORPUS_SIGNATURE_UNSUPPORTED" | "CORPUS_SIGNATURE_MISMATCH";
export interface CorpusSignature { readonly signatureVersion: string; readonly algorithm: string; readonly manifestDigest: string }

export class CorpusSignatureError extends Error {
  constructor(readonly code: CorpusSignatureCode, message: string) { super(message); this.name = "CorpusSignatureError"; }
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const digest = (bytes: Uint8Array): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

export function createCorpusSignature(manifestBytes: Uint8Array): CorpusSignature {
  return { signatureVersion: CORPUS_SIGNATURE_VERSION, algorithm: CORPUS_SIGNATURE_ALGORITHM, manifestDigest: digest(manifestBytes) };
}

export function parseCorpusSignature(value: unknown): CorpusSignature {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new CorpusSignatureError("CORPUS_SIGNATURE_INVALID", "signature.json must contain an object");
  const record = value as Record<string, unknown>;
  if (record.signatureVersion !== CORPUS_SIGNATURE_VERSION) throw new CorpusSignatureError("CORPUS_SIGNATURE_UNSUPPORTED", `Unsupported signatureVersion: ${String(record.signatureVersion)}`);
  if (record.algorithm !== CORPUS_SIGNATURE_ALGORITHM) throw new CorpusSignatureError("CORPUS_SIGNATURE_UNSUPPORTED", `Unsupported corpus signature algorithm: ${String(record.algorithm)}`);
  if (typeof record.manifestDigest !== "string" || !DIGEST.test(record.manifestDigest)) throw new CorpusSignatureError("CORPUS_SIGNATURE_INVALID", "signature.json manifestDigest must be a canonical sha256 digest");
  return { signatureVersion: record.signatureVersion, algorithm: record.algorithm, manifestDigest: record.manifestDigest };
}

/** Verify the detached release attestation over exact manifest bytes. */
export function verifyCorpusSignature(bundleRoot: string, options: { required?: boolean } = {}): CorpusSignature | undefined {
  const root = resolve(bundleRoot); const path = join(root, CORPUS_SIGNATURE_FILE);
  if (!existsSync(path)) { if (options.required === true) throw new CorpusSignatureError("CORPUS_SIGNATURE_MISSING", `Bundle requires ${CORPUS_SIGNATURE_FILE}`); return undefined; }
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new CorpusSignatureError("CORPUS_SIGNATURE_INVALID", `${CORPUS_SIGNATURE_FILE} must be a regular non-symlink file`);
  let signature: CorpusSignature;
  try { signature = parseCorpusSignature(JSON.parse(readFileSync(path, "utf8"))); }
  catch (cause) { if (cause instanceof CorpusSignatureError) throw cause; throw new CorpusSignatureError("CORPUS_SIGNATURE_INVALID", `Unable to parse ${CORPUS_SIGNATURE_FILE}: ${cause instanceof Error ? cause.message : String(cause)}`); }
  const manifestPath = join(root, "corpus.manifest.json");
  if (!existsSync(manifestPath) || !lstatSync(manifestPath).isFile()) throw new CorpusSignatureError("CORPUS_SIGNATURE_INVALID", "A corpus signature requires corpus.manifest.json");
  const actual = digest(readFileSync(manifestPath));
  if (actual !== signature.manifestDigest) throw new CorpusSignatureError("CORPUS_SIGNATURE_MISMATCH", `signature.json manifestDigest ${signature.manifestDigest} does not match ${actual}`);
  return signature;
}

/** Write the deterministic detached attestation atomically after finalization. */
export function writeCorpusSignature(bundleRoot: string): string {
  const root = resolve(bundleRoot); const target = join(root, CORPUS_SIGNATURE_FILE);
  if (existsSync(target)) { const stat = lstatSync(target); if (!stat.isFile() || stat.isSymbolicLink()) throw new CorpusSignatureError("CORPUS_SIGNATURE_INVALID", "Unsafe signature.json target"); }
  const stage = join(root, `.signature.json.stage-${process.pid}`); rmSync(stage, { force: true });
  try { writeFileSync(stage, JSON.stringify(createCorpusSignature(readFileSync(join(root, "corpus.manifest.json"))), null, 2) + "\n", "utf8"); renameSync(stage, target); }
  finally { rmSync(stage, { force: true }); }
  verifyCorpusSignature(root, { required: true }); return target;
}
