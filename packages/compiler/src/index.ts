/**
 * @module @skill-wiki/compiler
 * AI-powered compiler for .prime files.
 *
 * Compilation pipeline:
 *   Phase 1: Parse (.prime -> AST)           — handled by @skill-wiki/parser
 *   Phase 2: Check (AST -> diagnostics)      — L1 structural, L2 logic, L3 domain
 *   Phase 3: Resolve (dependency graph)       — cycle, conflict, version checks
 *   Phase 4: Emit (AST -> .md outputs)        — optimized Markdown + bundle + index + graph
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
export { checkL2Heuristic } from "./checker-l2-heuristic";
export { buildL2Prompt, parseL2Response } from "./checker-l2";
export { buildL3Prompt, parseL3Response } from "./checker-l3";
export { checkL3Cross } from "./checker-l3-cross";
export type { L3CrossOptions, L3CrossFinding } from "./checker-l3-cross";
export { callAI, hasApiKey, AI_MODELS } from "./ai-client";
export type { AIClientOptions } from "./ai-client";
export { L2Cache, defaultL2Cache, L2_PROMPT_VERSION } from "./l2-cache";
export type { L2CacheEntry, L2CacheOptions } from "./l2-cache";
export { resolve } from "./resolver";
export type { ResolveResult } from "./resolver";
export {
  emitMarkdown,
  emitBundle,
  emitIndex,
  emitGraph,
  estimateTokens,
} from "./emitter";
export { emitYamlAtom } from "./emitter-yaml-atom";
export { chunk, estimateTokens as estimateChunkTokens } from "./chunker";
export type { ChunkLevels } from "./chunker";
export { emitXmlStub } from "./xml-stub-emitter";
export type { AtomTokenCounts } from "./xml-stub-emitter";
export { emitGlobalIndex, buildGlobalIndexXml } from "./global-index-emitter";
export type { AtomMeta } from "./global-index-emitter";
export { emitAtomDir } from "./atom-dir-emitter";
export type { EmitResult } from "./atom-dir-emitter";
export { normalizeUnit, normalizePrimeV1Atom, applyV1SyntaxMacro } from "./normalizer";
export type { NormalizeContext, NormalizeDiagnostic, NormalizeResult } from "./normalizer";
export { compileUnit, compileNormalizedUnit, emitCompiledUnit, computeCompiledUnitContentDigest } from "./generic-unit";
export type { CompileUnitOptions, CompileUnitDiagnostic, CompileUnitResult, EmitCompiledUnitResult } from "./generic-unit";

// ─── Imports for compile() ─────────────────────────────────────────────────

import type { LegacySyntaxAST, SyntaxAST } from "@skill-wiki/types";
import type { CompileOptions, CompileResult, Diagnostic } from "./types";
import { checkL1 } from "./checker-l1";
import { checkL2Heuristic } from "./checker-l2-heuristic";
import { buildL2Prompt, parseL2Response } from "./checker-l2";
import { buildL3Prompt, parseL3Response } from "./checker-l3";
import { callAI, hasApiKey, AI_MODELS } from "./ai-client";
import { defaultL2Cache } from "./l2-cache";
import { resolve } from "./resolver";
import {
  emitMarkdown,
  emitBundle,
  emitIndex,
  emitGraph,
  estimateTokens,
} from "./emitter";

// ─── Compile Function ──────────────────────────────────────────────────────

/**
 * Compile a .prime source file through the full pipeline.
 *
 * Pipeline:
 * 1. Parse source into AST (delegates to @skill-wiki/parser)
 * 2. Run structural checks (L1, always)
 * 3. Run logic checks (L2, if level >= 2) — AI-powered via Anthropic API
 * 4. Run domain checks (L3, if level >= 3) — AI-powered via Anthropic API
 * 5. Resolve dependencies
 * 6. Emit optimized Markdown outputs
 *
 * @param source - The .prime source code string
 * @param options - Compilation options
 * @returns Compilation result with diagnostics and output artifacts
 */
export async function compile(
  source: string,
  options: CompileOptions = {}
): Promise<CompileResult> {
  const { level = 1, output, bundle = false, installedPrimes = new Map() } = options;
  const diagnostics: Diagnostic[] = [];

  // ── Phase 1: Parse ────────────────────────────────────────────────────
  let ast: LegacySyntaxAST;
  try {
    // Try to dynamically import the parser
    // If not available, compilation cannot proceed
    let parserModule: any;
    try {
      parserModule = await import("@skill-wiki/parser");
    } catch {
      // Parser not available — this allows the compiler to be tested
      // independently. In production, the parser must be installed.
      throw new Error(
        "Parser (@skill-wiki/parser) not available. Install it or provide a pre-parsed AST."
      );
    }
    // The parser may return { ast, errors } or a PrimeAST directly
    const parseResult = parserModule.parse(source);
    if (parseResult && typeof parseResult === "object" && "ast" in parseResult) {
      const parsedAst = parseResult.ast as SyntaxAST;
      // If the parser returned errors, add them as diagnostics
      if (parseResult.errors && Array.isArray(parseResult.errors)) {
        for (const err of parseResult.errors) {
          diagnostics.push({
            level: "error",
            line: err.line ?? 0,
            message: err.message ?? String(err),
            source: "L1:structure",
          });
        }
        if (parseResult.errors.length > 0) {
          return { success: false, diagnostics };
        }
      }
      if (parsedAst.type === "UnitDeclaration") return { success: false, diagnostics: [{ level: "error", line: parsedAst.loc.line, message: "Generic compile is not connected; use the normalize API", source: "L1:structure" }] };
      ast = parsedAst;
    } else {
      ast = parseResult as LegacySyntaxAST;
    }
  } catch (parseError) {
    return {
      success: false,
      diagnostics: [
        {
          level: "error",
          line: 0,
          message:
            parseError instanceof Error
              ? parseError.message
              : "Unknown parse error",
          source: "L1:structure",
        },
      ],
    };
  }

  // ── Phase 2: Check ────────────────────────────────────────────────────

  // Level 1: Structural checks (always)
  const l1Diagnostics = checkL1(ast, installedPrimes);
  diagnostics.push(...l1Diagnostics);

  // Level 2: Semantic checks (if level >= 2)
  //   Step 1 — offline heuristic always runs (deterministic, free).
  //   Step 2 — LLM pass runs only if ANTHROPIC_API_KEY is present, and the
  //            cache is consulted first so re-compiles are free.
  if (level >= 2) {
    diagnostics.push(...checkL2Heuristic(ast));

    if (hasApiKey()) {
      const astJson = JSON.stringify(ast);
      const model = AI_MODELS.L2;
      const cached = defaultL2Cache.get(astJson, model);
      if (cached) {
        diagnostics.push(...cached);
      } else {
        const l2Response = await callAI(buildL2Prompt(ast), { model });
        if (l2Response) {
          const l2Diagnostics = parseL2Response(l2Response);
          defaultL2Cache.put(astJson, model, l2Diagnostics);
          diagnostics.push(...l2Diagnostics);
        }
      }
    } else if (level === 2) {
      console.warn(
        "[prime-compiler] LLM L2 skipped (set ANTHROPIC_API_KEY for the full semantic pass)"
      );
    }
  }

  // Level 3: Domain checks (if level >= 3)
  if (level >= 3) {
    if (hasApiKey() && ast.type === "PrimeDeclaration") {
      const l3Prompt = buildL3Prompt(ast);
      const l3Response = await callAI(l3Prompt, { model: AI_MODELS.L3 });
      if (l3Response) {
        const l3Diagnostics = parseL3Response(l3Response);
        diagnostics.push(...l3Diagnostics);
      }
    } else if (level >= 3 && !(level >= 2)) {
      // Only print the skip message if we didn't already print it for L2
      console.warn(
        "[prime-compiler] AI checks skipped (set ANTHROPIC_API_KEY for L2/L3 checks)"
      );
    }
  }

  // Check for errors — if any L1 errors, compilation fails
  const hasErrors = diagnostics.some((d) => d.level === "error");
  if (hasErrors) {
    return { success: false, diagnostics };
  }

  // ── Phase 3: Resolve ──────────────────────────────────────────────────
  const { graph, diagnostics: resolverDiags } = resolve(ast, installedPrimes);
  diagnostics.push(...resolverDiags);

  // Check for resolver errors
  const hasResolverErrors = resolverDiags.some((d) => d.level === "error");
  if (hasResolverErrors) {
    return { success: false, diagnostics };
  }

  // ── Phase 4: Emit ─────────────────────────────────────────────────────
  const md = emitMarkdown(ast);
  const indexYaml = emitIndex(ast, graph);
  const graphYaml = emitGraph(graph);

  let bundleMd: string | undefined;
  if (bundle) {
    bundleMd = emitBundle(ast, graph, installedPrimes);
  }

  // Estimate token counts
  const sourceTokens = estimateTokens(source);
  const compiledTokens = estimateTokens(md);
  const bundleTokens = bundleMd ? estimateTokens(bundleMd) : undefined;

  // Re-emit index with token counts
  const indexWithTokens = emitIndex(
    ast,
    graph,
    sourceTokens,
    compiledTokens,
    bundleTokens
  );

  return {
    success: true,
    diagnostics,
    outputs: {
      md,
      bundle: bundleMd,
      index: indexWithTokens,
      graph: graphYaml,
    },
  };
}

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

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseLegacy } from "@skill-wiki/parser";
import type { AtomDeclaration, PrimeAST } from "@skill-wiki/types";
import { emitAtomDir } from "./atom-dir-emitter";
import { emitGlobalIndex, type AtomMeta } from "./global-index-emitter";
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
    for (const entry of readdirSync(dir).filter(name => name.endsWith(".prime"))) {
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
    const result = emitAtomDir(ast, outputDir);
    const metas: AtomMeta[] = [result.meta];
    emitGlobalIndex(metas, outputDir);
    report({ phase: "emit", ok: true, detail: "Emitted atom directory" });
    return { ok: true, diagnostics, skipped, sourceLines, dependencyCount, outputDir, emit, files: [...result.files], tokens: { ...result.tokens }, atomId: result.atomId, atomDirSkipped: result.skipped, atomOutDir: result.outDir };
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
