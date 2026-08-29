/**
 * @module completion
 * §14.1 fourth capability: type/field completion.
 *
 * Both lists come from the loaded Model Package. There is no built-in list of
 * kinds and no built-in list of field names anywhere in this file — that is the
 * §3.1 invariant, and it is why completion is empty rather than guessed when no
 * model is configured.
 *
 * Cursor context is derived by re-using the parser's own `tokenize`, not by a
 * private regex scanner: comments and string literals have to be skipped exactly
 * the way the language defines them, and a second scanner would drift.
 */

import { tokenize, TokenType, type Token } from "@skill-wiki/parser";
import type { SyntaxAST } from "@skill-wiki/types";
import type { ModelIndex, ModelState } from "./model-index";
import type { Position, TextDocument } from "./text-document";

export type CompletionItemKind = "type" | "field";

export interface CompletionItem {
  readonly label: string;
  readonly kind: CompletionItemKind;
  readonly detail: string;
  readonly insertText: string;
  readonly documentation?: string;
}

/**
 * Where the cursor sits, as far as completion is concerned.
 *
 * `unsupported` is an explicit outcome, not an empty list: a cursor inside a
 * nested object literal has no type to complete fields from (the protocol has no
 * nested type refs — see the `types.yaml` header note in the compat model), and
 * offering the outer type's fields there would be wrong rather than incomplete.
 */
export type CompletionContext =
  | { readonly kind: "type-position" }
  | { readonly kind: "field-position"; readonly typeReference: string }
  | { readonly kind: "value-position" }
  | { readonly kind: "unsupported"; readonly reason: "nested-object" | "unknown-declaration" };

/**
 * Significant tokens before the cursor.
 *
 * No try/catch: `tokenize` in `packages/parser/src/lexer.ts` contains no `throw`
 * — it is total over any input, and an unterminated string mid-edit simply
 * yields a STRING token running to end of input. A defensive catch here would be
 * unreachable code with an untestable branch.
 */
function significantTokensBefore(text: string, offset: number, filename: string): readonly Token[] {
  return tokenize(text, filename).filter(
    token => token.offset < offset && token.type !== TokenType.NEWLINE && token.type !== TokenType.COMMENT && token.type !== TokenType.EOF
  );
}

/**
 * The type reference of the declaration a cursor is inside.
 *
 * Read off the token stream rather than the AST because the AST of a
 * half-written declaration may not exist yet, which is exactly when completion
 * is asked for.
 */
function enclosingTypeReference(tokens: readonly Token[]): string | undefined {
  // Scan for the innermost declaration header preceding the first unclosed `{`.
  let headerEnd = -1;
  let depth = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.type === TokenType.LBRACE) {
      if (depth === 0) headerEnd = index;
      depth += 1;
    } else if (token.type === TokenType.RBRACE) {
      depth = Math.max(0, depth - 1);
    }
  }
  if (headerEnd < 0) return undefined;

  // `unit Name : TypeRef {` → the token after the colon.
  // `<kind> Name {`         → the first token of the header.
  const header = tokens.slice(0, headerEnd);
  const unitIndex = header.findIndex(token => token.type === TokenType.UNIT);
  if (unitIndex >= 0) {
    const colon = header.findIndex((token, index) => index > unitIndex && token.type === TokenType.COLON);
    if (colon < 0) return undefined;
    const reference = header[colon + 1];
    return reference === undefined ? undefined : reference.value;
  }
  const first = header[0];
  if (first === undefined) return undefined;
  if (first.type === TokenType.PRIME) return undefined; // legacy form names a base, not a model type
  return first.value;
}

export function completionContext(document: TextDocument, position: Position): CompletionContext {
  const offset = document.offsetAt(position);
  const tokens = significantTokensBefore(document.text, offset, document.uri);

  let depth = 0;
  for (const token of tokens) {
    if (token.type === TokenType.LBRACE) depth += 1;
    else if (token.type === TokenType.RBRACE) depth = Math.max(0, depth - 1);
  }
  if (depth === 0) return { kind: "type-position" };
  if (depth > 1) return { kind: "unsupported", reason: "nested-object" };

  const last = tokens[tokens.length - 1];
  if (last !== undefined && last.type === TokenType.COLON) return { kind: "value-position" };
  // A cursor inside an unclosed string literal is in a value, not at a field
  // name. The lexer hands back one STRING token that runs to end of input in that
  // case, so the closing quote has to be looked for in the raw text.
  if (last !== undefined && last.type === TokenType.STRING && !/^"(?:[^"\\]|\\.)*"/.test(document.text.slice(last.offset, offset))) {
    return { kind: "value-position" };
  }

  const typeReference = enclosingTypeReference(tokens);
  if (typeReference === undefined) return { kind: "unsupported", reason: "unknown-declaration" };
  return { kind: "field-position", typeReference };
}

/** The partial word immediately before the cursor, used as the filter prefix. */
export function prefixAt(document: TextDocument, position: Position): string {
  const offset = document.offsetAt(position);
  const before = document.text.slice(0, offset);
  const match = /[A-Za-z0-9_-]+$/.exec(before);
  return match === null ? "" : match[0];
}

function typeItems(index: ModelIndex, prefix: string): readonly CompletionItem[] {
  return index.typeNames
    .filter(name => name.startsWith(prefix))
    .map(name => {
      const type = index.resolveType(name)!;
      const required = index.fieldsOf(type).filter(field => field.required).length;
      return {
        label: name,
        kind: "type" as const,
        detail: `${index.modelName} v${type.version}`,
        insertText: name,
        documentation: `${type.fields.length} declared field(s), ${required} required, additional fields: ${type.additionalFields}`,
      };
    });
}

function fieldItems(index: ModelIndex, typeReference: string, present: ReadonlySet<string>, prefix: string): readonly CompletionItem[] {
  const type = index.resolveType(typeReference);
  if (type === undefined) return [];
  return index
    .fieldsOf(type)
    .filter(field => field.name.startsWith(prefix) && !present.has(field.name))
    .map(field => ({
      label: field.name,
      kind: "field" as const,
      detail: `${field.typeRef}${field.required ? " (required)" : ""}`,
      insertText: `${field.name}: `,
      ...(field.description === undefined ? {} : { documentation: field.description }),
    }));
}

/** Field keys already written in the document's declaration, so they are not re-offered. */
function presentFieldKeys(ast: SyntaxAST | undefined): ReadonlySet<string> {
  if (ast === undefined) return new Set();
  return new Set(ast.body.map(field => field.key));
}

export interface CompletionResult {
  readonly items: readonly CompletionItem[];
  readonly context: CompletionContext;
}

export function completionAt(document: TextDocument, position: Position, state: ModelState, ast: SyntaxAST | undefined): CompletionResult {
  const context = completionContext(document, position);
  if (state.kind !== "loaded") return { items: [], context };
  const prefix = prefixAt(document, position);

  if (context.kind === "type-position") return { items: typeItems(state.index, prefix), context };
  if (context.kind === "field-position") return { items: fieldItems(state.index, context.typeReference, presentFieldKeys(ast), prefix), context };
  return { items: [], context };
}
