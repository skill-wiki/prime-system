import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { loadModel } from "@skill-wiki/model-schema";
import { loadCorpusPackage } from "@skill-wiki/corpus-schema";
import { formatReport } from "./diagnostics.ts";
import { runModelConformance } from "./model-conformance.ts";
import { loadCorpus } from "./corpus.ts";
import { runCorpusConformance } from "./corpus-conformance.ts";
import { runBundleConformance } from "./bundle-conformance.ts";
import { runCorpusDeclarationConformance } from "./corpus-declaration-conformance.ts";
import { corpusFromV1Sources } from "./corpus-adapter.ts";
import { closedSetCheck, domainScanCheck, formatDomainScan, loadVocabulary, mergeVocabularies, scanDomainSemantics, vocabularyFromModel, type Vocabulary } from "./domain-scan.ts";
import { buildPackageGraph, formatPackageGraph, packageWiringCheck } from "./package-graph.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "..");
const REPO_ROOT = resolve(PACKAGE_ROOT, "..", "..");

const USAGE = `prime testkit

  bun packages/testkit/src/cli.ts model  <model-root> [--allow-empty-type-shells]
  bun packages/testkit/src/cli.ts corpus <model-root> <corpus.yaml> [--licenses=A,B] [--require-citations]
                                         (a prime-corpus.yaml declaration runs the §4.3 declaration suite;
                                          a kind: corpus document runs the §17.2 content suite)
  bun packages/testkit/src/cli.ts corpus-v1 <model-root> <sources-dir> [--name=N] [--citation-fields=a,b] [--licenses=A,B]
  bun packages/testkit/src/cli.ts bundle <bundle-dir> [--licenses=A,B] [--license-field=key]
                                         (artifact-level: the COMPILED bundle, not its source)
  bun packages/testkit/src/cli.ts scan   [--roots=dir,dir] [--model=<model-root>] [--vocabulary=file.yaml]
                                         [--markdown] [--max-rows=N] [--all-hits] [--closed-sets]
  bun packages/testkit/src/cli.ts wiring [--packages=dir] [--markdown]

Exit code is 1 when any check fails.`;

function flag(argv: readonly string[], name: string): boolean { return argv.includes(`--${name}`); }
function option(argv: readonly string[], name: string): string | undefined {
  const hit = argv.find(a => a.startsWith(`--${name}=`));
  return hit === undefined ? undefined : hit.slice(name.length + 3);
}
function list(argv: readonly string[], name: string): readonly string[] {
  const raw = option(argv, name);
  return raw === undefined ? [] : raw.split(",").map(s => s.trim()).filter(s => s.length > 0);
}

function defaultScanRoots(): readonly string[] {
  const packages = join(REPO_ROOT, "packages");
  if (!existsSync(packages)) return [];
  return readdirSync(packages, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => join(packages, e.name, "src"))
    .filter(existsSync)
    .sort();
}

/** Default vocabulary: every name the v1 compatibility model declares, plus the frontend axes. */
export function defaultVocabulary(modelRoot?: string): Vocabulary {
  const files = [
    join(PACKAGE_ROOT, "fixtures", "domain-vocabulary", "generic-programming-terms.yaml"),
    join(PACKAGE_ROOT, "fixtures", "domain-vocabulary", "frontend-axes.yaml"),
  ].filter(existsSync).map(loadVocabulary);
  const root = modelRoot ?? join(REPO_ROOT, "compat", "prime-v1-model");
  const loaded = existsSync(root) ? loadModel(root) : undefined;
  // `vocabularyFromModel` rather than an inline literal: it is what carries the
  // relation/type roles the closed-set check reads, and those roles must come
  // from the model, never from a list in engine source.
  const fromModel: readonly Vocabulary[] = loaded !== undefined && loaded.ok ? [vocabularyFromModel(loaded.value)] : [];
  return mergeVocabularies(...fromModel, ...files);
}

function runModel(argv: readonly string[]): number {
  const root = argv[0];
  if (root === undefined) { console.error(USAGE); return 2; }
  const result = runModelConformance(resolve(root), { allowEmptyTypeShells: flag(argv, "allow-empty-type-shells") });
  console.log(formatReport(result));
  return result.status === "fail" ? 1 : 0;
}

/**
 * `corpus` accepts either of the two documents that legitimately live in a
 * `.yaml` a corpus owner points at: the §4.3 *declaration*
 * (`protocol: prime/corpus/v2`) or a content corpus (`kind: corpus`). Dispatch
 * is on the document's own protocol marker rather than on a flag, because the two
 * are distinguishable from their contents and a flag would let a caller run the
 * wrong suite and read its pass as coverage of the other.
 */
function runCorpus(argv: readonly string[]): number {
  const [modelRoot, corpusPath] = argv;
  if (modelRoot === undefined || corpusPath === undefined) { console.error(USAGE); return 2; }
  const model = loadModel(resolve(modelRoot));
  if (!model.ok) { console.error(`model failed to load:\n${model.diagnostics.map(d => `  ${d.code}: ${d.message}`).join("\n")}`); return 1; }

  const resolvedCorpusPath = resolve(corpusPath);
  if (declaresCorpusPackage(resolvedCorpusPath)) {
    const declaration = loadCorpusPackage(resolvedCorpusPath);
    if (!declaration.ok) { console.error(`corpus declaration failed to load:\n${declaration.diagnostics.map(d => `  ${d.code}: ${d.message}`).join("\n")}`); return 1; }
    const result = runCorpusDeclarationConformance(declaration.value.declaration, model.value);
    console.log(formatReport(result));
    return result.status === "fail" ? 1 : 0;
  }

  const corpus = loadCorpus(resolvedCorpusPath);
  if (!corpus.ok) { console.error(`corpus failed to load:\n${corpus.diagnostics.map(d => `  ${d.code}: ${d.message}`).join("\n")}`); return 1; }
  const licenses = list(argv, "licenses");
  const result = runCorpusConformance(corpus.value, model.value, {
    allowedLicenses: licenses.length > 0 ? licenses : undefined,
    requireCitationForAllTypes: flag(argv, "require-citations"),
  });
  console.log(formatReport(result));
  return result.status === "fail" ? 1 : 0;
}

/** Peek at the document's protocol marker without committing to either schema. */
function declaresCorpusPackage(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    const document: unknown = parseYaml(readFileSync(path, "utf8"));
    return document !== null && typeof document === "object" && !Array.isArray(document)
      && (document as Record<string, unknown>)["protocol"] === "prime/corpus/v2";
  } catch { return false; }
}

function runScan(argv: readonly string[]): number {
  const explicitRoots = list(argv, "roots").map(r => resolve(r));
  const extra = list(argv, "vocabulary").map(v => loadVocabulary(resolve(v)));
  const vocabulary = mergeVocabularies(defaultVocabulary(option(argv, "model")), ...extra);
  const scan = scanDomainSemantics({
    roots: explicitRoots.length > 0 ? explicitRoots : defaultScanRoots(),
    vocabulary,
    reportRoot: REPO_ROOT,
    // Only a default-rooted run has looked at the whole workspace, and only then
    // can "this exemption matched nothing" mean the exemption has rotted rather
    // than that its sites are simply outside the roots.
    completeScan: explicitRoots.length === 0,
  });
  const outcome = domainScanCheck(scan);
  const closedSets = closedSetCheck(scan);
  if (flag(argv, "markdown") || flag(argv, "closed-sets")) {
    const maxRows = option(argv, "max-rows");
    console.log(formatDomainScan(scan, {
      onlyDistinctive: !flag(argv, "all-hits"),
      onlyClosedSets: flag(argv, "closed-sets"),
      maxRows: maxRows === undefined ? undefined : Number(maxRows),
    }));
    console.log("");
  }
  const checks = [outcome, closedSets];
  const failed = checks.filter(c => c.status === "fail").length;
  console.log(formatReport({
    suite: "zero-domain-semantics", subject: vocabulary.name, status: failed > 0 ? "fail" : "pass",
    checks, counts: { pass: checks.length - failed, fail: failed, skip: 0 },
    errorCount: checks.flatMap(c => c.findings).filter(f => f.severity === "error").length,
    warningCount: checks.flatMap(c => c.findings).filter(f => f.severity === "warning").length,
  }));
  return failed > 0 ? 1 : 0;
}

function runCorpusV1(argv: readonly string[]): number {
  const [modelRoot, sourcesDir] = argv;
  if (modelRoot === undefined || sourcesDir === undefined) { console.error(USAGE); return 2; }
  const model = loadModel(resolve(modelRoot));
  if (!model.ok) { console.error(`model failed to load:\n${model.diagnostics.map(d => `  ${d.code}: ${d.message}`).join("\n")}`); return 1; }
  const { corpus, rejected } = corpusFromV1Sources({
    sourcesDir: resolve(sourcesDir),
    model: model.value,
    name: option(argv, "name") ?? "v1-corpus",
    citationFields: list(argv, "citation-fields"),
  });
  console.log(`adapted ${corpus.units.length} unit(s) from ${resolve(sourcesDir)}; rejected ${rejected.length}`);
  for (const r of rejected) console.log(`  rejected ${r.path}: ${r.reason}`);
  const licenses = list(argv, "licenses");
  const result = runCorpusConformance(corpus, model.value, {
    allowedLicenses: licenses.length > 0 ? licenses : undefined,
    requireCitationForAllTypes: flag(argv, "require-citations"),
  });
  console.log(formatReport(result));
  return result.status === "fail" ? 1 : 0;
}

/**
 * `bundle` audits the artifact, not the input. `corpus` and `corpus-v1` both
 * read sources, so nothing checked the directory that actually ships — see
 * `bundle-conformance.ts` for the three divergences only the artifact shows.
 * It takes no model root on purpose: a compiled bundle records the model it was
 * built against, and re-resolving one here would let the suite pass a bundle
 * against a model it was never compiled with.
 */
function runBundle(argv: readonly string[]): number {
  const [bundleDir] = argv;
  if (bundleDir === undefined) { console.error(USAGE); return 2; }
  const licenses = list(argv, "licenses");
  const licenseField = option(argv, "license-field");
  const result = runBundleConformance(resolve(bundleDir), {
    ...(licenses.length > 0 ? { allowedLicenses: licenses } : {}),
    ...(licenseField === undefined ? {} : { licenseField }),
  });
  console.log(formatReport(result));
  return result.status === "fail" ? 1 : 0;
}

/**
 * Kept as its own suite rather than folded into `scan`: it answers a different
 * question (is this code reached?) from a different input (the manifests and the
 * package graph, not a vocabulary), and merging them would hide one behind the
 * other's exit code.
 */
function runWiring(argv: readonly string[]): number {
  const graph = buildPackageGraph({
    packagesDir: option(argv, "packages") ?? join(REPO_ROOT, "packages"),
    reportRoot: REPO_ROOT,
  });
  if (flag(argv, "markdown")) { console.log(formatPackageGraph(graph)); console.log(""); }
  const outcome = packageWiringCheck(graph);
  const failed = outcome.status === "fail" ? 1 : 0;
  console.log(formatReport({
    suite: "package-wiring", subject: relative(REPO_ROOT, resolve(option(argv, "packages") ?? join(REPO_ROOT, "packages"))),
    status: failed > 0 ? "fail" : "pass", checks: [outcome],
    counts: { pass: 1 - failed, fail: failed, skip: 0 },
    errorCount: outcome.findings.filter(f => f.severity === "error").length,
    warningCount: outcome.findings.filter(f => f.severity === "warning").length,
  }));
  return failed;
}

export function main(argv: readonly string[]): number {
  const [command, ...rest] = argv;
  switch (command) {
    case "model": return runModel(rest);
    case "corpus": return runCorpus(rest);
    case "corpus-v1": return runCorpusV1(rest);
    case "bundle": return runBundle(rest);
    case "scan": return runScan(rest);
    case "wiring": return runWiring(rest);
    default: console.error(USAGE); return 2;
  }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
