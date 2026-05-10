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

// ─── Imports for compile() ─────────────────────────────────────────────────

import type { PrimeAST } from "@skill-wiki/types";
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
  let ast: PrimeAST;
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
      ast = parseResult.ast as PrimeAST;
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
    } else {
      ast = parseResult as PrimeAST;
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
    if (hasApiKey()) {
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
