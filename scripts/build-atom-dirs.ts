#!/usr/bin/env bun
/**
 * scripts/build-atom-dirs.ts
 *
 * Corpus-level compile: walk `*.prime` sources, run them through the unified
 * pipeline, and finalize the corpus bundle.
 *
 *   Discover sources
 *     → Parse (v1 legacy syntax)
 *     → Resolve model package
 *     → Normalize to UnitIR
 *     → Render projections + emit unit directories
 *     → L3 corpus/graph checks
 *     → Finalize corpus index + immutable manifest
 *
 * Plan §8.1 requires every CLI, batch script and CI job to call the same
 * pipeline rather than re-sequencing parse/check/emit stages. This script used
 * to import six stage functions from the compiler and drive them itself, which
 * is what kept the legacy atom-dir emitter, the post-emit edge rewriter and the
 * L2 LLM caller alive. It now calls the same normalize → compile → emit path the
 * generic `unit` syntax uses, so there is one renderer and one identity rule.
 *
 * Usage:
 *   bun scripts/build-atom-dirs.ts --src examples/hello-world/primes/sources \
 *                                  --out examples/hello-world/primes/compiled \
 *                                  --release 2026-08-29
 *
 * Options:
 *   --src <path>      Source directory containing *.prime files (recursive)
 *   --out <path>      Output directory for compiled unit dirs + corpus bundle
 *   --model <path>    Model package to compile against
 *                     (default: compat/prime-v1-model)
 *   --corpus <name>   Corpus name recorded in the manifest and used as the
 *                     domain fallback (default: derived from --src)
 *   --release <date>  YYYY-MM-DD release stamp. Required (or SOURCE_DATE_EPOCH):
 *                     every timestamp in the bundle is derived from it, so two
 *                     builds of the same sources are byte-identical.
 *   --limit <n>       Only compile the first N units (for testing)
 *   --verbose         Print each unit's file list and every L3 finding
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

import type { AtomDeclaration, LegacySyntaxAST } from "../packages/types/src/index.ts";
import type { CompiledUnitIR } from "../packages/ir/src/index.ts";
import { parseLegacy } from "../packages/parser/src/index.ts";
import { loadModelOrThrow } from "../packages/model-schema/src/index.ts";
import { deriveV1AtomId, normalizePrimeV1Atom } from "../packages/compiler/src/normalizer.ts";
import { compileNormalizedUnit, emitCompiledUnit } from "../packages/compiler/src/generic-unit.ts";
import { checkL3Cross } from "../packages/compiler/src/checker-l3-cross.ts";
import { finalizeCorpusBundle } from "../packages/bundle/src/index.ts";

// ── Arg parsing ─────────────────────────────────────────────────────────────

const HERE = dirname(new URL(import.meta.url).pathname);
const DEFAULT_MODEL = resolve(HERE, "..", "compat", "prime-v1-model");

function parseArgs(argv: string[]) {
  const result = {
    src: "primes-v2/modules",
    out: "compiled-v3",
    model: DEFAULT_MODEL,
    corpus: "",
    release: "",
    limit: Infinity,
    verbose: false,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--src" && argv[i + 1]) result.src = argv[++i]!;
    else if (argv[i] === "--out" && argv[i + 1]) result.out = argv[++i]!;
    else if (argv[i] === "--model" && argv[i + 1]) result.model = argv[++i]!;
    else if (argv[i] === "--corpus" && argv[i + 1]) result.corpus = argv[++i]!;
    else if (argv[i] === "--release" && argv[i + 1]) result.release = argv[++i]!;
    else if (argv[i] === "--limit" && argv[i + 1]) result.limit = parseInt(argv[++i]!, 10);
    else if (argv[i] === "--verbose") result.verbose = true;
  }
  return result;
}

const args = parseArgs(process.argv.slice(2));
const srcDir = resolve(args.src);
const outDir = resolve(args.out);

if (!existsSync(srcDir)) {
  console.error(`Source directory not found: ${srcDir}`);
  process.exit(1);
}

/**
 * The release date this bundle is stamped with, and the sole source of its
 * timestamps.
 *
 * A wall clock cannot appear anywhere in a build artifact: `corpus.manifest.json`
 * carries a full ISO-8601 instant, so reading `new Date()` made the manifest —
 * and therefore the bundle's byte image — differ on every run (plan §8.2
 * acceptance). The release is a declared *input*: `--release`, or
 * `SOURCE_DATE_EPOCH` for a build reproducing an earlier one. There is no
 * fallback: guessing the release from the machine clock is what made the
 * artifact unreproducible in the first place, and a build that cannot say which
 * release it is producing should stop rather than invent one.
 */
function resolveRelease(explicit: string): string {
  if (explicit) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(explicit)) { console.error(`--release must be a YYYY-MM-DD date, got: ${explicit}`); process.exit(1); }
    return explicit;
  }
  const epoch = process.env.SOURCE_DATE_EPOCH;
  const seconds = epoch === undefined ? undefined : Number.parseInt(epoch, 10);
  if (seconds !== undefined && Number.isFinite(seconds)) return new Date(seconds * 1000).toISOString().slice(0, 10);
  console.error("No release date: pass --release <YYYY-MM-DD> or set SOURCE_DATE_EPOCH. A build artifact may not be stamped from the wall clock.");
  process.exit(1);
}

const releaseDate = resolveRelease(args.release);
/** Midnight UTC of the release date — an instant derived from the release, never from the clock. */
const releaseInstant = `${releaseDate}T00:00:00.000Z`;

/**
 * The corpus name, which is also the domain fallback.
 *
 * `finalizeCorpusBundle` rejects an empty domain, and most v1 atoms declare no
 * `domain` field, so a corpus identity has to come from somewhere.
 *
 * It must be derived from an *input*. `computeCompiledUnitContentDigest`
 * (`packages/compiler/src/generic-unit.ts`) hashes the whole `unit.identity`,
 * and `identity.corpus` is part of it — so deriving the corpus name from the
 * output directory made every artifact byte a function of where it was written,
 * and the same sources compiled into two different roots produced different
 * `content_hash` values. `--src` is an input; `--out` is not.
 */
function deriveCorpusName(inputDir: string): string {
  const parts = inputDir.split("/").filter(Boolean);
  const primes = parts.lastIndexOf("primes");
  if (primes > 0) return parts[primes - 1]!;
  return basename(inputDir);
}
const corpusName = args.corpus || deriveCorpusName(srcDir);

// ── Walk for *.prime files ───────────────────────────────────────────────────

function walkPrimeFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) results.push(...walkPrimeFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".prime")) results.push(full);
  }
  return results;
}

const allFiles = walkPrimeFiles(srcDir);
const files = args.limit < Infinity ? allFiles.slice(0, args.limit) : allFiles;

if (files.length === 0) {
  console.error(`No .prime files found in: ${srcDir}`);
  process.exit(1);
}

console.log(`Found ${allFiles.length} .prime files in ${relative(process.cwd(), srcDir)}`);
if (args.limit < Infinity) console.log(`  (limiting to first ${args.limit})`);
console.log(`Model:  ${relative(process.cwd(), args.model)}`);
console.log(`Output: ${relative(process.cwd(), outDir)}`);
console.log();

// ── Resolve the model package ────────────────────────────────────────────────

const model = loadModelOrThrow(args.model);

// ── Compile each unit ────────────────────────────────────────────────────────

const errors: Array<{ file: string; error: string }> = [];
const asts: LegacySyntaxAST[] = [];
const compiledUnits: CompiledUnitIR[] = [];

function declaredVersion(ast: LegacySyntaxAST): string {
  const field = ast.body.find(entry => entry.key === "version");
  return field && field.value.type === "String" ? field.value.value : "1.0.0";
}

/**
 * A deprecated unit is marked in the corpus index rather than dropped.
 *
 * The legacy script warned about deprecated atoms and excluded them from the
 * BROWSE index; `CorpusIndexEntry.lifecycle` is where that state now lives, so
 * the exclusion is a Runtime selection decision instead of a missing row.
 */
function declaredLifecycle(ast: LegacySyntaxAST): "active" | "deprecated" {
  const field = ast.body.find(entry => entry.key === "lifecycle");
  if (!field || field.value.type !== "Object") return "active";
  const deprecatedAt = field.value.fields.find(entry => entry.key === "deprecated_at");
  if (!deprecatedAt) return "active";
  const value = deprecatedAt.value.type === "String" || deprecatedAt.value.type === "Ident" ? deprecatedAt.value.value : "";
  return value && value !== "null" ? "deprecated" : "active";
}

for (const file of files) {
  let source: string;
  try {
    source = readFileSync(file, "utf8");
  } catch (error) {
    errors.push({ file, error: `Read error: ${error}` });
    continue;
  }

  const parsed = parseLegacy(source, file);
  if (parsed.errors.length > 0) {
    errors.push({ file, error: `Parse error: ${parsed.errors.map(entry => entry.message).join("; ")}` });
    continue;
  }
  const ast = parsed.ast;
  if (ast.type === "PrimeDeclaration") {
    // The `prime … extends …` form names no model type, so there is nothing for
    // the v1 syntax macro to qualify. Failing loudly beats emitting a unit whose
    // type was guessed from an `extends` clause.
    errors.push({ file, error: "Unsupported declaration form: `prime … extends …` has no model type to normalize against." });
    continue;
  }
  const declaration: AtomDeclaration = ast;

  const normalized = normalizePrimeV1Atom(declaration, model, {
    corpus: corpusName,
    version: declaredVersion(ast),
    digest: `sha256:${createHash("sha256").update(source, "utf8").digest("hex")}`,
    id: deriveV1AtomId(declaration),
    lifecycle: declaredLifecycle(declaration),
  });
  if (!normalized.ok) {
    errors.push({ file, error: `Normalize error: ${normalized.diagnostics.map(entry => `${entry.code}: ${entry.message}`).join("; ")}` });
    continue;
  }

  const compiled = compileNormalizedUnit(normalized.value, declaration, model);
  if (!compiled.ok) {
    errors.push({ file, error: `Compile error: ${compiled.diagnostics.map(entry => `${entry.code}: ${entry.message}`).join("; ")}` });
    continue;
  }

  let emitted;
  try {
    emitted = emitCompiledUnit(compiled.value, outDir);
  } catch (error) {
    errors.push({ file, error: `Emit error: ${error instanceof Error ? error.message : String(error)}` });
    continue;
  }

  asts.push(declaration);
  compiledUnits.push(compiled.value);
  console.log(`  → ${relative(process.cwd(), emitted.directory)}/`);
  if (args.verbose) for (const name of emitted.files) console.log(`       ${name}`);
}

// ── Recorded skips (plan §17.5) ──────────────────────────────────────────────
//
// An optional LLM semantic pass may be skipped, but the skip has to be recorded
// rather than disguised as a pass. There is no L2 provider wired into this
// pipeline, so the stage is reported as not-run on every build instead of being
// silently absent.

console.log(`\n⏭  L2:semantic — skipped: no semantic-check provider is configured for this pipeline.`);

// ── L3 corpus/graph checks ───────────────────────────────────────────────────

if (asts.length > 0) {
  const findings = checkL3Cross(asts, { jaccardThreshold: 0.85, minTagsForDupCheck: 4, maxDuplicatePairs: 50 });
  const l3Errors = findings.filter(entry => entry.level === "error");
  const suggestions = findings.filter(entry => entry.level === "suggestion");
  console.log(`🔍 L3 corpus/graph — ${l3Errors.length} errors, ${suggestions.length} suggestions`);
  if (args.verbose) {
    for (const finding of [...l3Errors, ...suggestions]) console.warn(`     [${finding.code}] ${finding.atom}: ${finding.message}`);
  } else if (l3Errors.length > 0) {
    const byCode = l3Errors.reduce<Record<string, number>>((counts, finding) => { counts[finding.code] = (counts[finding.code] ?? 0) + 1; return counts; }, {});
    for (const [code, count] of Object.entries(byCode).sort(([a], [b]) => (a < b ? -1 : 1))) console.warn(`     ${code}: ${count}`);
  }
}

// ── Finalize the corpus bundle ───────────────────────────────────────────────

let indexPath = "";
if (compiledUnits.length > 0) {
  const finalized = finalizeCorpusBundle({
    outDir,
    units: compiledUnits,
    manifest: {
      protocolVersion: "2.0.0",
      irVersion: "2",
      compilerVersion: "2.1.0",
      emitterVersion: "3",
      corpus: corpusName,
      release: releaseDate,
      sourceRevision: "unversioned",
      models: { [model.manifest.name]: model.manifest.version },
      schemaDigest: modelSchemaDigest(),
      createdAt: releaseInstant,
    },
  });
  indexPath = finalized.indexPath;
}

/** Digest of the model definitions this corpus was compiled against. */
function modelSchemaDigest(): string {
  const hash = createHash("sha256");
  for (const definition of [...model.definitions].sort((left, right) => (`${left.kind}/${left.name}` < `${right.kind}/${right.name}` ? -1 : 1))) {
    hash.update(JSON.stringify(definition));
  }
  return `sha256:${hash.digest("hex")}`;
}

// ── Stats summary ────────────────────────────────────────────────────────────

const domains = new Set(compiledUnits.map(unit => unit.meta.domain));
const deprecated = compiledUnits.filter(unit => unit.unit.lifecycle === "deprecated");

console.log();
console.log("─".repeat(60));
console.log(`${compiledUnits.length} units compiled`);
if (deprecated.length > 0) console.log(`  (${deprecated.length} deprecated, marked in the corpus index)`);
if (errors.length > 0) console.log(`  ${errors.length} failed`);
if (indexPath) {
  const totalTokens = compiledUnits.reduce((sum, unit) => sum + Object.values(unit.meta.tokens).reduce((a, b) => a + b, 0), 0);
  console.log(`  → ${relative(process.cwd(), indexPath)} (${totalTokens} tokens, ${compiledUnits.length} units across ${domains.size} clusters)`);
}

if (errors.length > 0) {
  console.log();
  console.log(`Errors (${errors.length}):`);
  for (const entry of errors) console.log(`  ${relative(process.cwd(), entry.file)}: ${entry.error}`);
  process.exit(1);
}
