/**
 * @module @skill-wiki/language-server
 * Prime Language Server (plan §14).
 *
 * ## Boundary
 *
 * ADR-8 and §18.5: **LSP is Toolchain.** It reuses Parser, Model Resolver and
 * Checker, and it does not compile a production bundle — nothing here writes an
 * artifact, and nothing here imports the compiler's emitter or `compileSource`.
 * That boundary is asserted, not just documented: see `test/boundary.test.ts`.
 *
 * ## Capabilities in this version (§14.1, first four)
 *
 * 1. Incremental document store — `openDocument` / `changeDocument` (range edits,
 *    version-checked) with parse memoised per version.
 * 2. Syntax diagnostics — from `@skill-wiki/parser`.
 * 3. External model/schema diagnostics — from a Model Package loaded through
 *    `@skill-wiki/model-schema`; unknown type, unknown field, missing required field.
 * 4. Type/field completion — both lists come from that Model Package.
 *
 * The remaining §14.1 items (hover, go-to-definition, relation navigation,
 * rename, code actions, workspace symbols) are not implemented in this version.
 *
 * ## Diagnostic parity with the CLI (§16 Phase 5)
 *
 * `diagnostics(uri).compile` runs the same stages in the same order with the same
 * abort points as `compileSource`, and equals the CLI's diagnostic set for the
 * same source. Model findings are returned separately in `.model` because the
 * CLI's markdown path loads no Model Package; folding them together would make
 * the parity claim false. `test/parity.test.ts` asserts the equality against a
 * real `compileSource` run.
 *
 * @example
 * ```typescript
 * const server = createLanguageServer({ modelRoot: "/path/to/model" });
 * server.openDocument("file:///tmp/a.prime", source);
 * const { compile, model } = server.diagnostics("file:///tmp/a.prime");
 * const items = server.completion("file:///tmp/a.prime", { line: 1, character: 2 }).items;
 * ```
 */

import { DocumentStore, documentFilename, documentPath, StaleVersionError, UnknownDocumentError, type ParsedDocument } from "./document-store";
import { asCompilerDiagnostic, compileStageDiagnostics, fromCompilerDiagnostic, type CompileStageOutcome, type CompileStageResult, type DiagnosticSeverity, type DiagnosticStage, type LspDiagnostic } from "./diagnostics";
import { completionAt, completionContext, prefixAt, type CompletionContext, type CompletionItem, type CompletionItemKind, type CompletionResult } from "./completion";
import { loadModelState, ModelIndex, type FieldInfo, type ModelState } from "./model-index";
import { modelDiagnostics, type ModelCheckOutcome, type ModelCheckResult } from "./model-diagnostics";
import { PositionError, TextDocument, type ContentChange, type Position, type Range } from "./text-document";

export {
  DocumentStore,
  ModelIndex,
  PositionError,
  StaleVersionError,
  TextDocument,
  UnknownDocumentError,
  asCompilerDiagnostic,
  completionAt,
  completionContext,
  compileStageDiagnostics,
  documentFilename,
  documentPath,
  fromCompilerDiagnostic,
  loadModelState,
  modelDiagnostics,
  prefixAt,
};
export type {
  CompileStageOutcome,
  CompileStageResult,
  CompletionContext,
  CompletionItem,
  CompletionItemKind,
  CompletionResult,
  ContentChange,
  DiagnosticSeverity,
  DiagnosticStage,
  FieldInfo,
  LspDiagnostic,
  ModelCheckOutcome,
  ModelCheckResult,
  ModelState,
  ParsedDocument,
  Position,
  Range,
};

export interface LanguageServerOptions {
  /**
   * Directory of the Model Package to check documents against.
   *
   * Absent means no model is configured: syntax diagnostics still work, model
   * diagnostics are reported as skipped, and completion is empty rather than
   * guessed from built-in names.
   */
  readonly modelRoot?: string;
}

export interface DocumentDiagnostics {
  /** The set that must equal the CLI's. */
  readonly compile: readonly LspDiagnostic[];
  /** Model/schema findings, LSP-only. */
  readonly model: readonly LspDiagnostic[];
  /** Everything a client should display, `compile` first. */
  readonly all: readonly LspDiagnostic[];
  readonly compileOutcome: CompileStageOutcome;
  readonly modelOutcome: ModelCheckOutcome;
}

export interface LanguageServer {
  readonly documents: DocumentStore;
  readonly model: ModelState;
  openDocument(uri: string, text: string, version?: number): TextDocument;
  changeDocument(uri: string, changes: readonly ContentChange[], version: number): TextDocument;
  closeDocument(uri: string): void;
  diagnostics(uri: string): DocumentDiagnostics;
  completion(uri: string, position: Position): CompletionResult;
  /** Re-read the Model Package, e.g. after the model files change on disk. */
  reloadModel(): ModelState;
}

export function createLanguageServer(options: LanguageServerOptions = {}): LanguageServer {
  const documents = new DocumentStore();
  let model = loadModelState(options.modelRoot);

  const parsedOf = (uri: string): ParsedDocument => documents.parsed(uri);

  return {
    documents,
    get model(): ModelState {
      return model;
    },
    openDocument(uri, text, version = 1) {
      return documents.open(uri, text, version);
    },
    changeDocument(uri, changes, version) {
      return documents.update(uri, changes, version);
    },
    closeDocument(uri) {
      documents.close(uri);
    },
    diagnostics(uri) {
      const parsed = parsedOf(uri);
      const compile = compileStageDiagnostics(parsed);
      const modelResult = modelDiagnostics(parsed.ast, parsed.errors.length > 0, parsed.document, model);
      return {
        compile: compile.diagnostics,
        model: modelResult.diagnostics,
        all: [...compile.diagnostics, ...modelResult.diagnostics],
        compileOutcome: compile.outcome,
        modelOutcome: modelResult.outcome,
      };
    },
    completion(uri, position) {
      const parsed = parsedOf(uri);
      return completionAt(parsed.document, position, model, parsed.errors.length > 0 ? undefined : parsed.ast);
    },
    reloadModel() {
      model = loadModelState(options.modelRoot);
      return model;
    },
  };
}
