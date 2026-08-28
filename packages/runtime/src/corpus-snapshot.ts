/**
 * Immutable corpus bundle manifest loader.
 *
 * This module is intentionally limited to boot-time artifact verification. It
 * never parses .prime source or invokes the compiler.
 */
import { existsSync, readFileSync } from "fs";
import { createHash } from "crypto";
import { join } from "path";

export const CORPUS_MANIFEST_FILE = "corpus.manifest.json";
export const CORPUS_INDEX_FILE = "_index.xml";
export const SUPPORTED_CORPUS_PROTOCOL_MAJOR = 2;
export const SUPPORTED_CORPUS_IR_VERSION = "2";

export type PrimeBundleErrorCode =
  | "MANIFEST_MISSING"
  | "MANIFEST_INVALID"
  | "PROTOCOL_VERSION_UNSUPPORTED"
  | "IR_VERSION_UNSUPPORTED"
  | "INDEX_MISSING"
  | "INDEX_DIGEST_MISMATCH";

export interface BundleDiagnostic {
  code: PrimeBundleErrorCode;
  message: string;
  cause?: string;
  context?: Record<string, string>;
  severity: "warning" | "error";
}

export class PrimeBundleError extends Error {
  readonly code: PrimeBundleErrorCode;
  readonly diagnostics: readonly BundleDiagnostic[];

  constructor(code: PrimeBundleErrorCode, message: string, options: {
    cause?: unknown;
    context?: Record<string, string>;
  } = {}) {
    super(message);
    this.name = "PrimeBundleError";
    this.code = code;
    this.diagnostics = [{
      code,
      message,
      ...(options.cause === undefined ? {} : { cause: String(options.cause) }),
      ...(options.context === undefined ? {} : { context: options.context }),
      severity: "error",
    }];
  }
}

/** The immutable release manifest emitted alongside a compiled corpus. */
export interface CorpusManifest {
  protocolVersion: string;
  irVersion: string;
  compilerVersion: string;
  emitterVersion: string;
  corpus: string;
  release: string;
  sourceRevision: string;
  models: Record<string, string>;
  schemaDigest: string;
  contentDigest: string;
  indexDigest: string;
  createdAt: string;
}

/** A portable identity for a validated corpus release. Never includes a path. */
export interface SnapshotRef {
  kind: "manifest" | "legacy";
  protocolVersion: string;
  irVersion: string;
  compilerVersion: string;
  emitterVersion: string;
  corpus: string;
  release: string;
  sourceRevision: string;
  models: Record<string, string>;
  schemaDigest: string;
  contentDigest: string;
  indexDigest: string;
  createdAt: string;
}

export interface LoadCorpusSnapshotOptions {
  /** Require a v0.2 manifest instead of accepting a v0.1 legacy bundle. */
  requireManifest?: boolean;
}

export interface LoadedCorpusSnapshot {
  manifest?: CorpusManifest;
  snapshot: SnapshotRef;
  diagnostics: readonly BundleDiagnostic[];
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const REQUIRED_STRING_FIELDS = [
  "protocolVersion", "irVersion", "compilerVersion", "emitterVersion",
  "corpus", "release", "sourceRevision",
] as const;
const DIGEST_FIELDS = ["schemaDigest", "contentDigest", "indexDigest"] as const;

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function manifestError(message: string, cause?: unknown): never {
  throw new PrimeBundleError("MANIFEST_INVALID", message, { cause });
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    manifestError("corpus.manifest.json must contain a JSON object.");
  }
  return value as Record<string, unknown>;
}

/** Validate and normalize an untrusted parsed manifest without reading disk. */
export function validateCorpusManifest(value: unknown): CorpusManifest {
  const raw = requireRecord(value);
  for (const field of REQUIRED_STRING_FIELDS) {
    if (typeof raw[field] !== "string" || raw[field].trim() === "") {
      manifestError(`Manifest field \"${field}\" must be a non-empty string.`);
    }
  }
  for (const field of DIGEST_FIELDS) {
    if (typeof raw[field] !== "string" || !DIGEST.test(raw[field])) {
      manifestError(`Manifest field \"${field}\" must be a canonical sha256 digest.`);
    }
  }
  const timestamp = raw.createdAt;
  const parsedDate = typeof timestamp === "string" ? new Date(timestamp) : undefined;
  const canonicalTimestamp = typeof timestamp === "string"
    ? (timestamp.includes(".")
      ? timestamp.replace(/\.(\d{1,3})Z$/, (_match, milliseconds: string) => `.${milliseconds.padEnd(3, "0")}Z`)
      : timestamp.replace(/Z$/, ".000Z"))
    : undefined;
  if (typeof timestamp !== "string" || !TIMESTAMP.test(timestamp) || !parsedDate || Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString() !== canonicalTimestamp) {
    manifestError("Manifest field \"createdAt\" must be an ISO-8601 UTC timestamp.");
  }
  if (raw.models === null || typeof raw.models !== "object" || Array.isArray(raw.models)) {
    manifestError("Manifest field \"models\" must be an object of model versions.");
  }
  const models: Record<string, string> = {};
  for (const [name, version] of Object.entries(raw.models as Record<string, unknown>)) {
    if (!name || typeof version !== "string" || version.trim() === "") {
      manifestError("Manifest field \"models\" must map non-empty names to non-empty version strings.");
    }
    models[name] = version;
  }
  const manifest: CorpusManifest = {
    protocolVersion: raw.protocolVersion as string,
    irVersion: raw.irVersion as string,
    compilerVersion: raw.compilerVersion as string,
    emitterVersion: raw.emitterVersion as string,
    corpus: raw.corpus as string,
    release: raw.release as string,
    sourceRevision: raw.sourceRevision as string,
    models,
    schemaDigest: raw.schemaDigest as string,
    contentDigest: raw.contentDigest as string,
    indexDigest: raw.indexDigest as string,
    createdAt: raw.createdAt as string,
  };
  validateCorpusManifestCompatibility(manifest);
  return manifest;
}

/**
 * Phase 0 runtime compatibility policy for emitted corpus manifests.
 * Legacy bundles bypass this because they have no manifest to version-check.
 */
export function validateCorpusManifestCompatibility(manifest: CorpusManifest): void {
  const protocolMajor = /^([0-9]+)(?:\.[0-9]+){0,2}$/.exec(manifest.protocolVersion)?.[1];
  if (protocolMajor !== String(SUPPORTED_CORPUS_PROTOCOL_MAJOR)) {
    throw new PrimeBundleError(
      "PROTOCOL_VERSION_UNSUPPORTED",
      `Unsupported corpus protocolVersion \"${manifest.protocolVersion}\"; runtime supports major ${SUPPORTED_CORPUS_PROTOCOL_MAJOR}.`,
      { context: { actual: manifest.protocolVersion, supportedMajor: String(SUPPORTED_CORPUS_PROTOCOL_MAJOR) } },
    );
  }
  if (manifest.irVersion !== SUPPORTED_CORPUS_IR_VERSION) {
    throw new PrimeBundleError(
      "IR_VERSION_UNSUPPORTED",
      `Unsupported corpus irVersion \"${manifest.irVersion}\"; runtime supports \"${SUPPORTED_CORPUS_IR_VERSION}\".`,
      { context: { actual: manifest.irVersion, supported: SUPPORTED_CORPUS_IR_VERSION } },
    );
  }
}

function snapshotFromManifest(manifest: CorpusManifest): SnapshotRef {
  return { kind: "manifest", ...manifest, models: { ...manifest.models } };
}

function legacySnapshot(indexDigest: string): SnapshotRef {
  // The index bytes are the only available portable legacy identity. Do not
  // derive identity from primeDir: its value is machine-local and mutable.
  return {
    kind: "legacy",
    protocolVersion: "legacy/v0.1",
    irVersion: "legacy/v0.1",
    compilerVersion: "unknown",
    emitterVersion: "unknown",
    corpus: "legacy",
    release: `index:${indexDigest.slice("sha256:".length)}`,
    sourceRevision: "unknown",
    models: {},
    schemaDigest: indexDigest,
    contentDigest: indexDigest,
    indexDigest,
    createdAt: "1970-01-01T00:00:00Z",
  };
}

/**
 * Load a compiled corpus snapshot at process boot. The index digest is taken
 * from the exact _index.xml bytes, so a modified index fails closed.
 */
export function loadCorpusSnapshot(
  primeDir: string,
  options: LoadCorpusSnapshotOptions = {},
): LoadedCorpusSnapshot {
  const indexPath = join(primeDir, CORPUS_INDEX_FILE);
  if (!existsSync(indexPath)) {
    throw new PrimeBundleError("INDEX_MISSING", "Compiled corpus is missing _index.xml.", {
      context: { file: CORPUS_INDEX_FILE },
    });
  }
  const indexDigest = sha256(readFileSync(indexPath));
  const manifestPath = join(primeDir, CORPUS_MANIFEST_FILE);
  if (!existsSync(manifestPath)) {
    if (options.requireManifest) {
      throw new PrimeBundleError("MANIFEST_MISSING", "Compiled corpus is missing corpus.manifest.json.", {
        context: { file: CORPUS_MANIFEST_FILE },
      });
    }
    return {
      snapshot: legacySnapshot(indexDigest),
      diagnostics: [{
        code: "MANIFEST_MISSING",
        message: "Compiled corpus has no manifest; using a legacy v0.1 snapshot.",
        context: { file: CORPUS_MANIFEST_FILE },
        severity: "warning",
      }],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (cause) {
    throw new PrimeBundleError("MANIFEST_INVALID", "Unable to parse corpus.manifest.json.", { cause });
  }
  const manifest = validateCorpusManifest(parsed);
  if (manifest.indexDigest !== indexDigest) {
    throw new PrimeBundleError("INDEX_DIGEST_MISMATCH", "_index.xml does not match manifest indexDigest.", {
      context: { expected: manifest.indexDigest, actual: indexDigest },
    });
  }
  return { manifest, snapshot: snapshotFromManifest(manifest), diagnostics: [] };
}
