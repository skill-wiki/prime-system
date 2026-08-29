/**
 * `prime-corpus.yaml` loading and resolution.
 *
 * Two stages, kept apart on purpose:
 *
 * - `loadCorpusPackage` is pure syntax and self-consistency. It needs nothing but
 *   the file, so a corpus author gets its diagnostics without a model checkout.
 * - `resolveCorpusPackage` is the part that needs the outside world: which model
 *   versions actually exist, which retrieval profiles that model declares. This
 *   is where §13.5's "correct semver resolution" happens, and where a range that
 *   matches nothing becomes an error rather than an unread string.
 *
 * The split matters because the failure the repo already had was a *resolution*
 * failure disguised as a syntax success: `validateCorpusManifest` accepted any
 * non-empty version string and nothing downstream ever compared it to a real
 * model version.
 */
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  CorpusPackageDeclarationSchema,
  validateDeclarationSemantics,
  type CorpusPackageDeclaration,
} from "./schema.ts";
import { evaluateLicense, parseLicenseExpression, formatLicenseExpression, type LicenseExpression, type LicensePolicy } from "./license.ts";
import { parseRange, resolveVersion, type SemVer } from "./semver.ts";

export const CORPUS_DECLARATION_FILE = "prime-corpus.yaml";

export interface CorpusDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly subject?: string;
  readonly severity: "error" | "warning";
}

export type CorpusPackageLoadResult =
  | { readonly ok: true; readonly value: LoadedCorpusPackage; readonly diagnostics: readonly CorpusDiagnostic[] }
  | { readonly ok: false; readonly diagnostics: readonly CorpusDiagnostic[] };

export interface LoadedCorpusPackage {
  /** Directory containing `prime-corpus.yaml`, fully resolved. */
  readonly root: string;
  readonly path: string;
  readonly declaration: CorpusPackageDeclaration;
}

function error(code: string, message: string, subject?: string): CorpusDiagnostic {
  return { code, message, severity: "error", ...(subject === undefined ? {} : { subject }) };
}
function warning(code: string, message: string, subject?: string): CorpusDiagnostic {
  return { code, message, severity: "warning", ...(subject === undefined ? {} : { subject }) };
}

/** A declared root-relative path that stays inside the package and is not a link. */
function checkContainedPath(root: string, candidate: string, subject: string, diagnostics: CorpusDiagnostic[]): void {
  if (isAbsolute(candidate)) { diagnostics.push(error("PATH_NOT_RELATIVE", `declared path must be root-relative: ${candidate}`, subject)); return; }
  const absolute = resolve(root, candidate);
  const rel = relative(root, absolute);
  if (rel === "" || rel.split(sep).includes("..")) { diagnostics.push(error("PATH_ESCAPES_ROOT", `declared path escapes the corpus package: ${candidate}`, subject)); return; }
  if (!existsSync(absolute)) { diagnostics.push(error("PATH_NOT_FOUND", `declared path does not exist: ${candidate}`, subject)); return; }
  if (lstatSync(absolute).isSymbolicLink()) diagnostics.push(error("PATH_IS_SYMLINK", `declared path is a symbolic link: ${candidate}`, subject));
}

/**
 * Load and validate a `prime-corpus.yaml`. Declared paths are checked against
 * disk, so a corpus that claims a `sources/` or `eval/` it does not have fails
 * here rather than at retrieval time.
 */
export function loadCorpusPackage(path: string): CorpusPackageLoadResult {
  const absolute = resolve(path);
  if (!existsSync(absolute) || !lstatSync(absolute).isFile())
    return { ok: false, diagnostics: [error("CORPUS_DECLARATION_MISSING", `${CORPUS_DECLARATION_FILE} must name an existing regular file`, absolute)] };
  let document: unknown;
  try { document = parseYaml(readFileSync(absolute, "utf8")); }
  catch (cause) { return { ok: false, diagnostics: [error("YAML_PARSE_ERROR", cause instanceof Error ? cause.message : "YAML parsing failed", absolute)] }; }
  const parsed = CorpusPackageDeclarationSchema.safeParse(document);
  if (!parsed.success)
    return { ok: false, diagnostics: parsed.error.issues.map(issue => error("INVALID_CORPUS_DECLARATION", `${issue.path.join(".") || "<root>"}: ${issue.message}`, absolute)) };

  const declaration = parsed.data;
  const diagnostics: CorpusDiagnostic[] = validateDeclarationSemantics(declaration).map(problem => error(problem.code, problem.message, problem.subject));
  const root = realpathSync(resolve(absolute, ".."));
  for (const source of declaration.sources) if (source.path !== undefined) checkContainedPath(root, source.path, `source:${source.id}`, diagnostics);
  // Asset paths are not optional, so every one of them is checked. This is the
  // half of §8.3's `assets/` that can be verified without a compiler: bytes the
  // declaration promises to publish must actually be on disk here.
  for (const asset of declaration.assets) checkContainedPath(root, asset.path, `asset:${asset.id}`, diagnostics);
  for (const citation of declaration.citations) if (citation.path !== undefined) checkContainedPath(root, citation.path, `citation:${citation.id}`, diagnostics);
  if (declaration.eval.path !== undefined) checkContainedPath(root, declaration.eval.path, "eval", diagnostics);
  if (declaration.dist !== undefined) checkContainedPath(root, declaration.dist, "dist", diagnostics);

  if (diagnostics.some(diagnostic => diagnostic.severity === "error")) return { ok: false, diagnostics };
  return { ok: true, value: { root, path: absolute, declaration }, diagnostics };
}

export interface ResolvedModelBinding {
  readonly name: string;
  readonly versionRange: string;
  readonly required: boolean;
  /** The version chosen, or undefined when an optional binding matched nothing. */
  readonly resolved?: SemVer;
  /** Every satisfying candidate, highest first. */
  readonly candidates: readonly string[];
}

export interface ResolvedSourceLicense {
  readonly sourceId: string;
  readonly expression: LicenseExpression;
  readonly verdictOk: boolean;
  readonly verdictMessage?: string;
}

export interface ResolvedCorpusPackage {
  readonly declaration: CorpusPackageDeclaration;
  readonly models: readonly ResolvedModelBinding[];
  readonly licenses: readonly ResolvedSourceLicense[];
  /** Per-asset-set licence verdicts (§4.3's `assets/`), evaluated under the same policy. */
  readonly assetLicenses: readonly ResolvedSourceLicense[];
  /** Every distinct SPDX id the corpus's source AND asset sets mention, sorted. */
  readonly licenseIds: readonly string[];
  readonly effectiveProfile: string;
  readonly diagnostics: readonly CorpusDiagnostic[];
}

export interface ResolveCorpusOptions {
  /**
   * Model name → versions that exist. The caller supplies this because this
   * package must not know how a model registry is laid out on disk.
   */
  readonly availableModelVersions: Readonly<Record<string, readonly string[]>>;
  /**
   * Retrieval profile names the resolved model declares. A corpus may only pick
   * from these: a corpus that could name an unknown profile would be declaring
   * retrieval semantics, which §4.2 puts in the Model Package.
   */
  readonly declaredProfiles?: readonly string[];
}

/**
 * Resolve model version ranges and evaluate the licence policy.
 *
 * A `required` binding whose range matches nothing is an error — this is the
 * check that `validateCorpusManifest`'s non-empty-string test could never make.
 */
export function resolveCorpusPackage(
  declaration: CorpusPackageDeclaration,
  options: ResolveCorpusOptions,
): ResolvedCorpusPackage {
  const diagnostics: CorpusDiagnostic[] = [];
  const models: ResolvedModelBinding[] = [];
  for (const binding of declaration.models) {
    const available = options.availableModelVersions[binding.name] ?? [];
    let range;
    try { range = parseRange(binding.versionRange); }
    catch (cause) {
      diagnostics.push(error("MODEL_RANGE_INVALID", cause instanceof Error ? cause.message : String(cause), binding.name));
      models.push({ name: binding.name, versionRange: binding.versionRange, required: binding.required, candidates: [] });
      continue;
    }
    const resolution = resolveVersion(range, available);
    if (resolution.ok) {
      models.push({ name: binding.name, versionRange: binding.versionRange, required: binding.required, resolved: resolution.version, candidates: resolution.candidates.map(candidate => candidate.raw) });
      continue;
    }
    diagnostics.push(
      binding.required
        ? error("MODEL_VERSION_UNRESOLVED", `required model ${binding.name}: ${resolution.message}`, binding.name)
        : warning("OPTIONAL_MODEL_VERSION_UNRESOLVED", `optional model ${binding.name}: ${resolution.message}`, binding.name),
    );
    models.push({ name: binding.name, versionRange: binding.versionRange, required: binding.required, candidates: [] });
  }

  const policy: LicensePolicy = {
    allow: declaration.license.policy.allow,
    deny: declaration.license.policy.deny,
    requireDeclared: declaration.license.policy.requireDeclared,
    allowDisjunctiveEscape: declaration.license.policy.allowDisjunctiveEscape,
  };
  const licenses: ResolvedSourceLicense[] = [];
  const ids = new Set<string>();
  for (const source of declaration.sources) {
    const expression = parseLicenseExpression(source.license);
    for (const id of collectIds(expression)) ids.add(id);
    const verdict = evaluateLicense(expression, policy);
    licenses.push({
      sourceId: source.id, expression, verdictOk: verdict.ok,
      ...(verdict.ok ? {} : { verdictMessage: verdict.message }),
    });
    if (!verdict.ok) diagnostics.push(error(verdict.code, `source set ${source.id}: ${verdict.message}`, source.id));
  }
  // Assets go through the identical gate. Keeping them out of it was the shape
  // that let the licence hole exist in the first place: material the corpus
  // *publishes verbatim* is the material whose terms matter most, and it would
  // have been the one kind the policy never saw.
  const assetLicenses: ResolvedSourceLicense[] = [];
  for (const asset of declaration.assets) {
    const expression = parseLicenseExpression(asset.license);
    for (const id of collectIds(expression)) ids.add(id);
    const verdict = evaluateLicense(expression, policy);
    assetLicenses.push({
      sourceId: asset.id, expression, verdictOk: verdict.ok,
      ...(verdict.ok ? {} : { verdictMessage: verdict.message }),
    });
    if (!verdict.ok) diagnostics.push(error(verdict.code, `asset set ${asset.id}: ${verdict.message}`, asset.id));
  }
  const corpusExpression = parseLicenseExpression(declaration.license.expression);
  const corpusVerdict = evaluateLicense(corpusExpression, policy);
  if (!corpusVerdict.ok) diagnostics.push(error(corpusVerdict.code, `corpus license: ${corpusVerdict.message}`, declaration.namespace));
  // The corpus-level expression must actually cover what the declared material
  // carries — source sets and assets alike; otherwise the declared licence is a
  // claim rather than a summary.
  for (const id of [...ids].sort()) if (!collectIds(corpusExpression).includes(id))
    diagnostics.push(warning("CORPUS_LICENSE_INCOMPLETE", `declared material carries ${id} but the corpus license expression (${formatLicenseExpression(corpusExpression)}) does not mention it`, id));

  if (options.declaredProfiles !== undefined) {
    const declared = new Set(options.declaredProfiles);
    if (!declared.has(declaration.retrieval.defaultProfile))
      diagnostics.push(error("DEFAULT_PROFILE_NOT_DECLARED", `defaultProfile "${declaration.retrieval.defaultProfile}" is not a retrieval profile the model declares (declared: ${options.declaredProfiles.join(", ")})`, declaration.retrieval.defaultProfile));
    for (const name of declaration.retrieval.additionalProfiles) if (!declared.has(name))
      diagnostics.push(error("PROFILE_NOT_DECLARED", `retrieval profile "${name}" is not declared by the model`, name));
  }

  return {
    declaration, models, licenses, licenseIds: [...ids].sort(),
    assetLicenses,
    effectiveProfile: declaration.retrieval.defaultProfile,
    diagnostics,
  };
}

function collectIds(expression: LicenseExpression): readonly string[] {
  switch (expression.kind) {
    case "id": return [expression.id];
    case "and": case "or": return expression.operands.flatMap(collectIds);
    case "unparsable": return [];
  }
}
