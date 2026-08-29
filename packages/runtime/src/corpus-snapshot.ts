/**
 * Immutable corpus bundle manifest loader.
 *
 * This module is intentionally limited to boot-time artifact verification. It
 * never parses .prime source or invokes the compiler.
 */
import { existsSync, lstatSync, readFileSync, readdirSync } from "fs";
import { createHash } from "crypto";
import { isAbsolute, join, parse as parsePath, relative, resolve, sep } from "path";

export const CORPUS_MANIFEST_FILE = "corpus.manifest.json";
export const CORPUS_INDEX_FILE = "_index.xml";
/** Exact root-relative names that are OS/build noise, never corpus artifacts. */
export const CORPUS_NONARTIFACT_NOISE = [".DS_Store"] as const;
const EPHEMERAL_BUNDLE_FILE = /^\.prime-bundle-(?:index|manifest)-(?:stage|backup)-\d+-\d+$/;
export const SUPPORTED_CORPUS_PROTOCOL_MAJOR = 2;
export const SUPPORTED_CORPUS_IR_VERSION = "2";
/**
 * The emitter revision whose artifact bytes this Runtime is willing to serve.
 *
 * Plan §16 Phase 2 acceptance: "Emitter 变化一定使相关 artifact 失效重建." Nothing
 * in this repo builds incrementally, so there is no cache entry to evict — the
 * only place that sentence can be made true is at activation: a bundle whose
 * `emitterVersion` is not the one this Runtime understands must fail closed
 * instead of being served. Bumping `EMITTER_VERSION` in the compiler therefore
 * invalidates every previously emitted bundle, which is the intended coupling:
 * an emitter change and the Runtime that accepts its output ship together.
 *
 * This is declared here rather than imported from `@skill-wiki/compiler` on
 * purpose — plan §15.4 forbids the Runtime→Compiler edge. Same shape as
 * `SUPPORTED_CORPUS_IR_VERSION` above: the producer states what it emitted, the
 * Runtime states what it accepts, and a mismatch is an error rather than a
 * silent downgrade.
 */
export const SUPPORTED_CORPUS_EMITTER_VERSION = "3";

export type PrimeBundleErrorCode =
  | "MANIFEST_MISSING"
  | "MANIFEST_INVALID"
  | "PROTOCOL_VERSION_UNSUPPORTED"
  | "IR_VERSION_UNSUPPORTED"
  | "EMITTER_VERSION_UNSUPPORTED"
  | "SCHEMA_DIGEST_MISMATCH"
  | "INDEX_MISSING"
  | "INDEX_DIGEST_MISMATCH"
  | "CONTENT_DIGEST_MISMATCH"
  | "BUNDLE_CONTENT_INVALID";

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
  /**
   * The schema digest this caller is prepared to serve.
   *
   * Runtime holds no model, so it cannot recompute `schemaDigest` from the
   * bundle — until this option existed the field was a string nobody ever
   * compared, and a corpus compiled against a since-changed model loaded
   * cleanly. The party that does hold the model (the CLI, the MCP server, the
   * SDK host) passes what it resolved; a mismatch then fails closed the same way
   * a tampered projection does. Plan §8.4 lists "Model lock integrity" among the
   * boot checks, and this is the half Runtime can carry on its own.
   */
  expectedSchemaDigest?: string;
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
function assertNoLexicalSymlinkAncestor(path: string): void { const absolute = resolve(path); const root = parsePath(absolute).root; let current: string = root; for (const part of absolute.slice(root.length).split(sep).filter(Boolean)) { current = join(current, part); if (!existsSync(current)) break; const stat = lstatSync(current); if (stat.isSymbolicLink()) throw new PrimeBundleError("BUNDLE_CONTENT_INVALID", "Corpus root path contains a symbolic-link ancestor.", { context: { path: current } }); } }
/** Locale-independent canonical order for artifact paths and stable metadata. */
export function compareCanonicalStrings(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }

/**
 * Hash corpus artifacts using sorted POSIX paths and length-framed bytes.
 * The release manifest and temporary manifest files are intentionally omitted
 * so the manifest does not hash itself. Any link or special file fails closed.
 */
export function computeCorpusContentDigest(corpusRoot: string): string {
  assertNoLexicalSymlinkAncestor(corpusRoot);
  const root = resolve(corpusRoot);
  let rootStat: ReturnType<typeof lstatSync>;
  try { rootStat = lstatSync(root); } catch (cause) { throw new PrimeBundleError("BUNDLE_CONTENT_INVALID", "Corpus root is not readable.", { cause }); }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new PrimeBundleError("BUNDLE_CONTENT_INVALID", "Corpus root must be a real directory.", { context: { root } });
  const files: Array<{ path: string; bytes: Buffer }> = [];
  const visit = (dir: string): void => {
    let names: string[];
    try { names = readdirSync(dir); } catch (cause) { throw new PrimeBundleError("BUNDLE_CONTENT_INVALID", "Unable to read corpus directory.", { cause, context: { dir } }); }
    for (const name of names.sort(compareCanonicalStrings)) {
      const absolute = join(dir, name);
      let stat: ReturnType<typeof lstatSync>;
      try { stat = lstatSync(absolute); } catch (cause) { throw new PrimeBundleError("BUNDLE_CONTENT_INVALID", "Unable to inspect corpus entry.", { cause, context: { file: absolute } }); }
      const rel = relative(root, absolute);
      if (!rel || isAbsolute(rel) || rel.split(sep).includes("..")) throw new PrimeBundleError("BUNDLE_CONTENT_INVALID", "Corpus entry escapes its root.", { context: { file: absolute } });
      if (stat.isSymbolicLink()) throw new PrimeBundleError("BUNDLE_CONTENT_INVALID", "Corpus cannot contain symbolic links.", { context: { file: rel } });
      if (stat.isDirectory()) { visit(absolute); continue; }
      if (!stat.isFile()) throw new PrimeBundleError("BUNDLE_CONTENT_INVALID", "Corpus can contain only regular files.", { context: { file: rel } });
      const posix = rel.split(sep).join("/");
      if (posix === CORPUS_MANIFEST_FILE || /^\.corpus\.manifest\.json\.tmp-[A-Za-z0-9._-]+$/.test(posix) || EPHEMERAL_BUNDLE_FILE.test(posix) || CORPUS_NONARTIFACT_NOISE.includes(name as typeof CORPUS_NONARTIFACT_NOISE[number])) continue;
      try { files.push({ path: posix, bytes: readFileSync(absolute) }); } catch (cause) { throw new PrimeBundleError("BUNDLE_CONTENT_INVALID", "Unable to read corpus artifact.", { cause, context: { file: rel } }); }
    }
  };
  visit(root);
  const hash = createHash("sha256");
  for (const file of files.sort((a, b) => compareCanonicalStrings(a.path, b.path))) {
    const pathBytes = Buffer.from(file.path, "utf8");
    hash.update(`${pathBytes.length}:`); hash.update(pathBytes); hash.update(`:${file.bytes.length}:`); hash.update(file.bytes); hash.update(";");
  }
  return `sha256:${hash.digest("hex")}`;
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
 *
 * `compilerVersion` is deliberately NOT gated: the compiler can be rebuilt
 * without changing a single artifact byte, so rejecting on it would invalidate
 * artifacts that are still exactly what this Runtime expects. `emitterVersion`
 * is the opposite — it names the artifact layout itself.
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
  if (manifest.emitterVersion !== SUPPORTED_CORPUS_EMITTER_VERSION) {
    throw new PrimeBundleError(
      "EMITTER_VERSION_UNSUPPORTED",
      `Corpus was emitted by emitterVersion \"${manifest.emitterVersion}\"; runtime serves \"${SUPPORTED_CORPUS_EMITTER_VERSION}\". Recompile the corpus.`,
      { context: { actual: manifest.emitterVersion, supported: SUPPORTED_CORPUS_EMITTER_VERSION } },
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
  assertNoLexicalSymlinkAncestor(primeDir);
  const indexPath = join(primeDir, CORPUS_INDEX_FILE);
  if (!existsSync(indexPath)) {
    throw new PrimeBundleError("INDEX_MISSING", "Compiled corpus is missing _index.xml.", {
      context: { file: CORPUS_INDEX_FILE },
    });
  }
  if (lstatSync(indexPath).isSymbolicLink() || !lstatSync(indexPath).isFile()) throw new PrimeBundleError("BUNDLE_CONTENT_INVALID", "Corpus index must be a regular non-symlink file.", { context: { file: CORPUS_INDEX_FILE } });
  const indexDigest = sha256(readFileSync(indexPath));
  const manifestPath = join(primeDir, CORPUS_MANIFEST_FILE);
  if (!existsSync(manifestPath)) {
    if (options.requireManifest) {
      throw new PrimeBundleError("MANIFEST_MISSING", "Compiled corpus is missing corpus.manifest.json.", {
        context: { file: CORPUS_MANIFEST_FILE },
      });
    }
    if (options.expectedSchemaDigest !== undefined) {
      // A legacy bundle records neither the emitter that produced it nor the
      // model it was compiled against, so a caller that knows which schema it
      // must serve cannot be given one. This is the bypass that let a bundle
      // predating the version gates load unchecked.
      throw new PrimeBundleError("SCHEMA_DIGEST_MISMATCH", "Compiled corpus has no manifest, so its model schema cannot be verified against the caller's.", {
        context: { expected: options.expectedSchemaDigest, file: CORPUS_MANIFEST_FILE },
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
  if (lstatSync(manifestPath).isSymbolicLink() || !lstatSync(manifestPath).isFile()) throw new PrimeBundleError("BUNDLE_CONTENT_INVALID", "Corpus manifest must be a regular non-symlink file.", { context: { file: CORPUS_MANIFEST_FILE } });

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (cause) {
    throw new PrimeBundleError("MANIFEST_INVALID", "Unable to parse corpus.manifest.json.", { cause });
  }
  const manifest = validateCorpusManifest(parsed);
  if (options.expectedSchemaDigest !== undefined && manifest.schemaDigest !== options.expectedSchemaDigest) {
    throw new PrimeBundleError("SCHEMA_DIGEST_MISMATCH", "Corpus was compiled against a different model schema than the caller resolved. Recompile the corpus.", {
      context: { expected: options.expectedSchemaDigest, actual: manifest.schemaDigest },
    });
  }
  if (manifest.indexDigest !== indexDigest) {
    throw new PrimeBundleError("INDEX_DIGEST_MISMATCH", "_index.xml does not match manifest indexDigest.", {
      context: { expected: manifest.indexDigest, actual: indexDigest },
    });
  }
  const contentDigest = computeCorpusContentDigest(primeDir);
  if (manifest.contentDigest !== contentDigest) {
    throw new PrimeBundleError("CONTENT_DIGEST_MISMATCH", "Corpus artifacts do not match manifest contentDigest.", {
      context: { expected: manifest.contentDigest, actual: contentDigest },
    });
  }
  return { manifest, snapshot: snapshotFromManifest(manifest), diagnostics: [] };
}
