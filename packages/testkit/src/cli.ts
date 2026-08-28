import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadModel } from "@skill-wiki/model-schema";
import { formatReport } from "./diagnostics.ts";
import { runModelConformance } from "./model-conformance.ts";
import { loadCorpus } from "./corpus.ts";
import { runCorpusConformance } from "./corpus-conformance.ts";
import { corpusFromV1Sources } from "./corpus-adapter.ts";
import { closedSetCheck, domainScanCheck, formatDomainScan, loadVocabulary, mergeVocabularies, scanDomainSemantics, vocabularyFromModel, type Vocabulary } from "./domain-scan.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "..");
const REPO_ROOT = resolve(PACKAGE_ROOT, "..", "..");

const USAGE = `prime testkit

  bun packages/testkit/src/cli.ts model  <model-root> [--allow-empty-type-shells]
  bun packages/testkit/src/cli.ts corpus <model-root> <corpus.yaml> [--licenses=A,B] [--require-citations]
  bun packages/testkit/src/cli.ts corpus-v1 <model-root> <sources-dir> [--name=N] [--citation-fields=a,b] [--licenses=A,B]
  bun packages/testkit/src/cli.ts scan   [--roots=dir,dir] [--model=<model-root>] [--vocabulary=file.yaml]
                                         [--markdown] [--max-rows=N] [--all-hits]

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

function runCorpus(argv: readonly string[]): number {
  const [modelRoot, corpusPath] = argv;
  if (modelRoot === undefined || corpusPath === undefined) { console.error(USAGE); return 2; }
  const model = loadModel(resolve(modelRoot));
  if (!model.ok) { console.error(`model failed to load:\n${model.diagnostics.map(d => `  ${d.code}: ${d.message}`).join("\n")}`); return 1; }
  const corpus = loadCorpus(resolve(corpusPath));
  if (!corpus.ok) { console.error(`corpus failed to load:\n${corpus.diagnostics.map(d => `  ${d.code}: ${d.message}`).join("\n")}`); return 1; }
  const licenses = list(argv, "licenses");
  const result = runCorpusConformance(corpus.value, model.value, {
    allowedLicenses: licenses.length > 0 ? licenses : undefined,
    requireCitationForAllTypes: flag(argv, "require-citations"),
  });
  console.log(formatReport(result));
  return result.status === "fail" ? 1 : 0;
}

function runScan(argv: readonly string[]): number {
  const explicitRoots = list(argv, "roots").map(r => resolve(r));
  const extra = list(argv, "vocabulary").map(v => loadVocabulary(resolve(v)));
  const vocabulary = mergeVocabularies(defaultVocabulary(option(argv, "model")), ...extra);
  const scan = scanDomainSemantics({
    roots: explicitRoots.length > 0 ? explicitRoots : defaultScanRoots(),
    vocabulary,
    reportRoot: REPO_ROOT,
  });
  const outcome = domainScanCheck(scan);
  const closedSets = closedSetCheck(scan);
  if (flag(argv, "markdown")) {
    const maxRows = option(argv, "max-rows");
    console.log(formatDomainScan(scan, { onlyDistinctive: !flag(argv, "all-hits"), maxRows: maxRows === undefined ? undefined : Number(maxRows) }));
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

export function main(argv: readonly string[]): number {
  const [command, ...rest] = argv;
  switch (command) {
    case "model": return runModel(rest);
    case "corpus": return runCorpus(rest);
    case "corpus-v1": return runCorpusV1(rest);
    case "scan": return runScan(rest);
    default: console.error(USAGE); return 2;
  }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
