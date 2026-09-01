/**
 * @module @aoe/compiler
 * Compiler for `.prime` sources.
 *
 * Compilation pipeline (plan §8.1):
 *   Discover sources → Parse → Resolve model → Normalize to IR
 *     → L1 structural checks → Link references and relations
 *     → L3 corpus/graph checks → Emit projections
 *
 * There is one public build entry, `compileSource`. Optional-provider semantic
 * checks (L2/L3 LLM) are reported as recorded skips rather than implemented
 * here; see `SkippedStage`.
 */

// ─── Re-exports ────────────────────────────────────────────────────────────

export type {
  Diagnostic,
  CompileOptions,
  CompileResult,
  CompileOutputs,
  InstalledPrime,
  DependencyGraph,
  DependencyNode,
  DependencyEdge,
} from "./types";

export { checkL1 } from "./checker-l1";
export { checkL3Cross } from "./checker-l3-cross";
export type { L3CrossOptions, L3CrossFinding } from "./checker-l3-cross";
export { resolve } from "./resolver";
export type { ResolveResult } from "./resolver";
export {
  emitMarkdown,
  emitBundle,
  emitIndex,
  emitGraph,
  estimateTokens,
} from "./emitter";
export { chunk, estimateTokens as estimateChunkTokens } from "./chunker";
export type { ChunkLevels } from "./chunker";
export { buildGlobalIndexXml } from "./global-index-emitter";
export type { AtomMeta } from "./global-index-emitter";
export { normalizeUnit, normalizePrimeV1Atom, applyV1SyntaxMacro, deriveV1AtomId } from "./normalizer";
export type { NormalizeContext, NormalizeDiagnostic, NormalizeResult } from "./normalizer";
export { compileUnit, compileNormalizedUnit, emitCompiledUnit, computeCompiledUnitContentDigest, EMITTER_VERSION } from "./generic-unit";
export type { CompileUnitOptions, CompileUnitDiagnostic, CompileUnitResult, EmitCompiledUnitResult } from "./generic-unit";

// ─── Imports ───────────────────────────────────────────────────────────────

import type { Diagnostic } from "./types";
import { checkL1 } from "./checker-l1";
import { resolve } from "./resolver";
import {
  emitMarkdown,
  emitBundle,
  emitIndex,
  emitGraph,
  estimateTokens,
} from "./emitter";

// ─── §8.1 Unified Compile Pipeline ─────────────────────────────────────────
//
// Plan §8.1: "不再允许 CLI、MCP、脚本分别复制 parse/check/emit 阶段."
// Before this entry existed the CLI imported six stage functions and sequenced
// them itself, so the stage order, the abort conditions and the installed-prime
// discovery rules lived in `packages/cli` rather than in the compiler. Anything
// else wanting to compile (a script, an MCP tool) had to re-derive them. The
// pipeline below is the single place that sequence is written down.
//
// It runs the SAME stages in the SAME order as the CLI did, on purpose: this
// entry is about where the sequence lives, not about changing what it emits.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { parseLegacy } from "@aoe/parser";
import { loadModelOrThrow, type LoadedModel } from "@aoe/model-schema";
import type { AtomDeclaration, PrimeAST } from "@aoe/types";
import { compileNormalizedUnit, emitCompiledUnit } from "./generic-unit";
import { deriveV1AtomId, normalizePrimeV1Atom } from "./normalizer";
import type { InstalledPrime } from "./types";

export type PipelineEmitMode = "atom-dir" | "markdown";

/**
 * A pipeline stage that did not run.
 *
 * Plan §17.5 allows an optional LLM check to be skipped but requires the skip to
 * be recorded rather than disguised as a pass. A commented-out call site records
 * nothing, so callers could not tell a clean corpus from an unchecked one.
 */
export interface SkippedStage {
  readonly stage: string;
  readonly reason: string;
}

export interface PipelinePhaseEvent {
  readonly phase: "parse" | "check" | "resolve" | "emit";
  readonly ok: boolean;
  readonly detail: string;
}

export interface CompilePipelineOptions {
  /** Absolute path of the `.prime` source to compile. */
  readonly file: string;
  readonly level?: 1 | 2 | 3;
  readonly outputDir?: string;
  readonly bundle?: boolean;
  readonly emit?: PipelineEmitMode;
  /** Progress observer, so a CLI can render phases live without owning them. */
  readonly onPhase?: (event: PipelinePhaseEvent) => void;
}

export interface CompilePipelineResult {
  readonly ok: boolean;
  readonly failedPhase?: "parse" | "check" | "resolve";
  readonly diagnostics: readonly Diagnostic[];
  readonly skipped: readonly SkippedStage[];
  readonly sourceLines: number;
  readonly dependencyCount: number;
  readonly outputDir: string;
  readonly emit: PipelineEmitMode;
  /** Written artifact paths, absolute for markdown mode, relative for atom dirs. */
  readonly files: readonly string[];
  readonly tokens?: Readonly<Record<string, number>>;
  /** atom-dir mode only. */
  readonly atomId?: string;
  readonly atomDirSkipped?: boolean;
  readonly atomOutDir?: string;
  /** markdown mode only. */
  readonly primeName?: string;
  readonly reductionPercent?: number;
}

function isPrimeDeclaration(ast: PrimeAST | AtomDeclaration): ast is PrimeAST {
  return ast.type === "PrimeDeclaration";
}

/**
 * The v1 compatibility model, resolved the same way the chunker resolves it.
 *
 * A `.prime` file in the legacy kind form declares no model, so the one model
 * that gives its kinds a type is the compat package. Loading it here rather than
 * hardcoding kind names is what keeps `atom-dir` emit free of built-in domain
 * semantics (§3.1).
 */
let cachedV1Model: LoadedModel | undefined;
function v1CompatibilityModel(): LoadedModel {
  if (!cachedV1Model) {
    const here = dirname(fileURLToPath(import.meta.url));
    cachedV1Model = loadModelOrThrow(resolvePath(here, "../../../compat/prime-v1-model"));
  }
  return cachedV1Model;
}

function stringField(ast: PrimeAST | AtomDeclaration, key: string): string | undefined {
  const field = ast.body.find(entry => entry.key === key);
  return field && field.value.type === "String" ? field.value.value : undefined;
}

/**
 * Locate sibling `.prime` files so cross-atom references and dependency
 * resolution have something to resolve against.
 *
 * The search order is load-bearing (first match wins) and used to live in the
 * CLI command; a second caller would have silently used a different order.
 */
export function discoverInstalledPrimes(filePath: string): Map<string, InstalledPrime> {
  const installedPrimes = new Map<string, InstalledPrime>();
  const searchDirs = [
    join(dirname(filePath), ".primes", "source"),
    join(dirname(filePath), "..", ".primes", "source"),
    join(process.cwd(), ".primes", "source"),
    join(process.cwd(), "primes"),
    dirname(filePath),
  ];
  for (const dir of searchDirs) {
    if (!existsSync(dir)) continue;
    // Sorted: `readdirSync` returns filesystem order, and the first-wins rule
    // below then resolves a duplicate prime name differently on two machines
    // holding identical files. Discovery order is an input to what gets
    // compiled, so it has to be a property of the names, not of the volume.
    for (const entry of readdirSync(dir).filter(name => name.endsWith(".prime")).sort()) {
      const primeName = entry.replace(".prime", "");
      if (installedPrimes.has(primeName)) continue;
      try {
        const { ast } = parseLegacy(readFileSync(join(dir, entry), "utf8"), entry);
        installedPrimes.set(primeName, {
          name: stringField(ast, "name") ?? primeName,
          version: stringField(ast, "version") ?? "0.0.0",
          type: (isPrimeDeclaration(ast) ? ast.extends : undefined) ?? "Unknown",
          ast,
        });
      } catch {
        // An unparseable neighbour is not this compilation's error; it will be
        // reported when that file is itself compiled.
      }
    }
  }
  return installedPrimes;
}

/**
 * The single compile entry point (plan §8.1).
 *
 * Stages: discover sources → parse → L1 structural checks → resolve
 * references/relations → emit projections. L2/L3 optional-provider checks are
 * recorded as skips rather than run; no LLM provider is wired here.
 */
export function compileSource(options: CompilePipelineOptions): CompilePipelineResult {
  const level = options.level ?? 2;
  const emit = options.emit ?? "markdown";
  const outputDir = options.outputDir ?? join(dirname(options.file), "compiled");
  const source = readFileSync(options.file, "utf8");
  const sourceLines = source.split("\n").length;
  const skipped: SkippedStage[] = [];
  const report = (event: PipelinePhaseEvent) => options.onPhase?.(event);

  // ── Parse ───────────────────────────────────────────────────────────────
  const { ast, errors: parseErrors } = parseLegacy(source, basename(options.file));
  if (parseErrors.length > 0) {
    const diagnostics = parseErrors.map<Diagnostic>(error => ({
      level: "error",
      line: error.line ?? 0,
      message: error.message,
      ...(error.suggestion ? { suggestion: error.suggestion } : {}),
      source: "L1:structure",
    }));
    report({ phase: "parse", ok: false, detail: `${parseErrors.length} syntax errors` });
    return { ok: false, failedPhase: "parse", diagnostics, skipped, sourceLines, dependencyCount: 0, outputDir, emit, files: [] };
  }
  report({ phase: "parse", ok: true, detail: `Parsed ${sourceLines} lines, 0 syntax errors` });

  // ── Check ───────────────────────────────────────────────────────────────
  const installedPrimes = discoverInstalledPrimes(options.file);
  const diagnostics: Diagnostic[] = [...checkL1(ast, installedPrimes)];
  if (level >= 2) skipped.push({ stage: "L2:logic", reason: "No L2 semantic provider is configured for this pipeline; the level-2 check did not run." });
  if (level >= 3) skipped.push({ stage: "L3:domain", reason: "No L3 domain provider is configured for this pipeline; the level-3 check did not run." });
  const errors = diagnostics.filter(entry => entry.level === "error");
  const warnings = diagnostics.filter(entry => entry.level === "warn");
  report({ phase: "check", ok: errors.length === 0, detail: `${errors.length} errors, ${warnings.length} warnings` });
  if (errors.length > 0) return { ok: false, failedPhase: "check", diagnostics, skipped, sourceLines, dependencyCount: 0, outputDir, emit, files: [] };

  // ── Resolve ─────────────────────────────────────────────────────────────
  const { graph, diagnostics: resolverDiagnostics } = resolve(ast, installedPrimes);
  const resolverErrors = resolverDiagnostics.filter(entry => entry.level === "error");
  if (resolverErrors.length > 0) {
    report({ phase: "resolve", ok: false, detail: "Dependency conflicts" });
    return { ok: false, failedPhase: "resolve", diagnostics: [...diagnostics, ...resolverDiagnostics], skipped, sourceLines, dependencyCount: 0, outputDir, emit, files: [] };
  }
  const dependencyCount = graph.nodes.length - 1;
  report({ phase: "resolve", ok: true, detail: `${dependencyCount} dependencies resolved` });

  // ── Emit ────────────────────────────────────────────────────────────────
  if (emit === "atom-dir") {
    if (ast.type === "PrimeDeclaration") {
      const diagnostic: Diagnostic = { level: "error", line: ast.loc.line, message: "Unit-directory emit requires a kind-form declaration; the `prime … extends …` form has no model type to normalize against.", source: "L1:structure" };
      report({ phase: "check", ok: false, detail: "Unsupported declaration form for unit-directory emit" });
      return { ok: false, failedPhase: "check", diagnostics: [...diagnostics, diagnostic], skipped, sourceLines, dependencyCount, outputDir, emit, files: [] };
    }
    const model = v1CompatibilityModel();
    const normalized = normalizePrimeV1Atom(ast, model, {
      corpus: basename(outputDir),
      version: stringField(ast, "version") ?? "1.0.0",
      digest: `sha256:${createHash("sha256").update(source, "utf8").digest("hex")}`,
      id: deriveV1AtomId(ast),
    });
    if (!normalized.ok) {
      const normalizeDiagnostics = normalized.diagnostics.map<Diagnostic>(entry => ({ level: "error", line: entry.source.loc.line, message: `${entry.code}: ${entry.message}`, source: "L1:structure" }));
      report({ phase: "check", ok: false, detail: `${normalizeDiagnostics.length} normalization errors` });
      return { ok: false, failedPhase: "check", diagnostics: [...diagnostics, ...normalizeDiagnostics], skipped, sourceLines, dependencyCount, outputDir, emit, files: [] };
    }
    const compiled = compileNormalizedUnit(normalized.value, ast, model);
    if (!compiled.ok) {
      const compileDiagnostics = compiled.diagnostics.map<Diagnostic>(entry => ({ level: "error", line: entry.source?.loc.line ?? 0, message: `${entry.code}: ${entry.message}`, source: "L1:structure" }));
      report({ phase: "check", ok: false, detail: `${compileDiagnostics.length} projection errors` });
      return { ok: false, failedPhase: "check", diagnostics: [...diagnostics, ...compileDiagnostics], skipped, sourceLines, dependencyCount, outputDir, emit, files: [] };
    }
    const emitted = emitCompiledUnit(compiled.value, outputDir);
    report({ phase: "emit", ok: true, detail: "Emitted unit directory" });
    // The corpus index is deliberately not written here. A single-file compile
    // knows one unit, and the previous implementation wrote a one-atom
    // `_index.xml` over whatever corpus index already existed in the output
    // directory. Corpus-level artifacts belong to the corpus-level entry point.
    return { ok: true, diagnostics, skipped, sourceLines, dependencyCount, outputDir, emit, files: [...emitted.files], tokens: { ...compiled.value.meta.tokens }, atomId: emitted.meta.id, atomDirSkipped: false, atomOutDir: emitted.directory };
  }

  const primeName = stringField(ast, "name") ?? basename(options.file, ".prime");
  const compiledMd = emitMarkdown(ast);
  const sourceTokens = estimateTokens(source);
  const compiledTokens = estimateTokens(compiledMd);
  const bundleMd = options.bundle ? emitBundle(ast, graph, installedPrimes) : undefined;
  const bundleTokens = bundleMd === undefined ? undefined : estimateTokens(bundleMd);
  const files: string[] = [];
  const write = (name: string, content: string) => {
    const path = join(outputDir, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf8");
    files.push(path);
  };
  write(`${primeName}.md`, compiledMd);
  write(`${primeName}.index.yaml`, emitIndex(ast, graph, sourceTokens, compiledTokens, bundleTokens));
  write(`${primeName}.graph.yaml`, emitGraph(graph));
  if (bundleMd !== undefined) write(`${primeName}.bundle.md`, bundleMd);
  report({ phase: "emit", ok: true, detail: "Emitted" });

  return {
    ok: true, diagnostics, skipped, sourceLines, dependencyCount, outputDir, emit, files, primeName,
    tokens: { source: sourceTokens, compiled: compiledTokens, ...(bundleTokens === undefined ? {} : { bundle: bundleTokens }) },
    reductionPercent: sourceTokens > 0 ? Math.round((1 - compiledTokens / sourceTokens) * 100) : 0,
  };
}
