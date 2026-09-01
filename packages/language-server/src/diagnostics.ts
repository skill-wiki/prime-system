/**
 * @module diagnostics
 * §14.2 `Checker Service` — editor-time diagnostics.
 *
 * ADR-8 / §18.5: the Language Server reuses Parser and Checker but does not
 * build bundles. So this module imports `checkL1` and `resolve` from
 * `@aoe/compiler` and imports **nothing** from its emitter: no
 * `emitMarkdown`, no `emitBundle`, no `emitCompiledUnit`, no `compileSource`.
 * `test/boundary.test.ts` pins that as a grep over this directory.
 *
 * The stage composition below is not "similar to" the CLI's — it is the same
 * stages in the same order with the same abort points as
 * `compileSource` (`packages/compiler/src/index.ts`), because plan §16 Phase 5
 * requires "LSP diagnostics 与 CLI compile diagnostics 一致" and the only way to
 * hold that is to run one sequence, not two.
 */

import { checkL1, resolve, discoverInstalledPrimes, type Diagnostic as CompilerDiagnostic } from "@aoe/compiler";
import type { LegacySyntaxAST } from "@aoe/types";
import type { ParsedDocument } from "./document-store";
import { documentPath } from "./document-store";
import type { Range } from "./text-document";
import type { TextDocument } from "./text-document";

export type DiagnosticSeverity = "error" | "warning" | "hint";

/** Which stage produced a diagnostic. `model` is LSP-only; see `model-diagnostics`. */
export type DiagnosticStage = "syntax" | "structure" | "resolve" | "model";

export interface LspDiagnostic {
  readonly severity: DiagnosticSeverity;
  readonly range: Range;
  readonly message: string;
  /** The compiler's `source` tag, verbatim, so parity can be checked field-wise. */
  readonly source: string;
  readonly stage: DiagnosticStage;
  readonly suggestion?: string;
  /** Stable code, for `model` stage diagnostics that carry one. */
  readonly code?: string;
}

const SEVERITY_OF_LEVEL: Readonly<Record<CompilerDiagnostic["level"], DiagnosticSeverity>> = {
  error: "error",
  warn: "warning",
  suggestion: "hint",
};

const LEVEL_OF_SEVERITY: Readonly<Record<DiagnosticSeverity, CompilerDiagnostic["level"]>> = {
  error: "error",
  warning: "warn",
  hint: "suggestion",
};

function stageOfSource(source: string | undefined): DiagnosticStage {
  return source === "resolver" ? "resolve" : "structure";
}

/** Lift a compiler diagnostic into LSP shape against the document it came from. */
export function fromCompilerDiagnostic(diagnostic: CompilerDiagnostic, document: TextDocument, stage?: DiagnosticStage): LspDiagnostic {
  return {
    severity: SEVERITY_OF_LEVEL[diagnostic.level],
    range: document.rangeOfSourceLine(diagnostic.line),
    message: diagnostic.message,
    source: diagnostic.source ?? "",
    stage: stage ?? stageOfSource(diagnostic.source),
    ...(diagnostic.suggestion === undefined ? {} : { suggestion: diagnostic.suggestion }),
  };
}

/**
 * Project an LSP diagnostic back to the compiler's shape.
 *
 * This is the comparison surface for the Phase 5 parity assertion. It goes back
 * through the 0-based→1-based line conversion and the severity mapping rather
 * than stashing the original object, so a wrong conversion fails the parity test
 * instead of being hidden by it.
 */
export function asCompilerDiagnostic(diagnostic: LspDiagnostic): CompilerDiagnostic {
  return {
    level: LEVEL_OF_SEVERITY[diagnostic.severity],
    line: diagnostic.range.start.line + 1,
    message: diagnostic.message,
    ...(diagnostic.suggestion === undefined ? {} : { suggestion: diagnostic.suggestion }),
    ...(diagnostic.source === "" ? {} : { source: diagnostic.source }),
  };
}

/**
 * Why a document produced no compile-stage diagnostics beyond syntax.
 *
 * `unit-form` is load-bearing: `compileSource` calls `parseLegacy`, which
 * **throws** a `ParseError` on a generic `unit Name : Type { … }` declaration
 * (`packages/parser/src/index.ts`). An editor may not throw on a valid
 * declaration, so the LSP checks what it can and records that the legacy
 * structural stages do not apply — rather than inventing diagnostics the CLI
 * would never produce.
 */
export type CompileStageOutcome =
  | { readonly kind: "ran"; readonly abortedAt?: "syntax" | "structure" | "resolve" }
  | { readonly kind: "not-applicable"; readonly reason: "unit-form" };

export interface CompileStageResult {
  readonly diagnostics: readonly LspDiagnostic[];
  readonly outcome: CompileStageOutcome;
}

/**
 * Run the compile-stage checks over an already-parsed document.
 *
 * Mirrors `compileSource`'s markdown-emit path exactly:
 *   parse errors → abort; L1 errors → abort; resolver errors → append and abort;
 *   otherwise the L1 warnings/suggestions are the whole set.
 */
export function compileStageDiagnostics(parsed: ParsedDocument): CompileStageResult {
  const { document, ast, errors } = parsed;

  // ── Parse ──────────────────────────────────────────────────────────────
  if (errors.length > 0) {
    // `source: "L1:structure"` is what the compiler tags syntax errors with; the
    // tag is copied rather than corrected so the two sets compare equal.
    const diagnostics = errors.map(error =>
      fromCompilerDiagnostic({ level: "error", line: error.line ?? 0, message: error.message, ...(error.suggestion ? { suggestion: error.suggestion } : {}), source: "L1:structure" }, document, "syntax")
    );
    return { diagnostics, outcome: { kind: "ran", abortedAt: "syntax" } };
  }

  if (ast.type === "UnitDeclaration") {
    return { diagnostics: [], outcome: { kind: "not-applicable", reason: "unit-form" } };
  }
  const legacy: LegacySyntaxAST = ast;

  // ── Check ──────────────────────────────────────────────────────────────
  // Same discovery function as the CLI, so cross-atom reference checks see the
  // same neighbour set. Its search order is load-bearing (first match wins).
  const installedPrimes = discoverInstalledPrimes(documentPath(document.uri));
  const structural = checkL1(legacy, installedPrimes);
  const structuralDiagnostics = structural.map(entry => fromCompilerDiagnostic(entry, document, "structure"));
  if (structural.some(entry => entry.level === "error")) {
    return { diagnostics: structuralDiagnostics, outcome: { kind: "ran", abortedAt: "structure" } };
  }

  // ── Resolve ────────────────────────────────────────────────────────────
  const { diagnostics: resolverDiagnostics } = resolve(legacy, installedPrimes);
  const resolverErrors = resolverDiagnostics.filter(entry => entry.level === "error");
  if (resolverErrors.length > 0) {
    return {
      diagnostics: [...structuralDiagnostics, ...resolverDiagnostics.map(entry => fromCompilerDiagnostic(entry, document, "resolve"))],
      outcome: { kind: "ran", abortedAt: "resolve" },
    };
  }

  // `compileSource` drops non-error resolver diagnostics on its success path
  // (it returns `diagnostics`, not `[...diagnostics, ...resolverDiagnostics]`).
  // Today `resolve` only ever pushes `level: "error"`, so the two sets are still
  // equal; this comment records the coupling so a future resolver warning does
  // not silently break parity here.
  return { diagnostics: structuralDiagnostics, outcome: { kind: "ran" } };
}
