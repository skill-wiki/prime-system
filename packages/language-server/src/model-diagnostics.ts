/**
 * @module model-diagnostics
 * §14.1 third capability: 外部 model/schema diagnostics.
 *
 * These are deliberately a **separate set** from the compile-stage diagnostics.
 * `compileSource`'s default (markdown) path never loads a Model Package —
 * it resolves the v1 compat model only on its `atom-dir` path — so folding model
 * findings into the compile-stage set would break the Phase 5 parity assertion
 * by construction. Callers get both lists and the `stage` tag distinguishes them.
 */

import type { AtomDeclaration, FieldNode, SyntaxAST, UnitDeclaration } from "@aoe/types";
import type { TypeDefinition } from "@aoe/model-schema";
import type { LspDiagnostic } from "./diagnostics";
import type { ModelIndex, ModelState } from "./model-index";
import type { TextDocument } from "./text-document";

/** Why a document's declaration could not be checked against the model. */
export type ModelCheckOutcome =
  | { readonly kind: "checked"; readonly typeName: string }
  | { readonly kind: "skipped"; readonly reason: "no-model" | "invalid-model" | "legacy-extends-form" | "syntax-errors" };

export interface ModelCheckResult {
  readonly diagnostics: readonly LspDiagnostic[];
  readonly outcome: ModelCheckOutcome;
}

function diagnostic(code: string, message: string, document: TextDocument, line: number, suggestion?: string): LspDiagnostic {
  return {
    severity: "error",
    range: document.rangeOfSourceLine(line),
    message,
    source: "model",
    stage: "model",
    code,
    ...(suggestion === undefined ? {} : { suggestion }),
  };
}

/** The type reference a declaration names, when the syntax carries one. */
function declaredTypeRef(ast: SyntaxAST): { readonly reference: string; readonly node: AtomDeclaration | UnitDeclaration } | undefined {
  if (ast.type === "AtomDeclaration") return { reference: ast.kind, node: ast };
  if (ast.type === "UnitDeclaration") return { reference: ast.typeRef.name, node: ast };
  // A legacy `prime X extends Base` declaration names an inheritance base, not a
  // model type. Mapping `extends` onto a TypeDefinition would be the engine
  // guessing at domain semantics, so it is reported as skipped instead.
  return undefined;
}

function checkFields(body: readonly FieldNode[], type: TypeDefinition, index: ModelIndex, document: TextDocument, declarationLine: number): readonly LspDiagnostic[] {
  const declared = new Map(index.fieldsOf(type).map(field => [field.name, field]));
  const diagnostics: LspDiagnostic[] = [];

  if (type.additionalFields === "reject") {
    for (const field of body) {
      if (declared.has(field.key)) continue;
      const known = [...declared.keys()].sort().join(", ");
      diagnostics.push(
        diagnostic("UNKNOWN_FIELD", `Type "${type.name}" does not declare a field "${field.key}" and rejects additional fields`, document, field.loc.line, known === "" ? undefined : `Declared fields: ${known}`)
      );
    }
  }

  const present = new Set(body.map(field => field.key));
  for (const field of index.fieldsOf(type)) {
    if (!field.required || present.has(field.name)) continue;
    diagnostics.push(diagnostic("MISSING_REQUIRED_FIELD", `Type "${type.name}" requires a field "${field.name}"`, document, declarationLine, `Add ${field.name}: <${field.typeRef}>`));
  }

  return diagnostics;
}

/**
 * Check a document's declaration against the loaded Model Package.
 *
 * A document with syntax errors is not checked: the AST after a parse error is a
 * partial recovery, and reporting missing required fields on it would bury the
 * real error under noise.
 */
export function modelDiagnostics(ast: SyntaxAST, hasSyntaxErrors: boolean, document: TextDocument, state: ModelState): ModelCheckResult {
  if (state.kind === "none") return { diagnostics: [], outcome: { kind: "skipped", reason: "no-model" } };
  if (state.kind === "invalid") {
    // The model package itself is broken: report that once, at the document
    // start, rather than reporting every unit as having an unknown type.
    return {
      diagnostics: state.diagnostics.map(entry => diagnostic(entry.code, `Model package at ${state.root} is invalid: ${entry.message}${entry.definition === undefined ? "" : ` (${entry.definition})`}`, document, 0, entry.path)),
      outcome: { kind: "skipped", reason: "invalid-model" },
    };
  }
  if (hasSyntaxErrors) return { diagnostics: [], outcome: { kind: "skipped", reason: "syntax-errors" } };

  const declared = declaredTypeRef(ast);
  if (declared === undefined) return { diagnostics: [], outcome: { kind: "skipped", reason: "legacy-extends-form" } };

  const type = state.index.resolveType(declared.reference);
  if (type === undefined) {
    return {
      diagnostics: [
        diagnostic("UNKNOWN_TYPE", `Model "${state.index.modelName}" declares no type "${declared.reference}"`, document, declared.node.loc.line, `Declared types: ${state.index.typeNames.join(", ")}`),
      ],
      outcome: { kind: "checked", typeName: declared.reference },
    };
  }

  return {
    diagnostics: checkFields(declared.node.body, type, state.index, document, declared.node.loc.line),
    outcome: { kind: "checked", typeName: type.name },
  };
}
