/**
 * Plugin Manifest schema (plan §12.1) and its loader.
 *
 * The manifest is the plugin's *published claim*: what it provides, what it
 * needs, and how it agrees to be confined. It is data, validated strictly, and
 * it is the only thing the host reads before deciding whether any of the
 * plugin's code will ever be loaded — see `trust.ts` for why that ordering is
 * the §12.3 invariant rather than a preference.
 *
 * Two fields go beyond the §12.1 example, and both are load-bearing rather than
 * decoration:
 *
 * - `entry`: §12.1 does not show one, but §12.2 has a lifecycle that must
 *   `initialize` something. Without a declared entry the host would have to
 *   *infer* which file to execute (a `main` field, an `index.ts`), and inference
 *   is exactly how Model/Corpus data acquires implicit code execution. It is
 *   root-relative and crosses `resolveInRoot` before use.
 * - `signature`: §12.2 lists `verify signature` as a lifecycle step, which
 *   cannot happen against a manifest with nowhere to put one.
 *
 * `provides`, `capabilities` and `sandbox.mode` are all **open vocabularies**.
 * §3.5 lists five categories that legitimately need code (connector, reranker,
 * validator, side-effect Action Provider, renderer) and §12.1 shows two example
 * capabilities; encoding either list as a union here would put the engine in the
 * business of knowing the extension taxonomy, and every new adapter would need
 * an engine edit. What the host accepts is host *configuration* (see
 * `HostPolicy`), which is deny-by-default and therefore safe to keep open.
 */

import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
import { isWellFormedCapability } from "./capabilities.ts";
import { resolveInRoot } from "./paths.ts";

const semver = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const SemVer = z.string().regex(semver, "must be strict SemVer");

/** `<role>:<id>`, e.g. `action-executor:http`. Role vocabulary intentionally open. */
const PROVIDES_SHAPE = /^[a-z0-9][a-z0-9.-]*:[a-z0-9][a-z0-9.-]*$/;

/**
 * `filesystem: none` in §12.1 is the default and the floor. The object form
 * exists because a renderer legitimately needs to read its own templates; the
 * roots are bundle-relative and every read still crosses `resolveInRoot`, so the
 * widest thing this field can express is "somewhere inside my own bundle".
 */
const FilesystemPolicy = z.union([
  z.literal("none"),
  z.object({ readRoots: z.array(z.string().min(1)).min(1) }).strict(),
]);

const Sandbox = z.object({
  /**
   * Free string, not an enum: §3.5 names process/Worker/container/WASI and more
   * will exist. The host refuses a mode it has no executor for — it never falls
   * back to running the plugin in its own process, which is the one fallback
   * that would silently void the whole isolation model.
   */
  mode: z.string().min(1),
  filesystem: FilesystemPolicy.default("none"),
  networkAllowlist: z.array(z.string().min(1)).default([]),
  /** Wall-clock ceiling per call. A plugin that hangs must not hang the host. */
  timeoutMs: z.number().int().positive().default(5_000),
}).strict();

const Signature = z.object({
  algorithm: z.string().min(1),
  /** Digest of the plugin's own files, `<alg>:<hex>`. */
  digest: z.string().regex(/^[a-z0-9-]+:[0-9a-f]{16,}$/, "must be <algorithm>:<hex digest>"),
  value: z.string().min(1),
  keyId: z.string().min(1).optional(),
}).strict();

export const PluginManifestSchema = z.object({
  protocol: z.literal("prime/plugin/v1"),
  name: z.string().min(1),
  version: SemVer,
  apiVersion: z.number().int().positive(),
  provides: z.array(z.string().regex(PROVIDES_SHAPE, "must be <role>:<id>")).min(1),
  /**
   * `capabilities:` written with nothing under it parses as YAML null, and an
   * author who writes that means "none". Reading it as the empty set is the
   * deny-by-default direction, so tolerating it here cannot widen anything; the
   * alternative is a schema error whose message is about types rather than about
   * the plugin.
   */
  capabilities: z.array(z.string().refine(isWellFormedCapability, "must be ns:verb[:qualifier]")).nullish().transform(value => value ?? []),
  sandbox: Sandbox,
  /** Root-relative module the sandbox loads. Never inferred; see the file header. */
  entry: z.string().min(1),
  signature: Signature.optional(),
  dependencies: z.record(z.string().min(1), z.string().min(1)).default({}),
  description: z.string().optional(),
}).strict();

export type PluginManifest = z.infer<typeof PluginManifestSchema>;
export type SandboxPolicy = z.infer<typeof Sandbox>;
export type PluginSignature = z.infer<typeof Signature>;

export interface ManifestDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}

export type ManifestParse =
  | { readonly ok: true; readonly manifest: PluginManifest }
  | { readonly ok: false; readonly diagnostics: readonly ManifestDiagnostic[] };

export type ManifestLoad =
  | { readonly ok: true; readonly manifest: PluginManifest; readonly root: string; readonly entryPath: string }
  | { readonly ok: false; readonly diagnostics: readonly ManifestDiagnostic[] };

/** The manifest file name inside a plugin directory. */
export const MANIFEST_FILENAME = "prime-plugin.yaml";

export function parseManifest(source: string): ManifestParse {
  let raw: unknown;
  try {
    raw = parse(source);
  } catch (error) {
    return { ok: false, diagnostics: [{ code: "MANIFEST_YAML_INVALID", message: error instanceof Error ? error.message : "YAML parsing failed" }] };
  }
  const parsed = PluginManifestSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      diagnostics: parsed.error.issues.map(issue => ({
        code: "MANIFEST_SCHEMA_INVALID",
        message: `${issue.path.join(".") || "(root)"}: ${issue.message}`,
      })),
    };
  }
  return { ok: true, manifest: parsed.data };
}

/**
 * Load and validate the manifest of one plugin directory, and contain its entry
 * path. A plugin whose entry escapes its own root is refused here, before the
 * lifecycle ever reaches `initialize` — the refusal is not "the file is missing"
 * but "the plugin tried to name a file it does not own".
 */
export function loadManifest(pluginRoot: string): ManifestLoad {
  const manifestPath = resolveInRoot(pluginRoot, MANIFEST_FILENAME, "file");
  if (!manifestPath.ok) {
    return { ok: false, diagnostics: [{ code: `MANIFEST_${manifestPath.code}`, message: manifestPath.reason, path: MANIFEST_FILENAME }] };
  }
  let source: string;
  try {
    source = readFileSync(manifestPath.absolutePath, "utf8");
  } catch (error) {
    return { ok: false, diagnostics: [{ code: "MANIFEST_UNREADABLE", message: error instanceof Error ? error.message : "read failed", path: MANIFEST_FILENAME }] };
  }
  const parsed = parseManifest(source);
  if (!parsed.ok) return parsed;

  const entry = resolveInRoot(pluginRoot, parsed.manifest.entry, "file");
  if (!entry.ok) {
    return { ok: false, diagnostics: [{ code: `ENTRY_${entry.code}`, message: entry.reason, path: parsed.manifest.entry }] };
  }
  // Every declared filesystem read root is contained at load time too, so a
  // plugin cannot be admitted now and discovered to be out of bounds mid-call.
  const badRoot = parsed.manifest.sandbox.filesystem === "none"
    ? undefined
    : parsed.manifest.sandbox.filesystem.readRoots
        .map(r => ({ r, res: resolveInRoot(pluginRoot, r, "any") }))
        .find(x => !x.res.ok);
  if (badRoot !== undefined && !badRoot.res.ok) {
    return { ok: false, diagnostics: [{ code: `FILESYSTEM_ROOT_${badRoot.res.code}`, message: badRoot.res.reason, path: badRoot.r }] };
  }

  return { ok: true, manifest: parsed.manifest, root: pluginRoot, entryPath: entry.absolutePath };
}
