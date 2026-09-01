/**
 * §4.3 Corpus Package declaration conformance.
 *
 * Distinct from `corpus-conformance.ts`, which validates corpus *content* (the
 * `kind: corpus` document with inline `units[]`). This suite validates the
 * *declaration* — the six things §4.3 says a Corpus Package must state — and it
 * is the half that did not exist: before `@aoe/corpus-schema` there was
 * no document in the repo where a licence, a default retrieval profile, a
 * publication policy or an eval set could be written, so there was nothing for a
 * suite to check.
 *
 * The two suites are deliberately not merged. A content corpus can be validated
 * without a declaration (an ad-hoc fixture), and a declaration must be
 * validatable before any content is compiled — that is the point of an input
 * declaration.
 */
import type { LoadedModel, ModelDefinition } from "@aoe/model-schema";
import {
  resolveCorpusPackage,
  type CorpusPackageDeclaration,
} from "@aoe/corpus-schema";
import { check, finding, report, skipped, type CheckOutcome, type Finding, type SuiteReport } from "./diagnostics.ts";

export interface CorpusDeclarationConformanceOptions {
  /**
   * Model name → versions that exist. When omitted, the supplied model's own
   * name/version is the only candidate — which is the single-model reality the
   * repo is in, and which still exercises real range resolution rather than
   * skipping it.
   */
  readonly availableModelVersions?: Readonly<Record<string, readonly string[]>>;
}

function retrievalProfileNames(model: LoadedModel): readonly string[] {
  return model.definitions
    .filter((definition: ModelDefinition) => definition.kind === "retrieval-profile")
    .map(definition => definition.name);
}

export function runCorpusDeclarationConformance(
  declaration: CorpusPackageDeclaration,
  model: LoadedModel,
  options: CorpusDeclarationConformanceOptions = {},
): SuiteReport {
  const availableModelVersions = options.availableModelVersions
    ?? { [model.manifest.name]: [model.manifest.version] };
  const declaredProfiles = retrievalProfileNames(model);
  const resolved = resolveCorpusPackage(declaration, { availableModelVersions, declaredProfiles });

  const only = (codes: readonly string[]): Finding[] =>
    resolved.diagnostics
      .filter(diagnostic => codes.includes(diagnostic.code))
      .map(diagnostic => finding(diagnostic.code, diagnostic.message, diagnostic.severity, diagnostic.subject === undefined ? {} : { subject: diagnostic.subject }));

  const modelBinding = check(
    "CD-MODEL-RANGE",
    "Every required model binding resolves a real version from its declared SemVer range",
    [
      ...only(["MODEL_RANGE_INVALID", "MODEL_VERSION_UNRESOLVED", "OPTIONAL_MODEL_VERSION_UNRESOLVED"]),
      // A range that resolves is only half the requirement: §13.5 asks for a
      // range, and an exact pin dressed as one hides the resolution entirely.
      ...declaration.models
        .filter(binding => /^[0-9]+\.[0-9]+\.[0-9]+$/.test(binding.versionRange.trim()))
        .map(binding => finding("MODEL_RANGE_IS_EXACT_PIN", `versionRange "${binding.versionRange}" is an exact pin, so no resolution can occur; use a range if any drift is acceptable`, "warning", { subject: binding.name })),
    ],
  );

  const provenance = check(
    "CD-PROVENANCE-LICENSE",
    "Every source set declares an origin and a licence the corpus policy permits",
    [
      ...only(["LICENSE_UNPARSABLE", "LICENSE_DENIED", "LICENSE_NOT_ALLOWED", "CORPUS_LICENSE_INCOMPLETE"]),
      ...declaration.sources
        .filter(source => source.unitCount === undefined)
        .map(source => finding("SOURCE_UNIT_COUNT_ABSENT", "source set declares no unitCount, so a reconciliation against the built bundle cannot be checked", "warning", { subject: source.id })),
    ],
  );

  const namespace = check(
    "CD-NAMESPACE",
    "Corpus namespace is a formal namespace, not a directory name",
    // The schema's own pattern is the gate; reaching this suite means it passed.
    // What is checked here is the thing the pattern cannot see: that the last
    // path segment is not simply the bundle directory it ships.
    declaration.dist !== undefined && declaration.namespace.split("/").pop() === declaration.dist.replace(/\/+$/, "").split("/").pop()
      ? [finding("NAMESPACE_ECHOES_DIST_DIR", `namespace's last segment equals the dist directory name (${declaration.dist}); a namespace must not be derived from a machine-local path`, "error", { subject: declaration.namespace })]
      : [],
  );

  const retrieval = check(
    "CD-RETRIEVAL-PROFILE",
    "Corpus-declared retrieval profiles are declared by the bound model",
    only(["DEFAULT_PROFILE_NOT_DECLARED", "PROFILE_NOT_DECLARED"]),
  );

  const publication = check(
    "CD-PUBLICATION",
    "Publication policy and visibility are self-consistent",
    [
      ...(declaration.publication.visibility === "public" && declaration.publication.channel === "latest"
        ? [finding("PUBLIC_FLOATING_CHANNEL", "a public corpus on the `latest` channel lets an unpinned consumer's results change without a release; §8.5 binds a run to one release", "warning", { subject: declaration.namespace })]
        : []),
    ],
  );

  const evalCheck = declaration.eval.goldenQueries.length === 0
    ? skipped("CD-EVAL", "Eval declares golden queries with resolvable expectations", "declaration carries no golden queries")
    : check(
      "CD-EVAL",
      "Eval declares golden queries with resolvable expectations",
      declaration.eval.goldenQueries.flatMap(golden =>
        golden.expectedUnitIds.length === 0
          ? [finding("GOLDEN_QUERY_NO_EXPECTATION", "golden query expects no unit ids, so it can never fail", "error", { subject: golden.name })]
          : []),
    );

  return report("corpus-declaration-conformance", `${declaration.namespace}@${declaration.version}`, [
    modelBinding, provenance, namespace, retrieval, publication, evalCheck,
  ]);
}
