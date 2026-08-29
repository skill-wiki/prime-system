/**
 * Immutable corpus bundle manifest loader.
 *
 * This module is intentionally limited to boot-time artifact verification. It
 * never parses .prime source or invokes the compiler.
 */
import { existsSync, lstatSync, readFileSync, readdirSync } from "fs";
import { createHash } from "crypto";
import { isAbsolute, join, parse as parsePath, relative, resolve, sep } from "path";
import { CORPUS_DECLARATION_FILE, NAMESPACE, loadCorpusPackage } from "@skill-wiki/corpus-schema";

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

// ─── Multi-corpus mounting (§8.5 activate/swap, §12.4 scoped keys) ───────────

/**
 * Why a registry, and why here.
 *
 * `loadCorpusSnapshot` above takes one directory and returns one snapshot. The
 * server built on it reads one `PRIME_DIR` and freezes one `{tenant, workspace,
 * corpus, release}` tuple at boot, so switching corpus means editing
 * `.mcp.json` and restarting the process. §12.4 names that shape explicitly and
 * forbids it — "多租户不能靠多个全局 PRIME_DIR 模拟" — and §8.5 requires that a
 * new release be activated by an atomic swap with old runs still replayable.
 * Neither is possible while the loader's arity is the limit.
 *
 * So the registry is deliberately *not* a second loader. It is a keyed set of
 * results from the loader that already exists, plus the two operations §8.5
 * names: `activate` and `swap`. Every mount goes through the same boot checks
 * (index digest, content digest, protocol/ir/emitter gates); nothing here
 * loosens them, and a mount that fails them is recorded as failed rather than
 * dropped, because "the corpus you asked for did not load" and "the corpus you
 * asked for was never mounted" are different answers to a request.
 *
 * Identity, not paths, is the key: `namespace@release`. A path is machine-local
 * and mutable — the comment on `legacySnapshot` above already says so — and two
 * mounts of the same release from two paths are the same corpus.
 */

export type CorpusMountErrorCode =
  | "MOUNT_LOAD_FAILED"
  | "MOUNT_DUPLICATE"
  | "MOUNT_NAMESPACE_INVALID"
  | "MOUNT_NAMESPACE_MISMATCH"
  | "MOUNT_DECLARATION_INVALID"
  | "MOUNT_NOT_FOUND";

export interface CorpusMountDiagnostic {
  code: CorpusMountErrorCode;
  message: string;
  context?: Record<string, string>;
  severity: "warning" | "error";
}

/**
 * How a mount's namespace is decided when the bundle's manifest and the corpus
 * package declaration disagree.
 *
 * - `manifest` (default): the snapshot keeps `manifest.corpus`. The declaration
 *   is still read and a mismatch is reported, so the divergence is visible
 *   without changing a single outward-facing `prime://` URI.
 * - `declaration`: the declared namespace wins and becomes the registry key.
 *
 * The default is `manifest` because `manifest.corpus` currently flows straight
 * into the public resource URI (§11.3). Flipping the default would rewrite every
 * URI a client has seen, which is a release decision and not a loader decision.
 */
export type NamespaceSource = "manifest" | "declaration";

export interface CorpusMountRequest {
  /** Directory holding the compiled bundle (`_index.xml` + `corpus.manifest.json`). */
  readonly path: string;
  /**
   * Directory holding this corpus's `prime-corpus.yaml`. When given, the declared
   * namespace is the authoritative source of the corpus's identity — that is the
   * §4.3 answer to "where does a namespace come from", as opposed to the current
   * answer, which is the basename of `path`.
   */
  readonly declarationRoot?: string;
  readonly expectedSchemaDigest?: string;
  readonly requireManifest?: boolean;
}

export interface MountedCorpus {
  /** `namespace@release` — the registry key and the §12.4 corpus/release pair. */
  readonly key: string;
  readonly namespace: string;
  readonly release: string;
  /** What the bundle's own manifest called the corpus, kept even when overridden. */
  readonly manifestCorpus: string;
  /** What `prime-corpus.yaml` declared, when a declaration was supplied. */
  readonly declaredNamespace?: string;
  readonly path: string;
  readonly loaded: LoadedCorpusSnapshot;
  /** Corpus-side default retrieval profile from the declaration, if any (§4.3). */
  readonly defaultProfile?: string;
  readonly diagnostics: readonly CorpusMountDiagnostic[];
}

export interface FailedMount {
  readonly path: string;
  readonly diagnostics: readonly CorpusMountDiagnostic[];
}

export function corpusMountKey(namespace: string, release: string): string {
  // Canonical JSON array rather than a delimiter join, matching
  // `projection-engine/src/cache.ts`: a namespace may contain `/` and `.`, and a
  // release may contain `+`, so no single separator is collision-free.
  return JSON.stringify([namespace, release]);
}

/**
 * A set of mounted corpora with one active release per namespace.
 *
 * Immutability is per snapshot, not per registry: `swap` replaces which release
 * a namespace resolves to by default, and the displaced release stays mounted so
 * a run recorded against it can still be replayed. That is the §8.5 sentence
 * "旧 run 仍可重放" made operational rather than merely representable — the keys
 * could already record an old snapshot, but nothing could load it back.
 */
export class CorpusRegistry {
  private readonly mounts = new Map<string, MountedCorpus>();
  private readonly active = new Map<string, string>();

  static from(requests: readonly CorpusMountRequest[], options: { namespaceSource?: NamespaceSource } = {}): {
    registry: CorpusRegistry;
    failed: readonly FailedMount[];
  } {
    const registry = new CorpusRegistry();
    const failed: FailedMount[] = [];
    for (const request of requests) {
      const outcome = mountCorpus(request, options);
      if (outcome.ok) registry.add(outcome.mount, failed);
      else failed.push(outcome.failure);
    }
    return { registry, failed };
  }

  private add(mount: MountedCorpus, failed: FailedMount[]): void {
    const existing = this.mounts.get(mount.key);
    if (existing !== undefined) {
      failed.push({
        path: mount.path,
        diagnostics: [{
          code: "MOUNT_DUPLICATE", severity: "error",
          message: "A corpus release is already mounted under this identity.",
          context: { key: mount.key, existingPath: existing.path, rejectedPath: mount.path },
        }],
      });
      return;
    }
    this.mounts.set(mount.key, mount);
    // First mount of a namespace becomes its active release; later ones must be
    // activated explicitly, so mount order cannot silently repoint a namespace.
    if (!this.active.has(mount.namespace)) this.active.set(mount.namespace, mount.release);
  }

  get size(): number { return this.mounts.size; }

  namespaces(): readonly string[] {
    return [...new Set([...this.mounts.values()].map(mount => mount.namespace))].sort(compareCanonicalStrings);
  }

  releasesOf(namespace: string): readonly string[] {
    return [...this.mounts.values()].filter(mount => mount.namespace === namespace).map(mount => mount.release).sort(compareCanonicalStrings);
  }

  all(): readonly MountedCorpus[] {
    return [...this.mounts.values()].sort((a, b) => compareCanonicalStrings(a.key, b.key));
  }

  /** Resolve a request to a mount. Omitting `release` takes the active one. */
  resolve(namespace: string, release?: string): MountedCorpus | undefined {
    const wanted = release ?? this.active.get(namespace);
    if (wanted === undefined) return undefined;
    return this.mounts.get(corpusMountKey(namespace, wanted));
  }

  activeRelease(namespace: string): string | undefined { return this.active.get(namespace); }

  /**
   * Point a namespace at an already-mounted release.
   *
   * Fails closed on an unmounted release rather than activating nothing: a
   * silent no-op here would serve the previous corpus under the new release's
   * name, which is the failure mode a swap exists to prevent.
   */
  activate(namespace: string, release: string): { ok: true; previous?: string } | { ok: false; diagnostic: CorpusMountDiagnostic } {
    const key = corpusMountKey(namespace, release);
    if (!this.mounts.has(key)) {
      return {
        ok: false,
        diagnostic: {
          code: "MOUNT_NOT_FOUND", severity: "error",
          message: "Cannot activate a release that is not mounted.",
          context: { namespace, release, mounted: this.releasesOf(namespace).join(", ") },
        },
      };
    }
    const previous = this.active.get(namespace);
    this.active.set(namespace, release);
    return previous === undefined ? { ok: true } : { ok: true, previous };
  }

  /**
   * Mount a new release and activate it in one step, keeping the displaced one
   * mounted for replay. The mount is validated before the activation, so a
   * bundle that fails its boot checks never becomes the active corpus.
   */
  swap(request: CorpusMountRequest, options: { namespaceSource?: NamespaceSource } = {}):
    | { ok: true; mounted: MountedCorpus; previous?: MountedCorpus }
    | { ok: false; diagnostics: readonly CorpusMountDiagnostic[] } {
    const outcome = mountCorpus(request, options);
    if (!outcome.ok) return { ok: false, diagnostics: outcome.failure.diagnostics };
    const previousRelease = this.active.get(outcome.mount.namespace);
    const previous = previousRelease === undefined ? undefined : this.mounts.get(corpusMountKey(outcome.mount.namespace, previousRelease));
    const failed: FailedMount[] = [];
    if (!this.mounts.has(outcome.mount.key)) this.add(outcome.mount, failed);
    if (failed.length > 0) return { ok: false, diagnostics: failed.flatMap(entry => entry.diagnostics) };
    this.active.set(outcome.mount.namespace, outcome.mount.release);
    const mounted = this.mounts.get(outcome.mount.key)!;
    return previous === undefined || previous.key === mounted.key ? { ok: true, mounted } : { ok: true, mounted, previous };
  }
}

/**
 * Validate one bundle and pair it with its §4.3 declaration.
 *
 * The declaration is what makes a namespace legitimate: without it the only
 * available identity is `manifest.corpus`, whose current value in this repo is
 * the bundle directory's basename. Reading the declaration does not by itself
 * change any URI — see `NamespaceSource`.
 */
export function mountCorpus(
  request: CorpusMountRequest,
  options: { namespaceSource?: NamespaceSource } = {},
): { ok: true; mount: MountedCorpus } | { ok: false; failure: FailedMount } {
  const diagnostics: CorpusMountDiagnostic[] = [];
  let loaded: LoadedCorpusSnapshot;
  try {
    loaded = loadCorpusSnapshot(request.path, {
      ...(request.requireManifest === undefined ? {} : { requireManifest: request.requireManifest }),
      ...(request.expectedSchemaDigest === undefined ? {} : { expectedSchemaDigest: request.expectedSchemaDigest }),
    });
  } catch (cause) {
    const code = cause instanceof PrimeBundleError ? cause.code : "unknown";
    return {
      ok: false,
      failure: {
        path: request.path,
        diagnostics: [{
          code: "MOUNT_LOAD_FAILED", severity: "error",
          message: cause instanceof Error ? cause.message : "Corpus bundle failed to load.",
          context: { path: request.path, bundleError: code },
        }],
      },
    };
  }

  const manifestCorpus = loaded.snapshot.corpus;
  let declaredNamespace: string | undefined;
  let defaultProfile: string | undefined;
  if (request.declarationRoot !== undefined) {
    const declarationPath = join(request.declarationRoot, CORPUS_DECLARATION_FILE);
    const declaration = loadCorpusPackage(declarationPath);
    if (!declaration.ok) {
      return {
        ok: false,
        failure: {
          path: request.path,
          diagnostics: [{
            code: "MOUNT_DECLARATION_INVALID", severity: "error",
            message: `Corpus declaration failed to load: ${declaration.diagnostics.map(d => `${d.code}: ${d.message}`).join("; ")}`,
            context: { declaration: declarationPath },
          }],
        },
      };
    }
    declaredNamespace = declaration.value.declaration.namespace;
    defaultProfile = declaration.value.declaration.retrieval.defaultProfile;
    if (declaredNamespace !== manifestCorpus) {
      diagnostics.push({
        // Warning, not error: with `namespaceSource: "manifest"` the mount is
        // still correct and serving continues on the manifest's identity. The
        // divergence is reported so it cannot be discovered only by reading a
        // published URI.
        code: "MOUNT_NAMESPACE_MISMATCH", severity: "warning",
        message: "Corpus declaration and bundle manifest disagree about the corpus namespace.",
        context: { declared: declaredNamespace, manifest: manifestCorpus, namespaceSource: options.namespaceSource ?? "manifest" },
      });
    }
  }

  const namespace = options.namespaceSource === "declaration" && declaredNamespace !== undefined ? declaredNamespace : manifestCorpus;
  if (options.namespaceSource === "declaration" && !NAMESPACE.test(namespace)) {
    return {
      ok: false,
      failure: {
        path: request.path,
        diagnostics: [{
          code: "MOUNT_NAMESPACE_INVALID", severity: "error",
          message: "Corpus namespace is not a formal namespace.",
          context: { namespace, path: request.path },
        }],
      },
    };
  }

  return {
    ok: true,
    mount: {
      key: corpusMountKey(namespace, loaded.snapshot.release),
      namespace,
      release: loaded.snapshot.release,
      manifestCorpus,
      ...(declaredNamespace === undefined ? {} : { declaredNamespace }),
      path: resolve(request.path),
      loaded,
      ...(defaultProfile === undefined ? {} : { defaultProfile }),
      diagnostics,
    },
  };
}
