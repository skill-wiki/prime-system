/**
 * @module @skill-wiki/corpus-schema
 *
 * The plan §4.3 Corpus Package declaration — schema, loader and resolution.
 *
 * Why this is not folded into `@skill-wiki/model-schema`: the two packages hold
 * two different documents with two different authors. A Model Package (§4.2)
 * declares *semantics* — types, relations, projections, retrieval profiles — and
 * is written by whoever owns the domain vocabulary. A Corpus Package (§4.3)
 * declares *a body of content and the terms it may be served under* — which model
 * it binds to and in what version range, where the material came from, what
 * licence it carries, what namespace it publishes into, how it is released. A
 * corpus consumes a model; the reverse edge does not exist. Merging them would
 * make `model-schema` depend on licence and publication concepts that no model
 * has, and would put the corpus's model *binding* inside the thing it binds to.
 *
 * Components:
 * - `semver`  — SemVer parsing, comparison and range resolution (§13.5)
 * - `license` — SPDX expression parsing and corpus licence policy evaluation
 * - `schema`  — the `prime-corpus.yaml` zod shape and its semantic checks
 * - `loader`  — file loading, on-disk path validation, and resolution against a model
 */

export {
  parseSemVer,
  tryParseSemVer,
  compareSemVer,
  parseRange,
  satisfies,
  resolveVersion,
  SemVerError,
  type SemVer,
  type VersionRange,
  type Resolution,
  type ResolutionSuccess,
  type ResolutionFailure,
} from "./semver.ts";

export {
  parseLicenseExpression,
  formatLicenseExpression,
  licenseIdentifiers,
  evaluateLicense,
  type LicenseExpression,
  type LicensePolicy,
  type LicenseVerdict,
} from "./license.ts";

export {
  NAMESPACE,
  CorpusPackageDeclarationSchema,
  ModelBindingSchema,
  SourceSetSchema,
  AssetSetSchema,
  CitationSchema,
  LicensePolicySchema,
  CorpusLicenseSchema,
  RetrievalSchema,
  PublicationSchema,
  GoldenQuerySchema,
  EvalSchema,
  validateDeclarationSemantics,
  type CorpusPackageDeclaration,
  type ModelBinding,
  type SourceSet,
  type AssetSet,
  type Citation,
  type CorpusLicense,
  type RetrievalDeclaration,
  type PublicationDeclaration,
  type CorpusGoldenQuery,
  type EvalDeclaration,
} from "./schema.ts";

export {
  CORPUS_DECLARATION_FILE,
  loadCorpusPackage,
  resolveCorpusPackage,
  type CorpusDiagnostic,
  type CorpusPackageLoadResult,
  type LoadedCorpusPackage,
  type ResolvedCorpusPackage,
  type ResolvedModelBinding,
  type ResolvedSourceLicense,
  type ResolveCorpusOptions,
} from "./loader.ts";
