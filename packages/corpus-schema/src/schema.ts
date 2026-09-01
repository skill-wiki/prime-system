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
 * | data provenance and licence       | `sources[]`, `assets[]`, `citations[]`, `license` |
 * | corpus namespace                  | `namespace`      |
 * | default retrieval profile         | `retrieval`      |
 * | publication policy and visibility | `publication`    |
 * | eval and golden queries           | `eval`           |
 *
 * §4.3's package layout is `sources/ assets/ citations/ eval/ dist/`, and each of
 * those five now has a declaration that names it. The three provenance kinds are
 * deliberately three fields rather than one, because §8.3 gives them three
 * different fates in the built bundle: sources compile into `units.pack`, assets
 * are copied into the bundle's own `assets/`, and citations appear nowhere in
 * §8.3 at all because the material is never redistributed. See `AssetSetSchema`
 * and `CitationSchema`.
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
 * *unrepresentable*: `compiled-v3-final` — the value that used to sit in
 * `manifest.corpus`, and therefore in every outward-facing
 * `aoe://local/compiled-v3-final@…/units/…` URI — has no `/` and no dot in its
 * first segment, so it fails this pattern. That is deliberate. §11.3 puts the
 * corpus into the public URI, and a machine-local, renameable directory name is
 * not an identity that can survive being published. Since the namespace cutover
 * this pattern is enforced at mount time (`mountCorpus`, `MOUNT_NAMESPACE_INVALID`)
 * rather than only describing an aspiration.
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

/**
 * One asset set — §4.3's `assets/`.
 *
 * Kept separate from `sources[]` because §8.3 treats the two differently: the
 * CorpusBundle layout has an `assets/` directory and no `sources/` one. Source
 * material is *compiled away* into `units.pack`/`projections/`, while an asset is
 * copied through as bytes and is still there to be served after the compile. So
 * an asset is the only declared material a consumer can receive verbatim, which
 * is why `path` is required here but optional on a source set: a set of bytes
 * that ships must say where the bytes are.
 *
 * `license` is required for the same reason it is on a source set, and it bites
 * harder: an asset is redistributed as-is, so its terms cannot be diluted by the
 * DSL re-encoding argument that covers a transcribed source.
 */
export const AssetSetSchema = z.object({
  id: z.string().min(1),
  /** Root-relative path inside the corpus package. Required: an asset is bytes on disk. */
  path: z.string().min(1),
  /**
   * What kind of bytes, so a consumer can decide whether it can serve them at
   * all. Closed on purpose — an open string here would make `assets/` a second
   * uncheckable dumping ground next to `sources/`.
   */
  kind: z.enum(["image", "font", "video", "audio", "archive", "data", "binary"]),
  /** SPDX expression covering the bytes as redistributed. `NOASSERTION` if genuinely unknown. */
  license: z.string().min(1),
  attribution: z.string().min(1).optional(),
  /**
   * Whether these bytes are emitted into the bundle's §8.3 `assets/`. `false`
   * declares build-time-only material (a source PSD, an unminified original)
   * that is tracked and licence-checked but never published.
   */
  emit: z.boolean().default(true),
  fileCount: z.number().int().nonnegative().optional(),
}).strict();

/**
 * One citation — §4.3's `citations/`.
 *
 * The distinguishing fact, and the reason this is not just another source set:
 * **§8.3's CorpusBundle has no `citations/` directory.** Assets ship, sources
 * compile into the bundle, citations do neither. A citation names an external
 * work the corpus *restates without redistributing* — the shape the `@w3c` and
 * `@nielsen` units already have, where the atom carries an `attributed_to:` URL
 * and the material itself stays with its copyright holder. Nothing here is
 * emitted; a citation is an obligation and a provenance record.
 *
 * That is also why `license` is absent from this shape and present on the other
 * two. A licence answers "under what terms may I pass these bytes on", and the
 * answer for a citation is "you may not, because they are not here". The terms
 * that do apply belong to the *source set* that does the restating, which is
 * what `appliesTo` points back at — the two `LicenseRef-*-Citation-Only` ids in
 * this repo's declaration are exactly that, and today they carry the citation as
 * prose in `attribution` because there was no field for it.
 */
export const CitationSchema = z.object({
  id: z.string().min(1),
  /** The cited work as a human would name it, e.g. "Web Content Accessibility Guidelines (WCAG) 2.2". */
  work: z.string().min(1),
  /** Who holds rights in the cited work. Required: an unattributed citation is not one. */
  rightsHolder: z.string().min(1),
  /**
   * Canonical online location, when the work has one.
   *
   * Optional, and the reason is in this repo's own data: `@nielsen/source-nielsen-1994`
   * cites a printed book by ISBN. Requiring a URL would have forced either a
   * fabricated link or a dropped citation, so a locator is required in the
   * *semantics* (`url` or `identifier`, checked in `validateDeclarationSemantics`)
   * rather than by making one of the two shapes mandatory here.
   */
  url: z.string().url().optional(),
  /** A non-URL locator: `isbn:978-0125184069`, `doi:10.1145/191666.191729`, `w3c:REC-wcag22`. */
  identifier: z.string().min(1).optional(),
  /**
   * When the cited text was read. Meaningful for a living document, meaningless
   * for a 1994 book — so this or `publishedOn` is required, not both.
   */
  retrievedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be an ISO-8601 calendar date").optional(),
  /** When the cited edition was published: `YYYY`, `YYYY-MM` or `YYYY-MM-DD`. */
  publishedOn: z.string().regex(/^\d{4}(?:-\d{2}(?:-\d{2})?)?$/, "must be YYYY, YYYY-MM or YYYY-MM-DD").optional(),
  /**
   * `sources[].id` values whose units restate this work. Cross-checked in
   * `validateDeclarationSemantics`: a citation nothing relies on, or one that
   * names a source set that does not exist, is a dangling obligation.
   */
  appliesTo: z.array(z.string().min(1)).min(1),
  /** Root-relative path holding local citation records, if the package keeps any. */
  path: z.string().min(1).optional(),
  /** How the corpus uses the work: a restatement is not a quotation. */
  use: z.enum(["restatement", "quotation", "reference"]),
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
  /**
   * §4.3's `assets/`. Defaults to empty rather than being required: a corpus of
   * pure text legitimately ships no bytes, and forcing `assets: []` to be written
   * out would make the field noise. `sources` is `.min(1)` because the opposite
   * is true there — a corpus with no material is not a corpus.
   */
  assets: z.array(AssetSetSchema).default([]),
  /** §4.3's `citations/`. Empty is legitimate: a wholly original corpus cites nothing. */
  citations: z.array(CitationSchema).default([]),
  license: CorpusLicenseSchema,
  retrieval: RetrievalSchema,
  publication: PublicationSchema,
  eval: EvalSchema,
  /** Root-relative path of the built bundle this declaration describes (§4.3's `dist/`). */
  dist: z.string().min(1).optional(),
}).strict();

export type ModelBinding = z.infer<typeof ModelBindingSchema>;
export type SourceSet = z.infer<typeof SourceSetSchema>;
export type AssetSet = z.infer<typeof AssetSetSchema>;
export type Citation = z.infer<typeof CitationSchema>;
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

  // Assets are checked against the same licence bar as sources, and one step
  // further: `path` collisions matter here in a way they do not for sources,
  // because two asset sets that emit the same directory would each claim their
  // own terms over the same published bytes.
  const assetIds = new Set<string>();
  const emittedPaths = new Map<string, string>();
  for (const asset of declaration.assets) {
    if (assetIds.has(asset.id)) problems.push({ code: "DUPLICATE_ASSET_SET", message: "an asset set id appears more than once", subject: asset.id });
    assetIds.add(asset.id);
    if (sourceIds.has(asset.id)) problems.push({ code: "ASSET_ID_COLLIDES_WITH_SOURCE", message: "an asset set and a source set share an id, so a licence finding cannot name which one it is about", subject: asset.id });
    if (declaration.license.policy.requireDeclared && parseLicenseExpression(asset.license).kind === "unparsable")
      problems.push({ code: "ASSET_LICENSE_UNPARSABLE", message: `license "${asset.license}" is not an SPDX expression and requireDeclared is true`, subject: asset.id });
    if (!asset.emit) continue;
    const claimant = emittedPaths.get(asset.path);
    if (claimant !== undefined)
      problems.push({ code: "ASSET_PATH_CLAIMED_TWICE", message: `two emitted asset sets claim ${asset.path}, so the licence of the published bytes is ambiguous (also claimed by ${claimant})`, subject: asset.id });
    else emittedPaths.set(asset.path, asset.id);
  }

  // A citation is an obligation, so both ends must exist: an obligation attached
  // to a source set that is not declared cannot be discharged, and a source set
  // is the only thing that can carry one.
  const citationIds = new Set<string>();
  for (const citation of declaration.citations) {
    if (citationIds.has(citation.id)) problems.push({ code: "DUPLICATE_CITATION", message: "a citation id appears more than once", subject: citation.id });
    citationIds.add(citation.id);
    for (const target of citation.appliesTo) if (!sourceIds.has(target))
      problems.push({ code: "CITATION_TARGET_UNKNOWN", message: `citation applies to source set "${target}", which is not declared`, subject: citation.id });
    // A citation a reader cannot follow is not a citation. Either shape of
    // locator satisfies this; neither does not.
    if (citation.url === undefined && citation.identifier === undefined)
      problems.push({ code: "CITATION_NOT_LOCATABLE", message: "a citation must carry a url or an identifier, or a reader cannot reach the cited work", subject: citation.id });
    // And a restatement is only checkable against a fixed version of the work.
    if (citation.retrievedAt === undefined && citation.publishedOn === undefined)
      problems.push({ code: "CITATION_NOT_ANCHORED", message: "a citation must carry retrievedAt or publishedOn: a restatement can only be checked against a fixed version of the cited work", subject: citation.id });
  }

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
