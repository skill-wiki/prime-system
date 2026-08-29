/**
 * `prime-corpus.yaml` — the plan §4.3 Corpus Package declaration.
 *
 * This is the **input** declaration a corpus owner writes. It is not
 * `corpus.manifest.json`: that file's 12 fields are §8.4's Release Manifest, the
 * *output* identity the compiler stamps onto a built bundle
 * (`runtime/src/corpus-snapshot.ts` `CorpusManifest`). Before this module the
 * repo had only the output half, which is why four of §4.3's six required
 * declarations — licence, default retrieval profile, publication policy, eval —
 * had nowhere to be written at all, and were therefore absent from every
 * artifact rather than merely wrong in one.
 *
 * The six §4.3 declarations map onto this schema as:
 *
 * | §4.3 requirement                  | field            |
 * |-----------------------------------|------------------|
 * | which models, and version *range* | `models[]`       |
 * | data provenance and licence       | `sources[]`, `license` |
 * | corpus namespace                  | `namespace`      |
 * | default retrieval profile         | `retrieval`      |
 * | publication policy and visibility | `publication`    |
 * | eval and golden queries           | `eval`           |
 *
 * Every one of them is required, not optional. An optional declaration is how
 * the previous shape lost the licence: a field nobody must fill is a field the
 * producer silently omits.
 */
import { z } from "zod";
import { parseRange, SemVerError } from "./semver.ts";
import { parseLicenseExpression } from "./license.ts";

const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/**
 * A corpus namespace: `<authority>/<name>[/<name>…]`.
 *
 * The authority is a dotted, reverse-DNS-style label and the remainder is one or
 * more slash-separated names. The grammar exists to make a directory basename
 * *unrepresentable*: `compiled-v3-final` — the value currently sitting in
 * `manifest.corpus`, and therefore in every outward-facing
 * `prime://local/compiled-v3-final@…/units/…` URI — has no `/` and no dot in its
 * first segment, so it fails this pattern. That is deliberate. §11.3 puts the
 * corpus into the public URI, and a machine-local, renameable directory name is
 * not an identity that can survive being published.
 */
export const NAMESPACE = /^[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z0-9]+(?:[.-][a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/;

const NamespaceSchema = z.string().regex(
  NAMESPACE,
  "corpus namespace must be <dotted-authority>/<name>[/<name>…], e.g. org.example/frontend-design — a bare directory name is not a namespace",
);

/**
 * A model binding. `versionRange` is a range, validated by the real resolver in
 * `./semver.ts`; `resolveModelBindings` then picks the highest available match.
 */
export const ModelBindingSchema = z.object({
  name: z.string().min(1),
  versionRange: z.string().min(1).refine(value => {
    try { parseRange(value); return true; } catch (error) { return !(error instanceof SemVerError); }
  }, "must be a parsable SemVer range (exact, ^, ~, comparators, hyphen range, x-wildcard or ||)"),
  /**
   * Whether a resolution failure is fatal. A corpus may bind an optional
   * enrichment model, but the model it is *compiled against* is never optional.
   */
  required: z.boolean().default(true),
}).strict();

/**
 * One provenance record. `license` is required per source set — that is the fix
 * for the licence hole: there is no shape of this file in which a source set can
 * exist without stating what it may be redistributed under.
 */
export const SourceSetSchema = z.object({
  id: z.string().min(1),
  /** Where the material came from: a URL, a repository, or a prose provenance statement. */
  origin: z.string().min(1),
  /** Root-relative path inside the corpus package that holds this material. */
  path: z.string().min(1).optional(),
  /** SPDX expression. Mixed sets use `AND` / `OR`; unknown provenance must say `NOASSERTION`. */
  license: z.string().min(1),
  /** Free-text obligations that a bare SPDX id does not carry (attribution wording, notice files). */
  attribution: z.string().min(1).optional(),
  unitCount: z.number().int().nonnegative().optional(),
}).strict();

export const LicensePolicySchema = z.object({
  /** SPDX ids this corpus may redistribute. Empty list means every id is permitted. */
  allow: z.array(z.string().min(1)).default([]),
  deny: z.array(z.string().min(1)).default([]),
  requireDeclared: z.boolean().default(true),
  allowDisjunctiveEscape: z.boolean().default(false),
}).strict();

export const CorpusLicenseSchema = z.object({
  /** The effective SPDX expression for the corpus as a whole. */
  expression: z.string().min(1),
  policy: LicensePolicySchema.default({ allow: [], deny: [], requireDeclared: true, allowDisjunctiveEscape: false }),
}).strict();

/**
 * Corpus-side retrieval declaration.
 *
 * §4.3 gives the corpus a default retrieval profile, but `loadServeModel` reads
 * profiles only from the Model Package (`mcp-server-core/src/model-context.ts`),
 * so today the model is the only party that can name a default. `defaultProfile`
 * here is the corpus's override: the profile must still be *declared* by the
 * model — a corpus may choose among the model's profiles, never invent retrieval
 * semantics of its own, which would put domain policy back into corpus data.
 */
export const RetrievalSchema = z.object({
  defaultProfile: z.string().min(1),
  /** Additional model-declared profiles this corpus supports, beyond the default. */
  additionalProfiles: z.array(z.string().min(1)).default([]),
}).strict();

export const PublicationSchema = z.object({
  visibility: z.enum(["private", "internal", "public"]),
  /** `pinned` = consumers must name a release; `latest` = an unpinned mount may float. */
  channel: z.enum(["pinned", "latest", "prerelease"]),
  /** Whether a bundle must carry `signature.json` (§8.3) before it may be activated. */
  requireSignature: z.boolean(),
  /** Who may activate a release of this corpus. Free-form, checked by policy-engine, not here. */
  publishers: z.array(z.string().min(1)).default([]),
}).strict();

export const GoldenQuerySchema = z.object({
  name: z.string().min(1),
  /** The request as the query engine takes it. Opaque here on purpose: this package holds no engine. */
  request: z.record(z.string(), z.unknown()),
  expectedUnitIds: z.array(z.string().min(1)),
  expectedConflictCodes: z.array(z.string().min(1)).optional(),
}).strict();

export const EvalSchema = z.object({
  /** Root-relative directory holding eval material (§4.3's `eval/`). */
  path: z.string().min(1).optional(),
  goldenQueries: z.array(GoldenQuerySchema).min(1),
  /** Minimum fraction of golden queries that must pass for a release to be publishable. */
  minimumPassRate: z.number().min(0).max(1).default(1),
}).strict();

export const CorpusPackageDeclarationSchema = z.object({
  protocol: z.literal("prime/corpus/v2"),
  namespace: NamespaceSchema,
  version: z.string().regex(SEMVER, "must be strict SemVer"),
  /** Human-facing title. Never used as identity. */
  title: z.string().min(1),
  description: z.string().min(1),
  models: z.array(ModelBindingSchema).min(1),
  sources: z.array(SourceSetSchema).min(1),
  license: CorpusLicenseSchema,
  retrieval: RetrievalSchema,
  publication: PublicationSchema,
  eval: EvalSchema,
  /** Root-relative path of the built bundle this declaration describes (§4.3's `dist/`). */
  dist: z.string().min(1).optional(),
}).strict();

export type ModelBinding = z.infer<typeof ModelBindingSchema>;
export type SourceSet = z.infer<typeof SourceSetSchema>;
export type CorpusLicense = z.infer<typeof CorpusLicenseSchema>;
export type RetrievalDeclaration = z.infer<typeof RetrievalSchema>;
export type PublicationDeclaration = z.infer<typeof PublicationSchema>;
export type CorpusGoldenQuery = z.infer<typeof GoldenQuerySchema>;
export type EvalDeclaration = z.infer<typeof EvalSchema>;
export type CorpusPackageDeclaration = z.infer<typeof CorpusPackageDeclarationSchema>;

/** Semantic checks the zod shape cannot express, run after a successful parse. */
export function validateDeclarationSemantics(declaration: CorpusPackageDeclaration): readonly { code: string; message: string; subject?: string }[] {
  const problems: { code: string; message: string; subject?: string }[] = [];
  const modelNames = new Set<string>();
  for (const binding of declaration.models) {
    if (modelNames.has(binding.name)) problems.push({ code: "DUPLICATE_MODEL_BINDING", message: "a model is bound more than once", subject: binding.name });
    modelNames.add(binding.name);
  }
  if (!declaration.models.some(binding => binding.required))
    problems.push({ code: "NO_REQUIRED_MODEL", message: "at least one model binding must be required: a corpus with no mandatory model cannot be validated against anything" });

  const sourceIds = new Set<string>();
  for (const source of declaration.sources) {
    if (sourceIds.has(source.id)) problems.push({ code: "DUPLICATE_SOURCE_SET", message: "a source set id appears more than once", subject: source.id });
    sourceIds.add(source.id);
    if (declaration.license.policy.requireDeclared && parseLicenseExpression(source.license).kind === "unparsable")
      problems.push({ code: "SOURCE_LICENSE_UNPARSABLE", message: `license "${source.license}" is not an SPDX expression and requireDeclared is true`, subject: source.id });
  }
  if (parseLicenseExpression(declaration.license.expression).kind === "unparsable" && declaration.license.policy.requireDeclared)
    problems.push({ code: "CORPUS_LICENSE_UNPARSABLE", message: `corpus license "${declaration.license.expression}" is not an SPDX expression and requireDeclared is true` });

  const profiles = new Set(declaration.retrieval.additionalProfiles);
  if (profiles.has(declaration.retrieval.defaultProfile))
    problems.push({ code: "DEFAULT_PROFILE_REPEATED", message: "defaultProfile must not also be listed in additionalProfiles", subject: declaration.retrieval.defaultProfile });

  const goldenNames = new Set<string>();
  for (const golden of declaration.eval.goldenQueries) {
    if (goldenNames.has(golden.name)) problems.push({ code: "DUPLICATE_GOLDEN_QUERY", message: "a golden query name appears more than once", subject: golden.name });
    goldenNames.add(golden.name);
  }
  if (declaration.publication.visibility === "public" && !declaration.publication.requireSignature)
    problems.push({ code: "PUBLIC_WITHOUT_SIGNATURE", message: "a publicly visible corpus must require a signature: §8.4 lists signature and publication policy among the boot checks" });
  if (declaration.publication.channel === "pinned" && declaration.publication.visibility === "public" && declaration.publication.publishers.length === 0)
    problems.push({ code: "NO_PUBLISHER", message: "a pinned public corpus names no publisher, so nothing constrains who may activate a release" });
  return problems;
}
